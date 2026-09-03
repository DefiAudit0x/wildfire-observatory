package com.observatory.wildfire

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import android.util.Log
import android.view.LayoutInflater
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import android.graphics.Bitmap
import java.io.File
import java.util.concurrent.Executors
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * v2.2.0 — the in-app camera: the field reporter taps "تصوير" and the camera
 * opens INSIDE the app, following the owner's directive ("غرضنا كامل هو فتح
 * الكاميرا وتصوير").
 *
 * S3 (v2.9.0) — telemetry-camera parity with the web ReportForm:
 *  - COMPASS STATE MACHINE: TYPE_ROTATION_VECTOR → heading (0..360, north)
 *    + pitch (camera elevation, -90..90), throttled to 4 Hz with a
 *    rounded-change skip via TelemetryCamera (ARC-M20 mirror). Values stay
 *    null until a real sensor delivers them; no sensor → honest hint and
 *    the MANUAL sliders remain (stamp says MANUAL, exactly like the web);
 *  - MANUAL OVERRIDE: heading 0..359 / pitch -60..60 sliders — a user drag
 *    marks the source MANUAL (the sensor only overwrites when its reading
 *    actually changes, so a steady sensor never fights the operator);
 *  - LIVE ALIGNMENT ESTIMATE: fresh pending/verified reports within the
 *    15 km / 45° FOV cone are surfaced as a confidence estimate while
 *    framing — an alignment aid, never proof;
 *  - STAMP TOGGLE: ختم القياسات مفعّل/معطّل (web includeTelemetry);
 *  - STAMPED CAPTURE: shutter freezes GPS + sensors + alignment, the JPEG
 *    is EXIF-uprighted and watermarked by TelemetryOverlay (same evidentiary
 *    HUD as the web frame), pre-scanned by the on-device color heuristic,
 *    then handed to ReportFragment via the Fragment Result API.
 *
 * CameraX stack, lifecycle-safe by construction: Preview bound to
 * viewLifecycleOwner; runtime permission denial answers with the gallery
 * fallback hint; front/back toggle rebinds the same use cases. All decode/
 * stamp work runs on a single background executor — the shutter callback
 * thread never blocks.
 *
 * NOT in this class: data URIs, budgets, retries — ReportFragment's ingest
 * path owns them; the camera produces a stamped file + telemetry result.
 */
class CameraCaptureFragment : Fragment() {

    companion object {
        /** Fragment Result API key — ReportFragment listens with its viewLifecycleOwner. */
        const val RESULT_KEY = "camera_capture"

        /** Bundle field: absolute path of the captured (stamped) JPEG in cacheDir. */
        const val RESULT_CAPTURE_PATH = "capture_path"

        /** Bundle fields: on-device pre-scan verdict + alignment estimate. */
        const val RESULT_PRESCAN_PRESENT = "prescan_present"
        const val RESULT_PRESCAN_CONFIDENCE = "prescan_confidence"
        const val RESULT_ALIGN_PCT = "align_pct"
        const val RESULT_ALIGN_NAME = "align_name"

        private const val CAPTURE_FILE_PREFIX = "report_capture_"
        private const val TAG = "TelemetryCamera"
    }

    private var previewView: PreviewView? = null
    private var imageCapture: ImageCapture? = null
    private var facing = CameraSelector.LENS_FACING_BACK
    private var captureInFlight = false

    // --- S3 telemetry state (frozen at shutter, web captureSnapshot parity) ---
    private var sensorManager: SensorManager? = null
    private var includeTelemetry = true
    private var currentHeading: Int? = null
    private var currentPitch: Int? = null
    private var headingSource = "NONE"
    private var pitchSource = "NONE"
    private var lastCompassMs = 0L
    private var lastHeading: Int? = null
    private var lastPitch: Int? = null

    private var compassText: TextView? = null
    private var alignmentText: TextView? = null
    private var stampToggle: TextView? = null
    private var statusText: TextView? = null
    private var headingSlider: SeekBar? = null
    private var pitchSlider: SeekBar? = null

