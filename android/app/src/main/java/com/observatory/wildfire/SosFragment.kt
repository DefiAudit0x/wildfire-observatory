package com.observatory.wildfire

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import java.io.File

/**
 * v2.0.0 — نداء الاستغاثة. The trapped-person flow, fully native:
 *  - profile (name/phone) lives in prefs, travels with every SOS;
 *  - a cancelable 3-second countdown prevents pocket triggers;
 *  - the LAST KNOWN fix is sent even if stale, and the card SAYS its age —
 *    honesty beats a silent null (the v1.0.4 lesson);
 *  - an optional ≤20s voice note (MediaRecorder AAC) rides along, mic
 *    permission requested lazily on first use;
 *  - submission is triple-path: API when online, mesh echo always, offline
 *    queue replay otherwise (server dedups by deviceId recency anyway).
 */
class SosFragment : Fragment() {

    companion object {
        private const val COUNTDOWN_SECONDS = 3
        private const val MAX_RECORD_MS = 20_000L
        private const val MIC_REQUEST_CODE = 2002

        /**
         * A trapped person with no fix should NOT have their SOS silently
         * geolocated to (0,0) — the server's north-Africa geofence would 400
         * it anyway. The honest fallback is ALGIERS, and the payload carries
         * an explicit "بدون تحديد GPS" marker so dispatchers never treat it
         * as a measured position.
         */
        private const val DEFAULT_FALLBACK_LAT = 36.7538
        private const val DEFAULT_FALLBACK_LNG = 3.0588
    }

    private val app get() = requireActivity().application as ObservatoryApp

    private var nameInput: EditText? = null
    private var phoneInput: EditText? = null
    private var messageInput: EditText? = null
    private var locationLine: TextView? = null
    private var recordButton: View? = null
    private var recordState: TextView? = null
    private var sosButton: View? = null
    private var countdownOverlay: View? = null
    private var countdownText: TextView? = null
    private var resultCard: TextView? = null
    private var sendingProgress: View? = null

    private val handler = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var recording = false
    private var recordStartMs = 0L
    private var recordFile: File? = null
    private var countdownRunnable: Runnable? = null
    private var maxDurationRunnable: Runnable? = null

