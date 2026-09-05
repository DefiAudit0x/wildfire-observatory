package com.observatory.wildfire

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.io.InputStream

/**
 * v2.2.0 — بلاغ ميداني. The native report form closing the other half of the
 * field feedback: place name and wilaya auto-fill from Nominatim reverse
 * geocoding the moment a fix lands (never overwriting user edits), severity
 * chips, TWO photo paths — the in-app camera (the point of the whole feature:
 * "فتح الكاميرا وتصوير") and the legacy gallery pick — then the offline queue
 * path with the idempotent replay.
 *
 * v2.19.0 — THE AUTOFILL TRUTH FIX (owner verdict: "لماذا لا تُملأ تلقائياً").
 * Three silent failure modes found and killed:
 *  1. the freshness gate (< 60 s) blocked the geocode for ANY older fix —
 *     opening the tab after standing still meant NOTHING ever filled;
 *  2. failures were invisible (a 403/timeout landed in a silent backoff);
 *  3. the "اضغط للسماح" hint was NOT clickable and no permission request
 *     existed in this fragment (the ladder runs once, in the activity).
 * Now: autofill fires from the FIRST fix (fresh or stale), every state is
 * rendered in report_geo_status, the location line is a real action button
 * (request permission / open settings / retry), an offline-safe nearest-wilaya
 * fallback fills the wilaya even when the server is down (marked "تقريبي"),
 * manual edits are protected by text watchers, and flags reset after a
 * successful send so the next report fills again.
 *
 * Photo plumbing is unified in PhotoPipeline (sample → JPEG budget); this
 * class only decides the SOURCE: cache file from CameraCaptureFragment
 * (Fragment Result API) or content URI from the gallery picker.
 */
class ReportFragment : Fragment() {

    companion object {
        private const val PICK_IMAGE_REQUEST = 3003
        // F6: cool-down after a failed reverse-geocode attempt.
        private const val GEO_BACKOFF_MS = 60_000L
    }

    private val app get() = requireActivity().application as ObservatoryApp

    private var severity = "medium"
    private val severityButtons = HashMap<String, View>()
    private var locationNameInput: EditText? = null
    private var wilayaInput: EditText? = null
    private var descriptionInput: EditText? = null
    private var locationLine: TextView? = null
    private var geoStatusLine: TextView? = null
    private var photoLine: TextView? = null
    private var telemetryLine: TextView? = null
    private var queueLine: TextView? = null
    private var submitButton: View? = null

    private var imageDataUri: String? = null
    private var autofilledName = false
    private var autofilledWilaya = false

    // v2.19.0: the last GPS verdict drives what tapping the location line does.
    private var lastStatus: LocationLogic.Status = LocationLogic.Status.SEARCHING
    private var geoFailed = false
    /** True while code sets field text — the watchers must not treat that as
     *  a manual edit (manual edits are protected, programmatic fills are ours). */
    private var programmaticFill = false