    private val stampExecutor by lazy { Executors.newSingleThreadExecutor() }

    private val app get() = requireActivity().application as ObservatoryApp

    // F2 house rule: named listeners, removed in onDestroyView.
    private val locationListener: (LocationEngine.State) -> Unit = { _ ->
        activity?.runOnUiThread { updateAlignmentLine() }
    }

    // --- Compass ingestion (4 Hz throttle + rounded-change skip) ---
    private val rotationListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
            val rotation = FloatArray(9)
            SensorManager.getRotationMatrixFromVector(rotation, event.values)
            val remapped = FloatArray(9)
            val (xAxis, yAxis) = remapAxes()
            if (!SensorManager.remapCoordinateSystem(rotation, xAxis, yAxis, remapped)) return
            val orientation = FloatArray(3)
            SensorManager.getOrientation(remapped, orientation)
            // azimuth → compass bearing 0..360 (magnetic estimate — the web
            // 360-alpha path carries the same caveat, honesty preserved).
            val heading = ((Math.toDegrees(orientation[0].toDouble()) + 360.0) % 360.0).roundToInt()
            // getOrientation pitch is negative upright; negate → camera
            // elevation in web-beta semantics (upright horizon ≈ +90).
            val pitch = (-Math.toDegrees(orientation[1].toDouble())).roundToInt().coerceIn(-90, 90)
            onCompassSample(heading, pitch)
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    /** Screen-rotation-aware axis remap so azimuth matches what the user sees. */
    private fun remapAxes(): Pair<Int, Int> {
        val rotation = activity?.window?.decorView?.display?.rotation ?: Surface.ROTATION_0
        return when (rotation) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Z
        }
    }

    private fun onCompassSample(heading: Int, pitch: Int) {
        val now = System.currentTimeMillis()
        if (!TelemetryCamera.shouldAcceptCompassSample(now, lastCompassMs, heading, pitch, lastHeading, lastPitch)) return
        lastCompassMs = now
        lastHeading = heading
        lastPitch = pitch
        currentHeading = heading
        currentPitch = pitch
        headingSource = TelemetryCamera.SOURCE_SENSOR
        pitchSource = TelemetryCamera.SOURCE_SENSOR
        activity?.runOnUiThread {
            // Keep the manual sliders tracking the live sensor (setProgress is
            // not fromUser, so the MANUAL override marker never fires here).
            headingSlider?.progress = heading
            pitchSlider?.progress = (pitch + 60).coerceIn(0, 120)
            updateHud()
        }
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                bindCamera()
            } else {
                // The report form underneath is alive and offers "من المعرض" —
                // never strand the reporter on a dead screen.
                Toast.makeText(
                    requireContext(), R.string.camera_permission_denied, Toast.LENGTH_LONG
                ).show()
                popBack()
            }
        }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_camera, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        previewView = view.findViewById(R.id.camera_preview)
        compassText = view.findViewById(R.id.camera_compass)
        alignmentText = view.findViewById(R.id.camera_alignment)
        stampToggle = view.findViewById(R.id.camera_stamp_toggle)
        statusText = view.findViewById(R.id.camera_status)
        headingSlider = view.findViewById(R.id.camera_heading_slider)
        pitchSlider = view.findViewById(R.id.camera_pitch_slider)

        view.findViewById<View>(R.id.camera_shutter).setOnClickListener { takePhoto() }
        view.findViewById<View>(R.id.camera_flip).setOnClickListener { toggleFacing() }
        view.findViewById<View>(R.id.camera_close).setOnClickListener { popBack() }

        stampToggle?.setOnClickListener {
            includeTelemetry = !includeTelemetry
            updateHud()
        }

        // Manual overrides — a drag marks the source MANUAL (web slider
        // semantics; the sensor overwrites only on an actual reading change,
        // so a steady sensor never fights the operator).
        headingSlider?.max = 359
        headingSlider?.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                currentHeading = progress
                headingSource = TelemetryCamera.SOURCE_MANUAL
                updateHud()
            }

            override fun onStartTrackingTouch(bar: SeekBar?) {}
            override fun onStopTrackingTouch(bar: SeekBar?) {}
        })
        pitchSlider?.max = 120 // -60..60 stored as progress+60
        pitchSlider?.progress = 60
        pitchSlider?.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                currentPitch = progress - 60
                pitchSource = TelemetryCamera.SOURCE_MANUAL
                updateHud()
            }

            override fun onStartTrackingTouch(bar: SeekBar?) {}
            override fun onStopTrackingTouch(bar: SeekBar?) {}
        })

        startCompass()
        app.locationEngine.addListener(locationListener)
        updateHud()

        if (ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            bindCamera()
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    /** Register the rotation-vector sensor; absence is honest, sliders remain. */
    private fun startCompass() {
        val ctx = context ?: return
        sensorManager = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val sensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        if (sensor == null) {
            compassText?.text = getString(R.string.camera_sensor_unavailable)
            return
        }
        sensorManager?.registerListener(
            rotationListener, sensor, SensorManager.SENSOR_DELAY_UI
        )
    }

    /** Live HUD: compass chip + status bar + alignment estimate (O(reports)). */
    private fun updateHud() {
        val heading = currentHeading
        compassText?.text = if (heading != null) {
            val src = if (headingSource == TelemetryCamera.SOURCE_MANUAL) {
                getString(R.string.camera_source_manual)
            } else {
                getString(R.string.camera_source_sensor)
            }
            getString(
                R.string.camera_compass_fmt,
                heading,
                TelemetryCamera.bearingDirectionAr(heading.toDouble()),
                src
            )
        } else {
            getString(R.string.camera_compass_none)
        }
        stampToggle?.text =
            if (includeTelemetry) getString(R.string.camera_stamp_on) else getString(R.string.camera_stamp_off)

        val fix = app.locationEngine.currentFix()
        statusText?.text = getString(
            R.string.camera_status_fmt,
            fix?.let { String.format(java.util.Locale.US, "%.5f, %.5f", it.lat, it.lng) }
                ?: getString(R.string.camera_gps_not_set),
            heading?.let { "${it}°" } ?: "N/A",
            currentPitch?.let { "${it}°" } ?: "N/A"
        )
        updateAlignmentLine()
    }

    private fun updateAlignmentLine() {
        val view = alignmentText ?: return
        val fix = app.locationEngine.currentFix()
        val heading = currentHeading
        val match = if (fix != null && heading != null) {
            TelemetryCamera.crossCheck(
                app.repository.state.value.reports,
                fix.lat, fix.lng, heading.toDouble(), System.currentTimeMillis()
            )
        } else null
        view.text = when {
            match != null -> getString(
                R.string.camera_alignment_match_fmt,
                match.confidencePct,
                match.locationName,
                match.distanceKm,
                match.bearingDeg.roundToInt()
            )
            fix == null || heading == null -> getString(R.string.camera_alignment_no_fix)
            else -> getString(R.string.camera_alignment_none)
        }
    }

    /** Bind Preview + ImageCapture; any failure answers with the fallback hint, not a crash. */
    private fun bindCamera() {
        val ctx = context ?: return
        try {
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                if (!isAdded || previewView == null) return@addListener
                try {
                    val provider = future.get()
                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView?.surfaceProvider)
                    }
                    imageCapture = ImageCapture.Builder().build()
                    provider.unbindAll()
                    provider.bindToLifecycle(
                        viewLifecycleOwner,
                        CameraSelector.Builder().requireLensFacing(facing).build(),
                        preview,
                        imageCapture
                    )
                } catch (e: Exception) {
                    cameraFailed()
                }
            }, ContextCompat.getMainExecutor(ctx))
        } catch (e: Exception) {
            cameraFailed()
        }
    }

    private fun toggleFacing() {
        facing =
            if (facing == CameraSelector.LENS_FACING_BACK) CameraSelector.LENS_FACING_FRONT
            else CameraSelector.LENS_FACING_BACK
        imageCapture = null
        bindCamera()
    }

    private fun takePhoto() {
        val capture = imageCapture ?: return
        if (captureInFlight) return
        captureInFlight = true

        // Freeze telemetry NOW (web freezes heading/pitch/lat/lng at capture).
        val fix = app.locationEngine.currentFix()
        val nowMs = System.currentTimeMillis()
        val alignment = if (fix != null && currentHeading != null) {
            TelemetryCamera.crossCheck(
                app.repository.state.value.reports,
                fix.lat, fix.lng, currentHeading!!.toDouble(), nowMs
            )
        } else null
        val stamp = TelemetryCamera.buildStamp(
            lat = fix?.lat,
            lng = fix?.lng,
            heading = currentHeading,
            headingSource = headingSource,
            pitch = currentPitch,
            pitchSource = pitchSource,
            includeTelemetry = includeTelemetry,
            nowMs = nowMs
        )

        val file = File(requireContext().cacheDir, "$CAPTURE_FILE_PREFIX${System.currentTimeMillis()}.jpg")
        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(
            options,
            ContextCompat.getMainExecutor(requireContext()),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    processAndDeliver(file, stamp, alignment)
                }

                override fun onError(exception: ImageCaptureException) {
                    captureInFlight = false
                    Toast.makeText(
                        requireContext(), R.string.camera_open_fail, Toast.LENGTH_SHORT
                    ).show()
                }
            }
        )
    }

    /**
     * Background: decode EXIF-upright → stamp the evidentiary HUD → run the
     * on-device pre-scan → re-encode JPEG 85 → hand path + telemetry result
     * to ReportFragment. Decoding failure keeps the RAW file (an unstamped
     * real photo still beats no photo — never invent an image).
     */
    private fun processAndDeliver(
        file: File,
        stamp: TelemetryCamera.Stamp,
        alignment: TelemetryCamera.Alignment?
    ) {
        // Captured BEFORE going background: viewLifecycleOwner is illegal to
        // touch from another thread after onDestroyView.
        val uiScope = viewLifecycleOwner.lifecycleScope
        stampExecutor.execute {
            val preScan = try {
                val bitmap = TelemetryOverlay.decodeUpright(file)
                if (bitmap != null) {
                    val stamped = bitmap.copy(Bitmap.Config.ARGB_8888, true)
                    bitmap.recycle()
                    TelemetryOverlay.stamp(stamped, stamp, alignment)
                    val pixels = TelemetryOverlay.downsamplePixels(stamped)
                    val scan = TelemetryCamera.preScan(pixels)
                    file.outputStream().use { out ->
                        stamped.compress(Bitmap.CompressFormat.JPEG, 85, out)
                    }
                    stamped.recycle()
                    scan
                } else null
            } catch (e: Exception) {
                Log.w(TAG, "stamp failed, delivering raw capture", e)
                null
            }

            val result = Bundle().apply {
                putString(RESULT_CAPTURE_PATH, file.absolutePath)
                putBoolean(RESULT_PRESCAN_PRESENT, preScan?.present == true)
                putInt(RESULT_PRESCAN_CONFIDENCE, preScan?.confidence ?: 0)
                putInt(RESULT_ALIGN_PCT, alignment?.confidencePct ?: -1)
                putString(RESULT_ALIGN_NAME, alignment?.locationName)
            }
            uiScope.launch {
                if (isAdded) {
                    parentFragmentManager.setFragmentResult(RESULT_KEY, result)
                    popBack()
                }
            }
            captureInFlight = false
        }
    }

    private fun cameraFailed() {
        if (!isAdded) return
        Toast.makeText(requireContext(), R.string.camera_open_fail, Toast.LENGTH_LONG).show()
        popBack()
    }

    private fun popBack() {
        if (isAdded) parentFragmentManager.popBackStack()
    }

    override fun onDestroyView() {
        sensorManager?.unregisterListener(rotationListener)
        sensorManager = null
        app.locationEngine.removeListener(locationListener)
        previewView = null
        imageCapture = null
        compassText = null
        alignmentText = null
        stampToggle = null
        statusText = null
        headingSlider = null
        pitchSlider = null
        super.onDestroyView()
    }
}
