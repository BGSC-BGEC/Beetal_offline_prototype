package expo.modules.betaal

import android.content.Context
import android.media.*
import java.io.File
import java.nio.ByteOrder
import kotlin.math.*
import kotlin.random.Random

/**
 * Sound bank. Each kind loads `app/assets/audio/<kind>.<wav|mp3|ogg|m4a|...>` (bundled into the APK
 * as an Android asset). Missing files fall back to a synthesised placeholder, so the game always runs.
 * Everything is decoded once to mono float PCM at 44.1 kHz.
 */
object Sounds {
  const val SR = 44100
  private val cache = HashMap<String, FloatArray>()
  val KINDS = listOf(
    "bell", "scream", "whisper", "possessed_breathing", "win_players", "win_ghost", "win_divya",
    "hit", "miss", "deny", "ambient", "afterKillDrama",
  )

  /** Which kinds came from real files (for the debug screen). */
  val fromFile = HashSet<String>()

  fun get(ctx: Context, kind: String): FloatArray = synchronized(cache) {
    cache.getOrPut(kind) { load(ctx, kind)?.also { fromFile.add(kind) } ?: Synth.make(kind) }
  }

  private fun load(ctx: Context, kind: String): FloatArray? = try {
    val name = ctx.assets.list("")?.firstOrNull { it.substringBeforeLast('.') == kind && it.contains('.') }
    name?.let { trim(decode(ctx, it)) }
  } catch (e: Exception) {
    android.util.Log.w("Betaal", "could not load $kind: $e"); null
  }

  /** Cut leading/trailing near-silence (< -60 dBFS) so a sound starts the instant its event happens. */
  private fun trim(a: FloatArray): FloatArray {
    val start = a.indexOfFirst { abs(it) > 0.001f }
    if (start < 0) return a
    val end = a.indexOfLast { abs(it) > 0.001f }
    return a.copyOfRange(start, end + 1)
  }

  /** Decode any Android-supported audio asset to mono float @ 44.1 kHz. */
  private fun decode(ctx: Context, asset: String): FloatArray {
    // Copy to a cache file: works for compressed and uncompressed assets alike.
    val f = File(ctx.cacheDir, "snd_$asset")
    if (!f.exists()) ctx.assets.open(asset).use { i -> f.outputStream().use { i.copyTo(it) } }

    val ex = MediaExtractor().apply { setDataSource(f.path) }
    val track = (0 until ex.trackCount).first { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
    ex.selectTrack(track)
    val inFmt = ex.getTrackFormat(track)
    val codec = MediaCodec.createDecoderByType(inFmt.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(inFmt, null, null, 0)
    codec.start()

    var sr = inFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var ch = inFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    var isFloat = false
    val out = ArrayList<Float>(sr * 4)
    val info = MediaCodec.BufferInfo()
    var inDone = false
    while (true) {
      if (!inDone) {
        val ii = codec.dequeueInputBuffer(10_000)
        if (ii >= 0) {
          val n = ex.readSampleData(codec.getInputBuffer(ii)!!, 0)
          if (n < 0) { codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true }
          else { codec.queueInputBuffer(ii, 0, n, ex.sampleTime, 0); ex.advance() }
        }
      }
      val oi = codec.dequeueOutputBuffer(info, 10_000)
      if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        val f2 = codec.outputFormat
        sr = f2.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        ch = f2.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        isFloat = f2.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
          f2.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
      } else if (oi >= 0) {
        val buf = codec.getOutputBuffer(oi)!!.order(ByteOrder.nativeOrder())
        buf.position(info.offset); buf.limit(info.offset + info.size)
        if (isFloat) {
          val fb = buf.asFloatBuffer()
          while (fb.remaining() >= ch) { var s = 0f; repeat(ch) { s += fb.get() }; out.add(s / ch) }
        } else {
          val sb = buf.asShortBuffer()
          while (sb.remaining() >= ch) { var s = 0f; repeat(ch) { s += sb.get() / 32768f }; out.add(s / ch) }
        }
        codec.releaseOutputBuffer(oi, false)
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
      }
    }
    codec.stop(); codec.release(); ex.release()

    val mono = out.toFloatArray()
    if (sr == SR) return mono
    // linear resample to 44.1 kHz
    val n = (mono.size.toLong() * SR / sr).toInt()
    return FloatArray(n) { i ->
      val x = i.toDouble() * sr / SR
      val j = x.toInt().coerceAtMost(mono.size - 2)
      val t = (x - j).toFloat()
      mono[j] * (1 - t) + mono[j + 1] * t
    }
  }
}

/** Placeholder sounds so the prototype runs before real audio is delivered. */
object Synth {
  private const val SR = Sounds.SR
  private fun buf(seconds: Double) = FloatArray((seconds * SR).toInt())