    // v2.19.0: the permission request lives HERE now — the activity ladder
    // runs once at launch; a user who tapped "لاحقًا" and later opens the
    // report tab needs a second chance exactly where the hint says "اضغط".
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        if (granted.values.any { it }) {
            app.locationEngine.onPermissionGranted() // re-publishes → onLocation re-renders
        }
    }

    // F6: reverse-geocode discipline — single-flight (drop while one is
    // outstanding) + a 60 s backoff after any failure, so a degraded
    // upstream never turns the autofill into a retry storm. The call also
    // now rides the server's /api/geo/reverse proxy (cache + rate limit).
    private var geoLookupInFlight = false
    private var geoBackoffUntilMs = 0L

    // F2: named listener so onDestroyView can deregister from the
    // application-scoped engine (an inline lambda leaked this view forever).
    private val locationListener: (LocationEngine.State) -> Unit = { state ->
        activity?.runOnUiThread { onLocation(state) }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_report, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        locationNameInput = view.findViewById(R.id.report_location_name)
        wilayaInput = view.findViewById(R.id.report_wilaya)
        descriptionInput = view.findViewById(R.id.report_description)
        locationLine = view.findViewById(R.id.report_location_line)
        geoStatusLine = view.findViewById(R.id.report_geo_status)
        photoLine = view.findViewById(R.id.report_photo_line)
        telemetryLine = view.findViewById(R.id.report_telemetry_line)
        queueLine = view.findViewById(R.id.report_queue_line)
        submitButton = view.findViewById(R.id.report_submit)

        // v2.19.0: the location line is now an ACTION — permission request,
        // location settings, or geocode retry depending on the state.
        locationLine?.setOnClickListener { onLocationLineTapped() }
        // Manual edits are sacred: any user keystroke marks the field as
        // hand-owned so a later autofill can never overwrite it.
        locationNameInput?.addTextChangedListener(manualEditWatcher { autofilledName = true })
        wilayaInput?.addTextChangedListener(manualEditWatcher { autofilledWilaya = true })

        severityButtons["low"] = view.findViewById(R.id.sev_low)
        severityButtons["medium"] = view.findViewById(R.id.sev_medium)
        severityButtons["high"] = view.findViewById(R.id.sev_high)
        severityButtons["critical"] = view.findViewById(R.id.sev_critical)
        for ((key, btn) in severityButtons) {
            btn.setOnClickListener { setSeverity(key) }
        }
        setSeverity("medium")

        view.findViewById<View>(R.id.report_camera).setOnClickListener { openCamera() }
        view.findViewById<View>(R.id.report_gallery).setOnClickListener { pickImage() }
        submitButton?.setOnClickListener { submit() }

        // The in-app camera hands back a cache-file path via the Fragment
        // Result API. The form sits underneath the camera (add + back stack),
        // so severity/description/text survive the capture round trip.
        // S3: the result also carries the stamped capture's telemetry —
        // the on-device pre-scan verdict and the alignment estimate — shown
        // verbatim beside the photo line (estimate-only wording preserved).
        parentFragmentManager.setFragmentResultListener(
            CameraCaptureFragment.RESULT_KEY, viewLifecycleOwner
        ) { _, bundle ->
            val path = bundle.getString(CameraCaptureFragment.RESULT_CAPTURE_PATH)
                ?: return@setFragmentResultListener
            ingestImage(openStream = { File(path).inputStream() }, fromCapture = true)
            showCaptureTelemetry(
                prescanPresent = bundle.getBoolean(CameraCaptureFragment.RESULT_PRESCAN_PRESENT),
                prescanConfidence = bundle.getInt(CameraCaptureFragment.RESULT_PRESCAN_CONFIDENCE),
                alignPct = bundle.getInt(CameraCaptureFragment.RESULT_ALIGN_PCT),
                alignName = bundle.getString(CameraCaptureFragment.RESULT_ALIGN_NAME)
            )
            viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
                // Cache hygiene: the processed data URI lives in memory now.
                runCatching { File(path).delete() }
            }
        }

        app.locationEngine.addListener(locationListener)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap ->
                    queueLine?.visibility = if (snap.queueSize > 0) View.VISIBLE else View.GONE
                    queueLine?.text = getString(R.string.report_queue_fmt, snap.queueSize)
                }
            }
        }
    }

    private fun setSeverity(key: String) {
        severity = key
        val activeColor = 0xFFD21034.toInt()
        val idleColor = 0xFF94A3B8.toInt()
        for ((k, btn) in severityButtons) {
            btn.alpha = if (k == key) 1f else 0.45f
            when (k) {
                "low" -> (btn as? TextView)?.setTextColor(if (k == key) 0xFF2E9E5B.toInt() else idleColor)
                "critical" -> (btn as? TextView)?.setTextColor(if (k == key) activeColor else idleColor)
                "high" -> (btn as? TextView)?.setTextColor(if (k == key) 0xFFF04E1F.toInt() else idleColor)
                else -> (btn as? TextView)?.setTextColor(if (k == key) 0xFFFF6B35.toInt() else idleColor)
            }
        }
    }

    /** v2.19.0: manual-edit detector that ignores programmatic fills. */
    private fun manualEditWatcher(onManual: () -> Unit): TextWatcher = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        override fun afterTextChanged(s: Editable?) {
            if (!programmaticFill) onManual()
        }
    }

    private fun fillField(edit: EditText?, text: String) {
        programmaticFill = true
        edit?.setText(text)
        programmaticFill = false
    }

    /** The location line is a button: its action follows the GPS state. */
    private fun onLocationLineTapped() {
        when (lastStatus) {
            LocationLogic.Status.NO_PERMISSION ->
                locationPermissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    )
                )
            LocationLogic.Status.PROVIDERS_OFF ->
                try {
                    startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                } catch (e: Exception) {
                    Toast.makeText(requireContext(), R.string.report_tap_settings, Toast.LENGTH_SHORT).show()
                }
            else -> {
                val fix = app.locationEngine.currentFix()
                if (fix != null && geoFailed) {
                    geoBackoffUntilMs = 0L // explicit user retry beats the backoff
                    reverseGeocode(fix.lat, fix.lng)
                }
            }
        }
    }

    private fun setGeoStatus(text: String?) {
        geoStatusLine?.visibility = if (text == null) View.GONE else View.VISIBLE
        geoStatusLine?.text = text
    }

    private fun onLocation(state: LocationEngine.State) {
        val fix = state.fix
        lastStatus = state.status
        locationLine?.text = when {
            state.status == LocationLogic.Status.NO_PERMISSION -> getString(R.string.gps_no_permission)
            state.status == LocationLogic.Status.PROVIDERS_OFF -> getString(R.string.gps_providers_off)
            fix == null -> getString(R.string.gps_searching)
            else -> getString(R.string.report_location_line_fmt, fix.lat, fix.lng, fix.accuracyM.toInt())
        }
        // Autofill place name + wilaya once a fix EXISTS — fresh or stale
        // (v2.19.0: the old < 60 s freshness gate was the "لماذا لا تُملأ"
        // bug — a fix minutes old never filled anything). The single-flight
        // guard + backoff below keep this from ever becoming a retry storm;
        // the flags keep it from overwriting user edits.
        if (fix != null && (!autofilledName || !autofilledWilaya)) {
            reverseGeocode(fix.lat, fix.lng)
        }
    }

    private fun reverseGeocode(lat: Double, lng: Double) {
        // F6: single-flight + failure backoff. The lookup used to re-fire
        // with every GPS publish while the autofill flags were unset, and
        // once the service degraded into 403s this became a continuous
        // policy violation. It rides the server's /api/geo/reverse proxy
        // (which caches + rate-limits on top of this discipline).
        if (geoLookupInFlight) return
        if (!geoFailed && System.currentTimeMillis() < geoBackoffUntilMs) return
        geoLookupInFlight = true
        if (!autofilledName) setGeoStatus(getString(R.string.geo_status_resolving))
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    when (val r = app.api.get(ApiPayloads.buildGeoReversePath(lat, lng))) {
                        is ObservatoryApi.Result.Ok -> Parsers.parseNominatimReverse(r.body)
                        else -> null
                    }
                }
                if (!isAdded) return@launch
                if (result == null) {
                    // v2.19.0: failure is VISIBLE now, and the wilaya still
                    // fills from the offline nearest-centroid table (marked
                    // "تقريبي"). No invented street names — just what we know.
                    geoFailed = true
                    geoBackoffUntilMs = System.currentTimeMillis() + GEO_BACKOFF_MS
                    if (!autofilledName) {
                        val fallback = Wilayas.nearest(lat, lng)
                        if (!autofilledWilaya) fillField(wilayaInput, fallback.nameAr)
                        setGeoStatus(getString(R.string.geo_status_offline_fmt, fallback.nameAr))
                    } else {
                        setGeoStatus(getString(R.string.geo_status_failed))
                    }
                    return@launch
                }
                geoFailed = false
                val (display, stateName) = result
                if (!autofilledName) {
                    fillField(locationNameInput, display.split(",").take(2).joinToString("،").trim())
                    autofilledName = true
                }
                if (!autofilledWilaya && stateName.isNotBlank()) {
                    fillField(wilayaInput, stateName)
                    autofilledWilaya = true
                }
                setGeoStatus(null)
            } finally {
                // Released even when the coroutine is cancelled (view left) —
                // a stuck lock would silence the autofill for the session.
                geoLookupInFlight = false
            }
        }
    }

    private fun openCamera() {
        parentFragmentManager.beginTransaction()
            .add(R.id.fragment_container, CameraCaptureFragment())
            .addToBackStack(null)
            .commit()
    }

    private fun pickImage() {
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        try {
            startActivityForResult(Intent.createChooser(intent, getString(R.string.report_pick_photo)), PICK_IMAGE_REQUEST)
        } catch (e: Exception) {
            Toast.makeText(requireContext(), R.string.report_no_gallery, Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PICK_IMAGE_REQUEST || resultCode != Activity.RESULT_OK) return
        val uri = data?.data ?: return
        ingestImage(
            openStream = { requireContext().contentResolver.openInputStream(uri) },
            fromCapture = false
        )
    }

    /**
     * S3 — the stamped capture's telemetry verdicts, verbatim estimate-only
     * wording (web edgeAiStatus + matchedReport lines). A -1 alignPct means
     * "no alignment was computed" (no fix or no heading) — the line is
     * omitted rather than faked.
     */
    private fun showCaptureTelemetry(
        prescanPresent: Boolean,
        prescanConfidence: Int,
        alignPct: Int,
        alignName: String?
    ) {
        val view = telemetryLine ?: return
        val prescanText = if (prescanPresent) {
            getString(R.string.prescan_positive_fmt, prescanConfidence)
        } else {
            getString(R.string.prescan_negative_fmt, prescanConfidence)
        }
        val alignText = if (alignPct >= 0) {
            getString(
                R.string.telemetry_alignment_fmt,
                alignPct,
                alignName ?: ""
            )
        } else null
        view.text = if (alignText != null) "$prescanText\n$alignText" else prescanText
        view.visibility = View.VISIBLE
    }

    /**
     * One ingest path for BOTH sources (gallery URI stream, camera cache
     * file): decode bounds → PhotoPipeline sample → decode → JPEG budget →
     * data URI. Behavior-identical to the v2.0.0 picker loop, now shared.
     * S3: gallery picks run the color pre-scan and get the honest EXIF note
     * (web parity — the file-upload warning); stamped captures skip both —
     * their verdicts arrive in the camera result bundle instead.
     */
    private fun ingestImage(openStream: (boundsOnly: Boolean) -> InputStream?, fromCapture: Boolean) {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            openStream(true)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = PhotoPipeline.targetSample(bounds.outWidth, bounds.outHeight)
            }
            val bitmap = openStream(false)?.use { BitmapFactory.decodeStream(it, null, opts) }
            if (bitmap == null) return
            // Pre-scan on the decoded frame BEFORE it is recycled (gallery
            // only — stamped captures deliver their verdict in the bundle).
            val scan = if (!fromCapture) {
                TelemetryCamera.preScan(TelemetryOverlay.downsamplePixels(bitmap))
            } else null
            val bytes = PhotoPipeline.compressWithinBudget(bitmap)
            bitmap.recycle()
            if (bytes == null) {
                Toast.makeText(requireContext(), R.string.report_photo_too_big, Toast.LENGTH_LONG).show()
                return
            }
            imageDataUri = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
            photoLine?.text = getString(R.string.report_photo_attached_fmt, bytes.size / 1024)
            photoLine?.visibility = View.VISIBLE
            if (scan != null) {
                val prescanText = if (scan.present) {
                    getString(R.string.prescan_positive_fmt, scan.confidence)
                } else {
                    getString(R.string.prescan_negative_fmt, scan.confidence)
                }
                telemetryLine?.text = "$prescanText\n${getString(R.string.gallery_no_telemetry)}"
                telemetryLine?.visibility = View.VISIBLE
            }
        } catch (e: Exception) {
            Toast.makeText(requireContext(), R.string.report_photo_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun submit() {
        val ctx = context ?: return
        val fix = app.locationEngine.currentFix()
        val name = locationNameInput?.text?.toString()?.trim().orEmpty()
        val wilaya = wilayaInput?.text?.toString()?.trim().orEmpty()
        val desc = descriptionInput?.text?.toString()?.trim().orEmpty()
        if (fix == null) {
            Toast.makeText(ctx, R.string.report_need_fix, Toast.LENGTH_LONG).show()
            return
        }
        submitButton?.isEnabled = false
        app.repository.submitReport(
            lat = fix.lat, lng = fix.lng,
            locationName = name.ifEmpty { "موقع غير مسمى" },
            wilaya = wilaya,
            description = desc,
            severity = severity,
            deviceId = app.deviceId,
            imageDataUri = imageDataUri
        ) { ok, userError ->
            activity?.runOnUiThread {
                submitButton?.isEnabled = true
                if (ok && userError == null) {
                    Toast.makeText(ctx, R.string.report_sent, Toast.LENGTH_LONG).show()
                    descriptionInput?.setText("")
                    imageDataUri = null
                    photoLine?.text = ""
                    photoLine?.visibility = View.GONE
                    telemetryLine?.text = ""
                    telemetryLine?.visibility = View.GONE
                    // v2.19.0: the NEXT report is a new report — autofill must
                    // run again (was stuck for the whole view lifetime).
                    autofilledName = false
                    autofilledWilaya = false
                    geoFailed = false
                    geoBackoffUntilMs = 0L
                } else if (ok && userError == AppRepository.OFFLINE_QUEUED_MSG) {
                    Toast.makeText(ctx, userError, Toast.LENGTH_LONG).show()
                } else if (!ok) {
                    Toast.makeText(ctx, getString(R.string.report_failed_fmt, userError ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    override fun onDestroyView() {
        app.locationEngine.removeListener(locationListener)
        locationNameInput = null
        wilayaInput = null
        descriptionInput = null
        locationLine = null
        geoStatusLine = null
        photoLine = null
        telemetryLine = null
        queueLine = null
        submitButton = null
        severityButtons.clear()
        super.onDestroyView()
    }
}
