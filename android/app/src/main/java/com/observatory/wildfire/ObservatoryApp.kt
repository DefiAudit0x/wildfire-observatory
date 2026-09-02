package com.observatory.wildfire

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * v2.0.0 — process-wide singletons for the native app: one LocationEngine
 * (the GPS authority), one AppRepository (the data authority), one app scope.
 *
 * The production base URL lives here EXACTLY ONCE for the whole native app
 * (the v1.0.1–v1.0.3 incident happened because three trust surfaces each
 * carried their own copy of the host). TeamLocationLogic.isAllowedBaseUrl
 * remains the independent native validator for the FGS.
 */
class ObservatoryApp : Application() {

    companion object {
        const val PRODUCTION_BASE_URL = "https://wildfire-observatory.onrender.com"

        lateinit var instance: ObservatoryApp
            private set
    }

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val api by lazy { ObservatoryApi(PRODUCTION_BASE_URL) }
    val repository by lazy { AppRepository(this, appScope, api, PRODUCTION_BASE_URL) }
    val locationEngine by lazy { LocationEngine(this) }

    /** STABLE device identity — survives restarts, distinct from the mesh's
     *  rotating ephemeral key. Server-side dedup depends on its stability. */
    val deviceId: String by lazy {
        val prefs = getSharedPreferences("observatory_identity", MODE_PRIVATE)
        prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }
            ?: java.util.UUID.randomUUID().toString().also {
                prefs.edit().putString("device_id", it).apply()
            }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        repository.start()
    }
}
