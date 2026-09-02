package com.observatory.wildfire

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
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
import java.io.File

/**
 * v2.2.0 — the in-app camera. This is the piece the whole report flow was
 * building toward: the field reporter taps "تصوير" and the camera opens
 * INSIDE the app — no system camera app hop, no gallery detour — following
 * the owner's directive ("غرضنا كامل هو فتح الكاميرا وتصوير").
 *
 * CameraX stack, lifecycle-safe by construction:
 *  - Preview bound to viewLifecycleOwner, torn down automatically;
 *  - one ImageCapture use case, shutter → cache file → Fragment Result API
 *    hands the absolute path back to ReportFragment (which owns ALL image
 *    processing through PhotoPipeline) → popBackStack. The report form sits
 *    untouched underneath (add + addToBackStack), so severity, description
 *    and the half-typed text survive the round trip;
 *  - runtime permission via ActivityResultContracts.RequestPermission —
 *    denial answers with the gallery fallback hint, never a dead screen;
 *  - front/back toggle rebinds the same two use cases.
 *
 * NOT in this class: compression, data URIs, retries — ReportFragment's
 * ingest path already does all of it; the camera only produces a file.
 */
class CameraCaptureFragment : Fragment() {

    companion object {
        /** Fragment Result API key — ReportFragment listens with its viewLifecycleOwner. */
        const val RESULT_KEY = "camera_capture"

        /** Bundle field: absolute path of the captured JPEG in cacheDir. */
        const val RESULT_CAPTURE_PATH = "capture_path"

        private const val CAPTURE_FILE_PREFIX = "report_capture_"
    }

    private var previewView: PreviewView? = null
    private var imageCapture: ImageCapture? = null
    private var facing = CameraSelector.LENS_FACING_BACK
    private var captureInFlight = false

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
        view.findViewById<View>(R.id.camera_shutter).setOnClickListener { takePhoto() }
        view.findViewById<View>(R.id.camera_flip).setOnClickListener { toggleFacing() }
        view.findViewById<View>(R.id.camera_close).setOnClickListener { popBack() }

        if (ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            bindCamera()
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
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
        val file = File(requireContext().cacheDir, "$CAPTURE_FILE_PREFIX${System.currentTimeMillis()}.jpg")
        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(
            options,
            ContextCompat.getMainExecutor(requireContext()),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    deliver(file)
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

    /** Hand the file path to ReportFragment via Fragment Result API, then leave. */
    private fun deliver(file: File) {
        parentFragmentManager.setFragmentResult(
            RESULT_KEY,
            Bundle().apply { putString(RESULT_CAPTURE_PATH, file.absolutePath) }
        )
        popBack()
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
        previewView = null
        imageCapture = null
        super.onDestroyView()
    }
}
