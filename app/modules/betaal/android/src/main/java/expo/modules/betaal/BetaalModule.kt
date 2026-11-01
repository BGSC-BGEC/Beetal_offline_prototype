package expo.modules.betaal

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.*
import android.os.ParcelUuid
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.WindowManager
import androidx.core.uwb.*
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.catch
import java.security.SecureRandom
import java.util.UUID

private val SERVICE = ParcelUuid(UUID.fromString("6b1e7a1d-0b7a-4e55-9e7a-be7aa1000001"))

@SuppressLint("MissingPermission") // JS requests permissions before calling start*()
class BetaalModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("no context")
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  // ---- sensors ----
  private var sensorListener: SensorEventListener? = null
  private var lastRot = 0L

  // ---- BLE ----
  private var scanCb: ScanCallback? = null
  private var advCb: AdvertiseCallback? = null

  // ---- UWB ----
  private val uwb by lazy { UwbManager.createInstance(ctx) }
  private val controlees = HashMap<String, UwbControleeSessionScope>() // peer -> prepared scope
  private val sessions = HashMap<String, Job>()

  // ---- audio ----
  private val voices = HashMap<Int, Voice>()

  override fun definition() = ModuleDefinition {
    Name("Betaal")
    Events("onRotation", "onAccel", "onRssi", "onUwb", "onUwbEnd", "onSoundEnd")

    OnDestroy { stopAll() }

    // ---------- device ----------
    Function("hasUwb") { ctx.packageManager.hasSystemFeature("android.hardware.uwb") }

    Function("declination") { lat: Double, lon: Double ->
      GeomagneticField(lat.toFloat(), lon.toFloat(), 0f, System.currentTimeMillis()).declination.toDouble()
    }

    Function("vibrate") { pattern: List<Double> ->
      val v = ctx.getSystemService(Vibrator::class.java)
      v.vibrate(VibrationEffect.createWaveform(pattern.map { it.toLong() }.toLongArray(), -1))
    }

    Function("keepAwake") { on: Boolean ->
      appContext.currentActivity?.let { act ->
        act.runOnUiThread {
          if (on) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
      Unit
    }

    // ---------- sensors: rotation vector (30 Hz to JS) + linear acceleration (~60 Hz) ----------
    Function("startSensors") {
      if (sensorListener != null) return@Function Unit
      val sm = ctx.getSystemService(SensorManager::class.java)
      val q = FloatArray(4)
      val l = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
          when (e.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> {
              val now = System.currentTimeMillis()
              if (now - lastRot < 33) return
              lastRot = now
              SensorManager.getQuaternionFromVector(q, e.values) // q = w,x,y,z
              sendEvent("onRotation", mapOf("w" to q[0], "x" to q[1], "y" to q[2], "z" to q[3], "acc" to e.accuracy))
            }
            Sensor.TYPE_LINEAR_ACCELERATION ->
              sendEvent("onAccel", mapOf("x" to e.values[0], "y" to e.values[1], "z" to e.values[2], "t" to System.currentTimeMillis()))
          }
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
      }
      sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let { sm.registerListener(l, it, SensorManager.SENSOR_DELAY_GAME) }
      sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)?.let { sm.registerListener(l, it, 16_666) }
      sensorListener = l
    }

    Function("stopSensors") { stopSensors() }

    // ---------- BLE: advertise [roomHash(2), idx(1)] and scan for the same room ----------
    Function("startBle") { roomHash: Int, idx: Int ->
      stopBle()
      val adapter = ctx.getSystemService(BluetoothManager::class.java).adapter
      val advertiser = adapter.bluetoothLeAdvertiser ?: throw IllegalStateException("Bluetooth is off")
      val scanner = adapter.bluetoothLeScanner ?: throw IllegalStateException("Bluetooth is off")
      val payload = byteArrayOf((roomHash shr 8).toByte(), roomHash.toByte(), idx.toByte())

      val adv = object : AdvertiseCallback() {}
      advertiser.startAdvertising(
        AdvertiseSettings.Builder()
          .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
          .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
          .setConnectable(false).build(),
        AdvertiseData.Builder().setIncludeDeviceName(false).addServiceData(SERVICE, payload).build(),
        adv,
      )
      advCb = adv

      val scan = object : ScanCallback() {
        override fun onScanResult(type: Int, r: ScanResult) {
          val d = r.scanRecord?.getServiceData(SERVICE) ?: return
          if (d.size < 3) return
          sendEvent("onRssi", mapOf("idx" to (d[2].toInt() and 0xFF), "rssi" to r.rssi, "t" to System.currentTimeMillis()))
        }
      }
      // Filter on our service data with the room hash as a masked prefix -> only this room's phones.
      val filter = ScanFilter.Builder()
        .setServiceData(SERVICE, byteArrayOf(payload[0], payload[1], 0), byteArrayOf(-1, -1, 0)).build()
      scanner.startScan(
        listOf(filter),
        ScanSettings.Builder()
          .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
          .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
          .setReportDelay(0).build(),
        scan,
      )
      scanCb = scan
    }

    Function("stopBle") { stopBle() }

    // ---------- UWB (unicast DS-TWR, one session per pair; lower player idx = controller) ----------
    // 1. controlee: uwbControleeAddress(peer) -> address, sent to controller via server
    AsyncFunction("uwbControleeAddress") Coroutine { peer: String ->
      val s = uwb.controleeSessionScope()
      controlees[peer] = s
      return@Coroutine s.localAddress.toString()
    }

    // 2. controller: uwbControllerStart(peer, controleeAddr) -> params, sent back via server
    AsyncFunction("uwbControllerStart") Coroutine { peer: String, controleeAddr: String ->
      val s = uwb.controllerSessionScope()
      val key = ByteArray(8).also { SecureRandom().nextBytes(it) }
      val sessionId = SecureRandom().nextInt(Int.MAX_VALUE)
      val ch = s.uwbComplexChannel
      range(peer, s, sessionId, key, ch, controleeAddr)
      return@Coroutine mapOf(
        "addr" to s.localAddress.toString(), "sessionId" to sessionId,
        "key" to key.joinToString(":") { "%02X".format(it) },
        "channel" to ch.channel, "preamble" to ch.preambleIndex,
      )
    }

    // 3. controlee: uwbControleeStart(peer, params from controller)
    Function("uwbControleeStart") { peer: String, p: Map<String, Any> ->
      val s = controlees.remove(peer) ?: return@Function false
      val key = (p["key"] as String).split(":").map { it.toInt(16).toByte() }.toByteArray()
      val ch = UwbComplexChannel((p["channel"] as Number).toInt(), (p["preamble"] as Number).toInt())
      range(peer, s, (p["sessionId"] as Number).toInt(), key, ch, p["addr"] as String)
      true
    }

    Function("uwbStop") { peer: String ->
      sessions.remove(peer)?.cancel()
      controlees.remove(peer)
    }

    // ---------- audio ----------
    Function("play") { id: Int, kind: String, gain: Double, pan: Double, cutoffHz: Double, loop: Boolean ->
      voices.remove(id)?.stop()
      val v = Voice(Sounds.get(ctx, kind), loop) {
        voices.remove(id)
        sendEvent("onSoundEnd", mapOf("id" to id))
      }
      v.gain = gain.toFloat(); v.pan = pan.toFloat(); v.cutoffHz = cutoffHz.toFloat()
      voices[id] = v
      v.start()
    }

    Function("setParams") { id: Int, gain: Double, pan: Double, cutoffHz: Double ->
      voices[id]?.apply { this.gain = gain.toFloat(); this.pan = pan.toFloat(); this.cutoffHz = cutoffHz.toFloat() }
    }

    Function("stopSound") { id: Int -> voices.remove(id)?.stop() }

    // Decode/synthesise every sound up front so the first bell has no delay. Returns kinds loaded from files.
    AsyncFunction("warmup") Coroutine { ->
      Sounds.KINDS.forEach { Sounds.get(ctx, it) }
      return@Coroutine Sounds.fromFile.toList()
    }
  }

  private fun range(peer: String, s: UwbClientSessionScope, sessionId: Int, key: ByteArray, ch: UwbComplexChannel, peerAddr: String) {
    sessions.remove(peer)?.cancel()
    val params = RangingParameters(
      uwbConfigType = RangingParameters.CONFIG_UNICAST_DS_TWR,
      sessionId = sessionId, subSessionId = 0,
      sessionKeyInfo = key, subSessionKeyInfo = null,
      complexChannel = ch,
      peerDevices = listOf(UwbDevice.createForAddress(peerAddr)),
      updateRateType = RangingParameters.RANGING_UPDATE_RATE_FREQUENT,
    )
    sessions[peer] = scope.launch {
      s.prepareSession(params)
        .catch { e -> sendEvent("onUwbEnd", mapOf("peer" to peer, "reason" to (e.message ?: "error"))) }
        .collect { r ->
          when (r) {
            is RangingResult.RangingResultPosition -> sendEvent("onUwb", mapOf(
              "peer" to peer, "d" to r.position.distance?.value, "az" to r.position.azimuth?.value,
              "t" to System.currentTimeMillis()))
            is RangingResult.RangingResultPeerDisconnected -> sendEvent("onUwbEnd", mapOf("peer" to peer, "reason" to "disconnected"))
            is RangingResult.RangingResultFailure -> sendEvent("onUwbEnd", mapOf("peer" to peer, "reason" to "failure ${r.reason}"))
            else -> {}
          }
        }
    }
  }

  private fun stopSensors() {
    sensorListener?.let { ctx.getSystemService(SensorManager::class.java).unregisterListener(it) }
    sensorListener = null
  }

  private fun stopBle() {
    val adapter = appContext.reactContext?.getSystemService(BluetoothManager::class.java)?.adapter ?: return
    scanCb?.let { adapter.bluetoothLeScanner?.stopScan(it) }
    advCb?.let { adapter.bluetoothLeAdvertiser?.stopAdvertising(it) }
    scanCb = null; advCb = null
  }

  private fun stopAll() {
    stopSensors(); stopBle()
    sessions.values.forEach { it.cancel() }; sessions.clear()
    voices.values.forEach { it.stop() }; voices.clear()
    scope.cancel()
  }
}
