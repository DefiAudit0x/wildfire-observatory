package com.observatory.wildfire

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.Surface

/**
 * v2.19.0 — the app's single owner of the COMPASS heading, mirroring the
 * LocationEngine pattern (named listeners, honest states, lifecycle-safe).
 *
 * The v2.18.0 field verdict on the radar was "بدائي… لا يتحرك مع دوران
 * الهاتف". The root cause: NOTHING in the app read the rotation sensor for
 * the radar (the only SensorManager use was the camera stamp). This engine
 * feeds the radar (heading-up rose) and the map's user arrow with a smoothed
 * device azimuth:
 *
 *  - TYPE_ROTATION_VECTOR → rotation matrix → remap for the CURRENT screen
 *    rotation (the CameraCaptureFragment lesson: a portrait-locked azimuth
 *    lies in landscape) → getOrientation azimuth → bearing 0..360;
 *  - circular exponential smoothing (HeadingLogic) — raw sensor samples at
 *    sensor rate read as vibration on the radar card;
 *  - ~4 Hz cadence: plenty for a human-pace turn, cheap on battery;
 *  - NO_SENSOR is an honest state the UI may surface — never a fake value.
 *
 * Owned by the fragments that display it (created in onViewCreated, closed
 * in onDestroyView) — the compass costs nothing when no screen needs it.
 */
class HeadingEngine(private val context: Context) {

    data class State(
        /** Smoothed bearing 0..360, null when unavailable (no sensor / off). */
        val headingDeg: Double?,
        val sensorPresent: Boolean
    )

    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(State) -> Unit>()
    private var sensorManager: SensorManager? = null
    private var running = false
    private var smoothed: Double? = null
    private var lastSampleMs = 0L
    private var lastNotified: Double? = null
    private var sensorPresent = false

    companion object {
        /** ~4 Hz compass cadence (a 100 Hz rotation vector would burn battery). */
        private const val SAMPLE_INTERVAL_MS = 250L
        /** Circular smoothing factor — see HeadingLogic.smoothAngleDeg. */
        private const val SMOOTH_ALPHA = 0.25
        /** Skip UI churn below this degree change since the last publish. */
        private const val PUBLISH_MIN_DELTA_DEG = 1.0
    }

    private val rotationListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
            val now = System.currentTimeMillis()
            if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return
            lastSampleMs = now

            val rotation = FloatArray(9)
            SensorManager.getRotationMatrixFromVector(rotation, event.values)
            // Screen-rotation-aware remap (portrait/landscape) — the azimuth
            // must match what the user SEES on screen right now.
            val remapped = FloatArray(9)
            val (xAxis, yAxis) = remapAxes()
            if (!SensorManager.remapCoordinateSystem(rotation, xAxis, yAxis, remapped)) return
            val orientation = FloatArray(3)
            SensorManager.getOrientation(remapped, orientation)
            val raw = HeadingLogic.normalizeDeg(Math.toDegrees(orientation[0].toDouble()))

            val prev = smoothed
            smoothed = if (prev == null) raw else HeadingLogic.smoothAngleDeg(prev, raw, SMOOTH_ALPHA)
            publish()
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    /** Screen-rotation-aware axis remap (same contract as the camera HUD). */
    private fun remapAxes(): Pair<Int, Int> {
        val rotation = try {
            context.getSystemService(Context.WINDOW_SERVICE)?.let { wm ->
                (wm as android.view.WindowManager).defaultDisplay.rotation
            } ?: Surface.ROTATION_0
        } catch (e: Exception) {
            Surface.ROTATION_0
        }
        return when (rotation) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Z
        }
    }

    fun addListener(listener: (State) -> Unit) {
        listeners.add(listener)
        listener(State(smoothed, sensorPresent)) // late-join replay
    }

    fun removeListener(listener: (State) -> Unit) {
        listeners.remove(listener)
    }

    fun start() {
        if (running) return
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
        val sensor = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        sensorPresent = sensor != null
        if (sensor == null) {
            // Honest unavailability — listeners learn immediately, no fake.
            running = true
            publish(force = true)
            running = false
            return
        }
        running = true
        sensorManager = manager
        manager.registerListener(rotationListener, sensor, SensorManager.SENSOR_DELAY_UI)
        publish(force = true)
    }

    fun stop() {
        if (!running) return
        running = false
        try {
            sensorManager?.unregisterListener(rotationListener)
        } catch (e: Exception) {
            // unregister after the manager died is a no-op — never crash a pause
        }
        sensorManager = null
    }

    private fun publish(force: Boolean = false) {
        val value = smoothed
        if (!force) {
            val prev = lastNotified ?: value ?: return
            val cur = value ?: return
            if (Math.abs(HeadingLogic.angleDeltaDeg(prev, cur)) < PUBLISH_MIN_DELTA_DEG) return
        }
        lastNotified = value
        val payload = State(value, sensorPresent)
        for (l in listeners) {
            try {
                l(payload)
            } catch (e: Exception) {
                // a UI listener must never break the sensor loop
            }
        }
    }
}