  fun make(kind: String): FloatArray = when (kind) {
    "bell" -> bell(150.0, 4.0)
    "win_ghost" -> bell(80.0, 6.0)
    "scream" -> scream()
    "win_players" -> shatter()
    "win_divya" -> arpeggio()
    "whisper" -> whisper(15.0)
    "possessed_breathing" -> breathing()
    "miss" -> swoosh()
    "deny" -> beeps()
    "hit" -> thud()
    else -> FloatArray(0) // e.g. ambient: silent unless provided
  }

  /** Temple bell: inharmonic partials with independent exponential decays, slight beating. */
  private fun bell(f0: Double, len: Double): FloatArray {
    val out = buf(len)
    val ratios = doubleArrayOf(1.0, 1.01, 2.0, 2.76, 4.07, 5.4)
    val amps = doubleArrayOf(0.5, 0.4, 0.5, 0.35, 0.2, 0.12)
    val decays = doubleArrayOf(3.5, 3.5, 2.5, 1.8, 1.2, 0.8).map { it * len / 4.0 }
    for (i in out.indices) {
      val t = i.toDouble() / SR
      var s = 0.0
      for (k in ratios.indices) s += amps[k] * exp(-t / decays[k]) * sin(2 * PI * f0 * ratios[k] * t)
      out[i] = (min(1.0, t / 0.005) * s * 0.5).toFloat()
    }
    return out
  }

  private fun scream(): FloatArray {
    val out = buf(2.0)
    var phase = 0.0; var lp = 0.0; var hp = 0.0; var prev = 0.0
    for (i in out.indices) {
      val t = i.toDouble() / SR
      val glide = if (t < 0.4) 700 + 1000 * t else 1100 - 250 * (t - 0.4)
      phase = (phase + (glide + 40 * sin(2 * PI * 6 * t)) / SR) % 1.0
      val x = (2 * phase - 1) * 0.7 + (Random.nextDouble() * 2 - 1) * 0.3
      lp += 0.35 * (x - lp); hp = 0.97 * (hp + lp - prev); prev = lp
      val env = min(1.0, t / 0.03) * if (t > 1.2) max(0.0, 1 - (t - 1.2) / 0.8) else 1.0
      out[i] = (hp * env * 0.8).toFloat()
    }
    return out
  }

  private fun shatter(): FloatArray {
    val out = buf(2.0)
    val rnd = Random(7)
    repeat(14) {
      val start = (rnd.nextDouble() * 1.2 * SR).toInt()
      val f = 2000 + rnd.nextDouble() * 3000
      for (j in 0 until SR / 2) {
        val i = start + j; if (i >= out.size) break
        val t = j.toDouble() / SR
        out[i] += (0.15 * exp(-t / 0.08) * sin(2 * PI * f * t)).toFloat()
      }
    }
    return out
  }

  private fun arpeggio(): FloatArray {
    val out = buf(3.5)
    doubleArrayOf(261.6, 329.6, 392.0, 523.3, 659.3).forEachIndexed { n, f ->
      val start = (n * 0.3 * SR).toInt()
      for (i in start until out.size) {
        val t = (i - start).toDouble() / SR
        var s = 0.0
        for (h in 1..7 step 2) s += sin(2 * PI * f * h * t) / h
        out[i] += (0.12 * min(1.0, t / 0.05) * exp(-t / 2.0) * s).toFloat()
      }
    }
    return out
  }

