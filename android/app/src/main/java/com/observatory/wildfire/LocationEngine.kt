package com.observatory.wildfire

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.CopyOnWriteArrayList

/**
 * v2.0.0 (native UI) — the app's single owner of GPS. THE fix for the field
 * report "تحديد الموقع لا يشتغل": instead of a WebView origin-gated browser
 * prompt the user could never see, the app now talks to LocationManager
 * directly, on BOTH providers (GPS + network), and every state it can be in
 * is one of the four honest statuses LocationLogic.computeStatus() computes —
 * the UI explains WHY there is no fix instead of silently doing nothing.
 *
 * Lifecycle: started/stopped by NativeMainActivity onStart/onStop. The team
 * FGS (TeamLocationService) keeps its OWN independent stream — this engine is
 * only for the visible screens, so leaving the app does not keep it alive.
 *
 * MIUI note: providers off is a Settings toggle the app cannot flip; the UI
 * offers a deep link to the location settings panel for exactly that case.
 */
class LocationEngine(private val context: Context) : LocationListener {

    companion object {
        private const val TAG = "LocationEngine"
        private const val REQUEST_INTERVAL_MS = 2_000L
        private const val REQUEST_DISTANCE_M = 1f
        /** UI re-check cadence while SEARCHING (so status transitions appear). */
        private const val STATUS_POLL_MS = 3_000L
    }

    data class State(val status: LocationLogic.Status, val fix: LocationLogic.FixSnapshot?)

    private val mainHandler = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<(State) -> Unit>()
    private var lm: LocationManager? = null
    private var running = false
    private var lastFix: LocationLogic.FixSnapshot? = null
    private var lastNotifiedStatus: LocationLogic.Status? = null
    private val statusPoller = object : Runnable {
        override fun run() {
            if (!running) return
            publish(compute())
            mainHandler.postDelayed(this, STATUS_POLL_MS)
        }
    }

    fun hasPermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    fun addListener(listener: (State) -> Unit) {
        listeners.add(listener)
        // Late joiners get the current state immediately (fragment re-entry).
        listener(State(compute(), currentFix()))
    }

    fun removeListener(listener: (State) -> Unit) {
        listeners.remove(listener)
    }

    fun currentFix(): LocationLogic.FixSnapshot? = lastFix

    fun start() {
        if (running) return
        running = true
        lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        publish(compute())
        registerProviders()
        mainHandler.post(statusPoller)
    }

    fun stop() {
        running = false
        mainHandler.removeCallbacks(statusPoller)
        try {
            lm?.removeUpdates(this)
        } catch (e: Exception) {
            Log.w(TAG, "removeUpdates", e)
        }
    }

    /** Called after the user grants the permission — restart the stream. */
    fun onPermissionGranted() {
        if (!running) start() else {
            publish(compute())
            registerProviders()
        }
    }

    private fun gpsEnabled(): Boolean = try {
        lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true
    } catch (e: Exception) {
        false
    }

    private fun networkEnabled(): Boolean = try {
        lm?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true
    } catch (e: Exception) {
        false
    }

    private fun compute(): LocationLogic.Status {
        val ageMs = lastFix?.let { System.currentTimeMillis() - it.timeMs }
        return LocationLogic.computeStatus(
            permissionGranted = hasPermission(),
            gpsEnabled = gpsEnabled(),
            networkEnabled = networkEnabled(),
            lastFixAgeMs = ageMs
        )
    }

    private fun registerProviders() {
        val manager = lm ?: return
        if (!hasPermission()) return
        val looper = Looper.getMainLooper()
        try {
            if (manager.allProviders.contains(LocationManager.GPS_PROVIDER)) {
                manager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, REQUEST_INTERVAL_MS, REQUEST_DISTANCE_M, this, looper
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "GPS provider register failed", e)
        }
        try {
            if (manager.allProviders.contains(LocationManager.NETWORK_PROVIDER)) {
                manager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, REQUEST_INTERVAL_MS, REQUEST_DISTANCE_M, this, looper
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Network provider register failed", e)
        }
        // Seed from lastKnownLocation across providers so the map/SOS have
        // something honest (with its real age) within the first second.
        val seeds = ArrayList<LocationLogic.FixSnapshot>(2)
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            try {
                if (!manager.allProviders.contains(provider)) continue
                val loc: Location? = manager.getLastKnownLocation(provider)
                if (loc != null) seeds.add(toSnapshot(loc))
            } catch (e: SecurityException) {
                // permission revoked mid-flight — the status poller will show it
            } catch (e: Exception) {
                Log.w(TAG, "lastKnown($provider) failed", e)
            }
        }
        LocationLogic.chooseBest(seeds, System.currentTimeMillis())?.let { seed ->
            if (lastFix == null || seed.timeMs > lastFix!!.timeMs) {
                lastFix = seed
                publish(compute())
            }
        }
    }

    override fun onLocationChanged(location: Location) {
        if (!location.latitude.isFinite() || !location.longitude.isFinite()) return
        val snapshot = toSnapshot(location)
        val current = lastFix
        // Accept if fresher, or if the current fix is old and this one exists.
        if (current == null || snapshot.timeMs >= current.timeMs) {
            lastFix = snapshot
        }
        publish(compute())
    }

    @Deprecated("Needed for API < 31 compat; no-op — onLocationChanged covers fixes")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) {
        publish(compute())
        registerProviders()
    }

    override fun onProviderDisabled(provider: String) {
        publish(compute())
    }

    private fun toSnapshot(loc: Location) = LocationLogic.FixSnapshot(
        lat = loc.latitude,
        lng = loc.longitude,
        accuracyM = if (loc.hasAccuracy()) loc.accuracy else 0f,
        timeMs = loc.time,
        provider = loc.provider ?: "unknown"
    )

    private fun publish(state: LocationLogic.Status) {
        // Notify when the status changed OR a fresh fix arrived (map follows).
        if (state == lastNotifiedStatus && state != LocationLogic.Status.FIXED) return
        lastNotifiedStatus = state
        val payload = State(state, lastFix)
        for (l in listeners) {
            try {
                l(payload)
            } catch (e: Exception) {
                Log.w(TAG, "listener threw", e)
            }
        }
    }
}
