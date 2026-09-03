package com.observatory.wildfire

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
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
 * Photo plumbing is unified in PhotoPipeline (sample → JPEG budget); this
 * class only decides the SOURCE: cache file from CameraCaptureFragment
 * (Fragment Result API) or content URI from the gallery picker.
 */
class ReportFragment : Fragment() {

    companion object {
        private const val PICK_IMAGE_REQUEST = 3003
    }

    private val app get() = requireActivity().application as ObservatoryApp

    private var severity = "medium"
    private val severityButtons = HashMap<String, View>()
    private var locationNameInput: EditText? = null
    private var wilayaInput: EditText? = null
    private var descriptionInput: EditText? = null
    private var locationLine: TextView? = null
    private var photoLine: TextView? = null
    private var queueLine: TextView? = null
    private var submitButton: View? = null

    private var imageDataUri: String? = null
    private var autofilledName = false
    private var autofilledWilaya = false

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
        photoLine = view.findViewById(R.id.report_photo_line)
        queueLine = view.findViewById(R.id.report_queue_line)
        submitButton = view.findViewById(R.id.report_submit)

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
        parentFragmentManager.setFragmentResultListener(
            CameraCaptureFragment.RESULT_KEY, viewLifecycleOwner
        ) { _, bundle ->
            val path = bundle.getString(CameraCaptureFragment.RESULT_CAPTURE_PATH)
                ?: return@setFragmentResultListener
            ingestImage { File(path).inputStream() }
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
        val activeColor = 0xFFEF4444.toInt()
        val idleColor = 0xFF94A3B8.toInt()
        for ((k, btn) in severityButtons) {
            btn.alpha = if (k == key) 1f else 0.45f
            when (k) {
                "low" -> (btn as? TextView)?.setTextColor(if (k == key) 0xFF10B981.toInt() else idleColor)
                "critical" -> (btn as? TextView)?.setTextColor(if (k == key) activeColor else idleColor)
                "high" -> (btn as? TextView)?.setTextColor(if (k == key) 0xFFF97316.toInt() else idleColor)
                else -> (btn as? TextView)?.setTextColor(if (k == key) 0xFFF59E0B.toInt() else idleColor)
            }
        }
    }

    private fun onLocation(state: LocationEngine.State) {
        val fix = state.fix
        locationLine?.text = when {
            state.status == LocationLogic.Status.NO_PERMISSION -> getString(R.string.gps_no_permission)
            state.status == LocationLogic.Status.PROVIDERS_OFF -> getString(R.string.gps_providers_off)
            fix == null -> getString(R.string.gps_searching)
            else -> getString(R.string.report_location_line_fmt, fix.lat, fix.lng, fix.accuracyM.toInt())
        }
        // Autofill place name + wilaya ONCE per fresh fix, never overwriting
        // user edits (the never-overwrite contract from the web ReportForm).
        if (fix != null && LocationLogic.isFreshFix(fix, System.currentTimeMillis())) {
            if (!autofilledName || !autofilledWilaya) {
                reverseGeocode(fix.lat, fix.lng)
            }
        }
    }

    private fun reverseGeocode(lat: Double, lng: Double) {
        viewLifecycleOwner.lifecycleScope.launch {
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                when (val r = app.api.get(ApiPayloads.buildNominatimReverseUrl(lat, lng))) {
                    is ObservatoryApi.Result.Ok -> Parsers.parseNominatimReverse(r.body)
                    else -> null
                }
            }
            if (!isAdded) return@launch
            val (display, stateName) = result ?: return@launch
            if (!autofilledName) {
                locationNameInput?.setText(display.split(",").take(2).joinToString("،").trim())
                autofilledName = true
            }
            if (!autofilledWilaya && stateName.isNotBlank()) {
                wilayaInput?.setText(stateName)
                autofilledWilaya = true
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
        ingestImage { requireContext().contentResolver.openInputStream(uri) }
    }

    /**
     * One ingest path for BOTH sources (gallery URI stream, camera cache
     * file): decode bounds → PhotoPipeline sample → decode → JPEG budget →
     * data URI. Behavior-identical to the v2.0.0 picker loop, now shared.
     */
    private fun ingestImage(openStream: (boundsOnly: Boolean) -> InputStream?) {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            openStream(true)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = PhotoPipeline.targetSample(bounds.outWidth, bounds.outHeight)
            }
            val bitmap = openStream(false)?.use { BitmapFactory.decodeStream(it, null, opts) }
            if (bitmap == null) return
            val bytes = PhotoPipeline.compressWithinBudget(bitmap)
            if (bytes == null) {
                Toast.makeText(requireContext(), R.string.report_photo_too_big, Toast.LENGTH_LONG).show()
                return
            }
            imageDataUri = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
            photoLine?.text = getString(R.string.report_photo_attached_fmt, bytes.size / 1024)
            photoLine?.visibility = View.VISIBLE
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
        photoLine = null
        queueLine = null
        submitButton = null
        severityButtons.clear()
        super.onDestroyView()
    }
}
