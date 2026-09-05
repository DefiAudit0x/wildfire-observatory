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

    data class State(
        val status: LocationLogic.Status,
        val fix: LocationLogic.FixSnapshot?,
        /** v2.16.0: the active permission tier — the UI can distinguish a
         *  precise fix from a coarse-only one without re-querying perms. */
        val tier: LocationLogic.Tier = LocationLogic.Tier.NONE
    )

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

    /** Precise-location grant (the historical hasPermission). */
    fun hasPermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    /** Approximate-location grant (Android 12+ "approximate only"). */
    fun hasCoarsePermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_COARSE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    /** Any usable location grant — coarse-only users get a WORKING engine. */
    fun hasAnyLocationPermission(): Boolean = hasPermission() || hasCoarsePermission()

    /** v2.16.0: the active permission tier (NONE / COARSE / FINE). */
    fun permissionTier(): LocationLogic.Tier = when {
        hasPermission() -> LocationLogic.Tier.FINE
        hasCoarsePermission() -> LocationLogic.Tier.COARSE
        else -> LocationLogic.Tier.NONE
    }

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
            permissionTier = permissionTier(),
            gpsEnabled = gpsEnabled(),
            networkEnabled = networkEnabled(),
            lastFixAgeMs = ageMs
        )
    }

    private fun registerProviders() {
        val manager = lm ?: return
        // v2.16.0 (permission tier): coarse-only users get the NETWORK
        // provider (an approximate fix beats no fix — and beats a lying
        // "grant permission" screen); requesting GPS_PROVIDER updates with
        // only ACCESS_COARSE_LOCATION throws on API 31+, so GPS is
        // FINE-tier exclusively. The PASSIVE seed inherits the caller's
        // grant and stays FINE-tier too for the same reason.
        val tier = permissionTier()
        if (tier == LocationLogic.Tier.NONE) return
        val looper = Looper.getMainLooper()
        if (tier == LocationLogic.Tier.FINE) {
            try {
                if (manager.allProviders.contains(LocationManager.GPS_PROVIDER)) {
                    manager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER, REQUEST_INTERVAL_MS, REQUEST_DISTANCE_M, this, looper
                    )
                }
            } catch (e: Exception) {
                Log.w(TAG, "GPS provider register failed", e)
            }
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
        val seedProviders = if (tier == LocationLogic.Tier.FINE) {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER)
        }
        val seeds = ArrayList<LocationLogic.FixSnapshot>(seedProviders.size)
        for (provider in seedProviders) {
            try {
                if (!manager.allProviders.contains(provider)) continue
                val loc: Location? = manager.getLastKnownLocation(provider)
                if (loc != null) seeds.add(toSnapshot(loc, tier))
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
        val snapshot = toSnapshot(location, permissionTier())
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

    private fun toSnapshot(loc: Location, tier: LocationLogic.Tier) = LocationLogic.FixSnapshot(
        lat = loc.latitude,
        lng = loc.longitude,
        accuracyM = if (loc.hasAccuracy()) loc.accuracy else 0f,
        timeMs = loc.time,
        provider = loc.provider ?: "unknown",
        approximate = tier == LocationLogic.Tier.COARSE,
        bearingDeg = if (loc.hasBearing()) loc.bearing.toDouble() else null
    )

    private fun publish(state: LocationLogic.Status) {
        // Notify when the status changed OR a fresh fix arrived (map follows).
        if (state == lastNotifiedStatus && state != LocationLogic.Status.FIXED) return
        lastNotifiedStatus = state
        val payload = State(state, lastFix, permissionTier())
        for (l in listeners) {
            try {
                l(payload)
            } catch (e: Exception) {
                Log.w(TAG, "listener threw", e)
            }
        }
    }
}