    // F2: the engine is application-scoped; a lambda registered inline in
    // onViewCreated would outlive this view and leak it on every tab switch.
    // One named listener, registered on view-ready, removed on view-gone.
    private val locationListener: (LocationEngine.State) -> Unit = { state ->
        activity?.runOnUiThread { renderLocation(state) }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_sos, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val prefs = requireContext().getSharedPreferences("observatory_profile", Context.MODE_PRIVATE)
        nameInput = view.findViewById<EditText>(R.id.sos_name)?.apply {
            setText(prefs.getString("name", ""))
        }
        phoneInput = view.findViewById<EditText>(R.id.sos_phone)?.apply {
            setText(prefs.getString("phone", ""))
        }
        messageInput = view.findViewById(R.id.sos_message)
        locationLine = view.findViewById(R.id.sos_location)
        recordButton = view.findViewById(R.id.sos_record)
        recordState = view.findViewById(R.id.sos_record_state)
        sosButton = view.findViewById(R.id.sos_button)
        countdownOverlay = view.findViewById(R.id.sos_countdown_overlay)
        countdownText = view.findViewById(R.id.sos_countdown_text)
        resultCard = view.findViewById(R.id.sos_result)
        sendingProgress = view.findViewById(R.id.sos_sending)

        recordButton?.setOnClickListener { toggleRecording() }
        sosButton?.setOnClickListener { startCountdown() }
        view.findViewById<View>(R.id.sos_cancel)?.setOnClickListener { cancelCountdown() }

        app.locationEngine.addListener(locationListener)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap ->
                    sendingProgress?.visibility = if (snap.sos.sending) View.VISIBLE else View.GONE
                    sosButton?.isEnabled = !snap.sos.sending
                }
            }
        }
    }

    private fun renderLocation(state: LocationEngine.State) {
        val fix = state.fix
        locationLine?.text = when {
            state.status == LocationLogic.Status.NO_PERMISSION -> getString(R.string.gps_no_permission)
            state.status == LocationLogic.Status.PROVIDERS_OFF -> getString(R.string.gps_providers_off)
            fix == null -> getString(R.string.gps_searching)
            else -> {
                val ageS = ((System.currentTimeMillis() - fix.timeMs) / 1000).toInt()
                getString(R.string.sos_location_fmt, fix.lat, fix.lng, fix.accuracyM.toInt(), ageS)
            }
        }
    }

    // ========================
    // COUNTDOWN → SEND
    // ========================

    private fun startCountdown() {
        persistProfile()
        var remaining = COUNTDOWN_SECONDS
        countdownOverlay?.visibility = View.VISIBLE
        val runnable = object : Runnable {
            override fun run() {
                if (remaining <= 0) {
                    countdownOverlay?.visibility = View.GONE
                    countdownRunnable = null
                    sendSos()
                    return
                }
                countdownText?.text = remaining.toString()
                remaining--
                handler.postDelayed(this, 1_000)
            }
        }
        countdownRunnable = runnable
        runnable.run()
    }

    private fun cancelCountdown() {
        countdownRunnable?.let { handler.removeCallbacks(it) }
        countdownRunnable = null
        countdownOverlay?.visibility = View.GONE
    }

    private fun sendSos() {
        val ctx = context ?: return
        val state = app.locationEngine
        val fix = state.currentFix()
        if (fix == null) {
            // No fix AT ALL: still allow the SOS — but the user must know.
            AlertDialog.Builder(ctx)
                .setTitle(R.string.sos_no_fix_title)
                .setMessage(R.string.sos_no_fix_message)
                .setPositiveButton(R.string.sos_send_anyway) { _, _ -> doSend(null) }
                .setNegativeButton(R.string.cancel, null)
                .show()
            return
        }
        doSend(fix)
    }

    private fun doSend(fix: LocationLogic.FixSnapshot?) {
        val hasFix = fix != null
        val lat = fix?.lat ?: DEFAULT_FALLBACK_LAT
        val lng = fix?.lng ?: DEFAULT_FALLBACK_LNG
        val audio = takeRecording()
        // Honesty in-band: a no-fix SOS travels with the Algiers fallback
        // coords AND an explicit marker so dispatchers never chase a phantom
        // location believing it was measured.
        val userText = messageInput?.text?.toString()?.trim().orEmpty()
        val markedText = if (hasFix) userText else "⚠ بدون تحديد GPS — $userText"
        resultCard?.text = ""
        app.repository.sendSos(
            deviceId = app.deviceId,
            lat = lat, lng = lng,
            name = nameInput?.text?.toString(),
            phone = phoneInput?.text?.toString(),
            textMessage = markedText.ifEmpty { null },
            audioDataUri = audio?.first,
            audioDurationSec = audio?.second
        ) { ok, outcome, userError ->
            activity?.runOnUiThread {
                resultCard?.visibility = View.VISIBLE
                resultCard?.text = when {
                    !ok -> getString(R.string.sos_failed_fmt, userError ?: "")
                    outcome != null && outcome.nearestFireDistanceKm != null -> getString(
                        R.string.sos_sent_fire_fmt,
                        outcome.priorityLabel(),
                        outcome.nearestFireDistanceKm,
                        if (outcome.nearbyFireCorroborated) "✔" else "—"
                    )
                    userError == AppRepository.OFFLINE_QUEUED_MSG -> getString(R.string.sos_queued)
                    else -> getString(R.string.sos_sent_simple)
                }
            }
        }
    }

    // SosOutcome is a TOP-LEVEL model (Models.kt), not nested in Parsers —
    // the nullable receiver extension must name it directly.
    private fun SosOutcome?.priorityLabel(): String = when (this?.priority) {
        "critical" -> getString(R.string.priority_critical)
        "high" -> getString(R.string.priority_high)
        "medium" -> getString(R.string.priority_medium)
        "low" -> getString(R.string.priority_low)
        else -> getString(R.string.priority_unknown)
    }

    // ========================
    // VOICE NOTE
    // ========================

    private fun micGranted(): Boolean =
        ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun toggleRecording() {
        if (recording) {
            stopRecording()
            return
        }
        if (!micGranted()) {
            requestPermissions(
                arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST_CODE
            )
            return
        }
        startRecording()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MIC_REQUEST_CODE) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                startRecording()
            } else {
                Toast.makeText(requireContext(), R.string.mic_denied_hint, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startRecording() {
        val ctx = context ?: return
        try {
            val file = File(ctx.cacheDir, "sos_voice_${System.currentTimeMillis()}.m4a")
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(ctx)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioEncodingBitRate(24_000)
            rec.setAudioSamplingRate(16_000)
            rec.setOutputFile(file.absolutePath)
            rec.setMaxDuration(MAX_RECORD_MS.toInt())
            rec.prepare()
            rec.start()
            recorder = rec
            recordFile = file
            recording = true
            recordStartMs = System.currentTimeMillis()
            recordState?.text = getString(R.string.sos_recording)
            recordButton?.alpha = 0.6f
            // Named runnable: a stale max-duration timer from a PREVIOUS
            // recording must never fire into the current one and cut it short.
            maxDurationRunnable?.let { handler.removeCallbacks(it) }
            val stopper = Runnable { if (recording) stopRecording() }
            maxDurationRunnable = stopper
            handler.postDelayed(stopper, MAX_RECORD_MS)
        } catch (e: Exception) {
            Toast.makeText(ctx, getString(R.string.sos_record_failed), Toast.LENGTH_LONG).show()
            releaseRecorder()
        }
    }

    /**
     * F3: stop() is what writes the MPEG-4 moov index — without it the file
     * is unplayable bytes, and skipping release() left the mic hot. Returns
     * true only when a stop() actually finalized a file (or none was open).
     */
    private fun stopRecording(): Boolean {
        maxDurationRunnable?.let { handler.removeCallbacks(it) }
        maxDurationRunnable = null
        val rec = recorder
        if (rec == null) {
            recording = false
            return true
        }
        val finalized = try {
            rec.stop()
            true
        } catch (e: Exception) {
            // stop() throws when nothing was captured — the file is junk
            false
        }
        releaseRecorder()
        recording = false
        recordState?.text = getString(R.string.sos_record_done)
        recordButton?.alpha = 1f
        return finalized
    }

    private fun takeRecording(): Pair<String, Int>? {
        val file = recordFile ?: return null
        recordFile = null
        if (!file.exists() || file.length() == 0L) {
            if (recorder != null || recording) stopRecording()
            file.delete()
            return null
        }
        // F3: if the recorder is STILL RUNNING, finalize it NOW. Reading an
        // MPEG-4 before stop() yields a moov-less file no dispatcher can
        // play — and the old code nulled `recording` without stopping,
        // which also bypassed the onDestroyView guard and kept the mic hot.
        if (recorder != null || recording) {
            if (!stopRecording()) {
                // stop() failed: moov never written, the bytes are unusable —
                // sending them would hand dispatch a broken recording.
                file.delete()
                return null
            }
        }
        val durationS = ((System.currentTimeMillis() - recordStartMs) / 1000).toInt().coerceIn(1, 20)
        return try {
            val bytes = file.readBytes()
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            "data:audio/mp4;base64,$b64" to durationS
        } catch (e: Exception) {
            null
        } finally {
            file.delete()
        }
    }

    private fun releaseRecorder() {
        try {
            recorder?.release()
        } catch (e: Exception) {
            // already released
        }
        recorder = null
    }

    private fun persistProfile() {
        val prefs = requireContext().getSharedPreferences("observatory_profile", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("name", nameInput?.text?.toString()?.trim().orEmpty())
            .putString("phone", phoneInput?.text?.toString()?.trim().orEmpty())
            .apply()
    }

    override fun onDestroyView() {
        cancelCountdown()
        // F3: judge by the RECORDER, not the flag — takeRecording() used to
        // null the flag on a live recorder and this guard skipped cleanup,
        // leaving the mic open for the rest of the process lifetime.
        if (recorder != null || recording) stopRecording()
        recordFile?.delete()
        app.locationEngine.removeListener(locationListener)
        nameInput = null
        phoneInput = null
        messageInput = null
        locationLine = null
        recordButton = null
        recordState = null
        sosButton = null
        countdownOverlay = null
        countdownText = null
        resultCard = null
        sendingProgress = null
        super.onDestroyView()
    }
}