  private fun whisper(len: Double): FloatArray {
    val out = buf(len)
    var lp = 0.0; var hp = 0.0; var prev = 0.0
    for (i in out.indices) {
      val t = i.toDouble() / SR
      lp += 0.5 * ((Random.nextDouble() * 2 - 1) - lp); hp = 0.9 * (hp + lp - prev); prev = lp
      val swell = 0.05 + 0.95 * (t / len).pow(2)
      val trem = 0.6 + 0.4 * sin(2 * PI * (3 + 2 * t / len) * t)
      out[i] = (hp * swell * trem * 0.6).toFloat()
    }
    return out
  }

  /** Slow heavy breathing: band-limited noise, inhale/exhale envelope, loops seamlessly (period = length). */
  private fun breathing(): FloatArray {
    val len = 6.4
    val out = buf(len)
    var lp = 0.0; var lp2 = 0.0
    for (i in out.indices) {
      val t = i.toDouble() / SR
      val x = Random.nextDouble() * 2 - 1
      lp += 0.08 * (x - lp); lp2 += 0.08 * (lp - lp2)
      val ph = (t % 3.2) / 3.2 // one breath = 3.2 s
      val env = if (ph < 0.4) sin(PI * ph / 0.4).pow(2) * 0.7 else sin(PI * (ph - 0.4) / 0.6).pow(2)
      out[i] = (lp2 * env * 3.0).toFloat()
    }
    return out
  }

  private fun swoosh(): FloatArray {
    val out = buf(0.35)
    var lp = 0.0
    for (i in out.indices) {
      val t = i.toDouble() / SR
      lp += (0.05 + 0.6 * t / 0.35) * ((Random.nextDouble() * 2 - 1) - lp)
      out[i] = (lp * sin(PI * t / 0.35) * 0.7).toFloat()
    }
    return out
  }

  private fun beeps(): FloatArray {
    val out = buf(0.3)
    for (i in out.indices) {
      val t = i.toDouble() / SR
      out[i] = if (t < 0.08 || (t > 0.16 && t < 0.24)) (0.3 * sin(2 * PI * 220 * t)).toFloat() else 0f
    }
    return out
  }

  private fun thud(): FloatArray {
    val out = buf(0.25)
    for (i in out.indices) {
      val t = i.toDouble() / SR
      out[i] = (0.8 * exp(-t / 0.06) * sin(2 * PI * (90 - 40 * t / 0.25) * t)).toFloat()
    }
    return out
  }
}

/**
 * One playing sound. Streams mono PCM through: 2-pole low-pass -> equal-power pan -> gain.
 * Params are set from JS (~30 Hz) and smoothed per sample to avoid zipper noise. Optional loop.
 */
class Voice(private val pcm: FloatArray, private val loop: Boolean, private val onEnd: () -> Unit) {
  @Volatile var gain = 1f
  @Volatile var pan = 0f
  @Volatile var cutoffHz = 20000f
  @Volatile private var running = true

  private val block = 512
  private val track = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_GAME)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
    .setAudioFormat(AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
      .setSampleRate(Sounds.SR)
      .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
    .setBufferSizeInBytes(block * 2 * 4 * 4)
    .setTransferMode(AudioTrack.MODE_STREAM)
    .build()

  fun start() = Thread {
    if (pcm.isEmpty()) { onEnd(); return@Thread }
    track.play()
    val out = FloatArray(block * 2)
    var g = 0f; var l = 0.0; var r = 0.0
    var y1 = 0.0; var y2 = 0.0
    var pos = 0
    while (running && (loop || pos < pcm.size)) {
      val a = 1 - exp(-2 * PI * cutoffHz / Sounds.SR)
      val theta = (pan + 1) * PI / 4
      val tl = cos(theta); val tr = sin(theta)
      for (i in 0 until block) {
        val x = if (pos < pcm.size) pcm[pos] else 0f
        pos++
        if (loop && pos >= pcm.size) pos = 0
        g += (gain - g) * 0.01f; l += (tl - l) * 0.01; r += (tr - r) * 0.01
        y1 += a * (x - y1); y2 += a * (y1 - y2)
        out[2 * i] = (y2 * l * g).toFloat()
        out[2 * i + 1] = (y2 * r * g).toFloat()
      }
      track.write(out, 0, block * 2, AudioTrack.WRITE_BLOCKING)
    }
    track.stop(); track.release()
    onEnd()
  }.start()

  fun stop() { running = false }
}
