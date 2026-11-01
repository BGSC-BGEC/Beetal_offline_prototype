package expo.modules.betaal

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.*
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.net.wifi.ScanResult
import android.net.wifi.rtt.*
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import java.util.concurrent.atomic.AtomicBoolean

@SuppressLint("MissingPermission") // Optional permissions are requested from the setup screen.
class Indoor(private val ctx: Context, private val emit: (String, Map<String, Any>) -> Unit) {
  private val wifi get() = ctx.getSystemService(WifiManager::class.java)
  private var listener: SensorEventListener? = null
  private val handler = Handler(Looper.getMainLooper())

  fun capabilities(): Map<String, Any> {
    val sm = ctx.getSystemService(SensorManager::class.java)
    val rtt = Build.VERSION.SDK_INT >= 28 && ctx.packageManager.hasSystemFeature("android.hardware.wifi.rtt")
    val lm = ctx.getSystemService(LocationManager::class.java)
    return mapOf(
      "wifi" to (wifi != null), "wifiEnabled" to (wifi?.isWifiEnabled == true),
      "rtt" to rtt, "rttAvailable" to (rtt && ctx.getSystemService(WifiRttManager::class.java).isAvailable),
      "locationEnabled" to (if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)),
      "wifiPermission" to (ctx.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED &&
        (Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission("android.permission.NEARBY_WIFI_DEVICES") == PackageManager.PERMISSION_GRANTED)),
      "steps" to (sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR) != null),
      "stepPermission" to (Build.VERSION.SDK_INT < 29 || ctx.checkSelfPermission("android.permission.ACTIVITY_RECOGNITION") == PackageManager.PERMISSION_GRANTED),
      "barometer" to (sm.getDefaultSensor(Sensor.TYPE_PRESSURE) != null),
    )
  }

  fun start(): Map<String, Boolean> {
    stop()
    val sm = ctx.getSystemService(SensorManager::class.java)
    var lastPressure = 0L
    val l = object : SensorEventListener {
      override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
          Sensor.TYPE_PRESSURE -> {
            val now = SystemClock.elapsedRealtime()
            if (now - lastPressure >= 500) { lastPressure = now; emit("onPressure", mapOf("hpa" to e.values[0])) }
          }
          Sensor.TYPE_STEP_DETECTOR -> emit("onStep", mapOf("t" to SystemClock.elapsedRealtime()))
        }
      }
      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    val pressure = sm.getDefaultSensor(Sensor.TYPE_PRESSURE)?.let { sm.registerListener(l, it, SensorManager.SENSOR_DELAY_NORMAL) } ?: false
    val steps = try { sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR)?.let { sm.registerListener(l, it, SensorManager.SENSOR_DELAY_NORMAL) } ?: false }
      catch (_: SecurityException) { false }
    listener = l
    return mapOf("barometer" to pressure, "steps" to steps)
  }

  fun scan(): Boolean = wifi?.startScan() ?: false

  private fun responder(ap: ScanResult) = ap.is80211mcResponder || (Build.VERSION.SDK_INT >= 35 && ap.is80211azNtbResponder)

  fun readings(): List<Map<String, Any>> = wifi?.scanResults?.map {
    mapOf("bssid" to it.BSSID.lowercase(), "ssid" to it.SSID, "rssi" to it.level,
      "rtt" to responder(it),
      "t" to (System.currentTimeMillis() - (SystemClock.elapsedRealtime() - it.timestamp / 1000)))
  } ?: emptyList()

  fun range(ids: List<String>, promise: Promise) {
    if (Build.VERSION.SDK_INT < 28 || !ctx.packageManager.hasSystemFeature("android.hardware.wifi.rtt")) {
      promise.reject("RTT_UNAVAILABLE", "This phone does not support Wi-Fi RTT", null); return
    }
    val manager = ctx.getSystemService(WifiRttManager::class.java)
    if (!manager.isAvailable) { promise.reject("RTT_UNAVAILABLE", "Wi-Fi RTT is currently unavailable; check Wi-Fi and location settings", null); return }
    val settled = AtomicBoolean(false)
    lateinit var timeout: Runnable
    fun finish(error: String?, result: List<Map<String, Any>> = emptyList()) {
      if (!settled.compareAndSet(false, true)) return
      handler.removeCallbacks(timeout)
      if (error != null) promise.reject("RTT_FAILED", error, null) else promise.resolve(result)
    }
    timeout = Runnable { finish("Wi-Fi RTT timed out; no usable ranges received") }
    handler.postDelayed(timeout, 5000)
    try {
      val aps = wifi?.scanResults?.filter { it.BSSID.lowercase() in ids && responder(it) }?.take(RangingRequest.getMaxPeers()) ?: emptyList()
      if (aps.isEmpty()) { finish("No visible RTT-capable configured access points"); return }
      val request = RangingRequest.Builder().addAccessPoints(aps).build()
      manager.startRanging(request, ctx.mainExecutor, object : RangingResultCallback() {
        override fun onRangingFailure(code: Int) { finish("Wi-Fi RTT request failed ($code)") }
        override fun onRangingResults(results: List<RangingResult>) {
          finish(null, results.filter { it.status == RangingResult.STATUS_SUCCESS }.map {
            mapOf("bssid" to it.macAddress.toString().lowercase(), "d" to it.distanceMm / 1000.0,
              "error" to it.distanceStdDevMm / 1000.0)
          })
        }
      })
    } catch (e: Exception) { finish(e.message ?: "Wi-Fi ranging failed") }
  }

  fun stop() {
    listener?.let { ctx.getSystemService(SensorManager::class.java).unregisterListener(it) }
    listener = null
  }
}
