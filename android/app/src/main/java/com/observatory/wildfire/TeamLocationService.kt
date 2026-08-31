package com.observatory.wildfire

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Phase 2 — team-member foreground location service (FGS type: location).
 *
 * Why a native service: the command map consumes 15s GPS heartbeats per
 * member, and Android SUSPENDS WebView JS timers the moment the app is
 * backgrounded or the screen turns off — a wildfire operation cannot depend
 * on the screen staying on. This service owns the GPS receiver and the beat
 * loop natively; the WebView panel hands it its config ONCE via the
 * origin-gated bridge and from then on merely mirrors its state events.
 *
 * Security posture (mirrors WebAppInterface/MainActivity doctrine):
 *  - The base URL is re-validated natively against TeamLocationLogic's
 *    allow-list; the bridge's word is never trusted.
 *  - The team token lives in memory ONLY — never prefs, never logs. It
 *    arrives with the start intent and dies with the process.
 *  - START_REDELIVER_INTENT: after a process kill the system re-delivers the
 *    start intent (config intact), the loop resumes, and the first 401
 *    verdict (expired 12h token) self-stops the service cleanly.
 *
 * Battery posture: FGS+location type keeps GPS/network available while the
 * screen is off; beats are server-paced (10–60s clamp); no wake lock — GPS
 * fixes themselves schedule the CPU, matching the mesh service's lesson that
 * a fixed 1s poll loop burns battery for nothing.
 */
class TeamLocationService : Service(), LocationListener {

    companion object {
        private const val TAG = "TeamLocationService"
        const val CHANNEL_ID = "team_tracking_channel"
        const val ACTION_START = "com.observatory.wildfire.action.TEAM_TRACKING_START"
        const val ACTION_STOP = "com.observatory.wildfire.action.TEAM_TRACKING_STOP"
        const val EXTRA_CONFIG = "config"
        private const val NOTIFICATION_ID = 2 // MeshService owns 1
        private const val MAX_RESPONSE_BYTES = 4096

        // State listeners are registered by MainActivity and forwarded into
        // the WebView as `teamTrackingState` CustomEvents. CopyOnWrite: the
        // service thread may emit while the main thread registers/unregisters.
        private val stateListeners = CopyOnWriteArrayList<(String) -> Unit>()

        fun addStateListener(listener: (String) -> Unit) {
            stateListeners.add(listener)
        }

        fun removeStateListener(listener: (String) -> Unit) {
            stateListeners.remove(listener)
        }

        private fun emitState(state: String) {
            for (listener in stateListeners) {
                try {
                    listener(state)
                } catch (e: Exception) {
                    Log.w(TAG, "state listener threw", e)
                }
            }
        }
    }

    // Config + latest fix live in atomics: the scheduler thread posts while
    // the main looper receives location updates. No shared monitor — the
    // MeshService god-monitor lesson (one `this` for three threads) stays out.
    private val config = AtomicReference<Config?>(null)
    private val latestFix = AtomicReference<Location?>(null)
    private val posting = AtomicBoolean(false)
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "team-location-beats").apply { isDaemon = false }
    }
    private var beatTask: ScheduledFuture<*>? = null
    private var waitingForFixNotified = false

    data class Config(
        val baseUrl: String,
        val token: String,
        val memberId: String,
        val teamId: String,
        val intervalMs: Long,
    )

    // ========================
    // LIFECYCLE
    // ========================

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val parsed = parseConfig(intent?.getStringExtra(EXTRA_CONFIG))
        if (parsed == null) {
            Log.w(TAG, "Team tracking start rejected: invalid config")
            emitState("error")
            stopSelf()
            return START_NOT_STICKY
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            // The bridge checks this too — this is the last-line defense.
            Log.w(TAG, "Team tracking start rejected: fine location not granted")
            emitState("error")
            stopSelf()
            return START_NOT_STICKY
        }

        config.set(parsed)
        createNotificationChannel()
        startInForeground()
        registerLocationUpdates(parsed.intervalMs)
        scheduleBeats(parsed.intervalMs)
        emitState("started")
        return START_REDELIVER_INTENT
    }

    override fun onDestroy() {
        beatTask?.cancel(false)
        beatTask = null
        scheduler.shutdownNow()
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        try {
            lm?.removeUpdates(this)
        } catch (e: Exception) {
            Log.w(TAG, "removeUpdates error", e)
        }
        latestFix.set(null)
        config.set(null)
        stopForeground(STOP_FOREGROUND_REMOVE)
        emitState("stopped")
        super.onDestroy()
    }

    // ========================
    // CONFIG
    // ========================

    private fun parseConfig(rawJson: String?): Config? {
        if (rawJson.isNullOrBlank()) return null
        return try {
            val json = JSONObject(rawJson)
            val baseUrl = json.optString("baseUrl", "")
            val token = json.optString("token", "")
            val memberId = json.optString("memberId", "")
            val teamId = json.optString("teamId", "")
            val intervalMs = json.optLong("intervalMs", TeamLocationLogic.DEFAULT_HEARTBEAT_MS)
            // Native re-validation of EVERY field — the bridge's origin gate
            // narrows who can call; these checks define what they may hand us.
            if (!TeamLocationLogic.isAllowedBaseUrl(baseUrl)) return null
            if (!TeamLocationLogic.isSaneToken(token)) return null
            if (!TeamLocationLogic.isValidMemberId(memberId)) return null
            if (!TeamLocationLogic.isValidTeamId(teamId)) return null
            Config(baseUrl, token, memberId, teamId, TeamLocationLogic.clampIntervalMs(intervalMs))
        } catch (e: Exception) {
            Log.w(TAG, "Config parse failed", e)
            null
        }
    }

    // ========================
    // LOCATION
    // ========================

    private fun registerLocationUpdates(intervalMs: Long) {
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        val looper = Looper.getMainLooper()
        // Two providers, each guarded: a device without network A-GPS must
        // still work on GPS and vice versa. minDistance 0 — the interval is
        // the only pacing knob (server owns the cadence via its response).
        try {
            if (lm.allProviders.contains(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalMs, 0f, this, looper)
            }
        } catch (e: Exception) {
            Log.w(TAG, "GPS provider unavailable", e)
        }
        try {
            if (lm.allProviders.contains(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, intervalMs, 0f, this, looper)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Network provider unavailable", e)
        }
    }

    override fun onLocationChanged(location: Location) {
        if (!location.hasAccuracy() || !location.latitude.isFinite() || !location.longitude.isFinite()) return
        // Copy: the framework mutates Location objects it hands around.
        latestFix.set(Location(location))
        if (waitingForFixNotified) {
            waitingForFixNotified = false
            updateNotification(notificationText(null))
        }
    }

    @Deprecated("Needed for API < 31 compat; no-op — onLocationChanged covers fixes")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    override fun onProviderEnabled(provider: String?) = Unit
    override fun onProviderDisabled(provider: String?) = Unit

    // ========================
    // BEATS
    // ========================

    private fun scheduleBeats(intervalMs: Long) {
        beatTask?.cancel(false)
        beatTask = scheduler.scheduleWithFixedDelay(
            { runBeat() },
            intervalMs,
            intervalMs,
            TimeUnit.MILLISECONDS
        )
    }

    /** One beat on the scheduler thread. Single-flight: overlaps are dropped. */
    private fun runBeat() {
        val cfg = config.get() ?: return
        if (posting.getAndSet(true)) return
        try {
            val fix = latestFix.get()
            if (fix == null) {
                if (!waitingForFixNotified) {
                    waitingForFixNotified = true
                    updateNotification(notificationText("waiting-gps"))
                }
                return
            }
            val body = TeamLocationLogic.buildHeartbeatBodyJson(
                lat = fix.latitude,
                lng = fix.longitude,
                accuracy = if (fix.hasAccuracy()) fix.accuracy.toDouble() else null,
                heading = if (fix.hasBearing()) fix.bearing.toDouble() else null,
                speed = if (fix.hasSpeed()) fix.speed.toDouble() else null,
                batteryPct = readBatteryPct(),
            )
            val http = URL(cfg.baseUrl + "/api/teams/heartbeat").openConnection() as HttpURLConnection
            try {
                http.requestMethod = "POST"
                http.connectTimeout = 10_000
                http.readTimeout = 10_000
                http.doOutput = true
                http.setRequestProperty("Content-Type", "application/json")
                http.setRequestProperty("Authorization", "Bearer ${cfg.token}")
                OutputStreamWriter(http.outputStream, StandardCharsets.UTF_8).use { it.write(body) }
                val status = http.responseCode
                val responseBody = readBody(http, status)
                when (TeamLocationLogic.classifyVerdict(status, responseBody)) {
                    TeamLocationLogic.Verdict.OK -> {
                        val serverInterval = TeamLocationLogic.parseHeartbeatIntervalMs(responseBody)
                        if (serverInterval != cfg.intervalMs) {
                            // Server re-paced the loop — follow it without
                            // tearing the service down.
                            config.set(cfg.copy(intervalMs = serverInterval))
                            scheduleBeats(serverInterval)
                        }
                    }
                    TeamLocationLogic.Verdict.RETRY -> Unit // next tick retries
                    TeamLocationLogic.Verdict.FATAL_REVOKED -> {
                        Log.w(TAG, "Beat verdict MEMBER_REVOKED — stopping team tracking")
                        emitState("revoked")
                        stopSelf()
                    }
                    else -> {
                        // AUTH / MEMBER / TEAM — session death per gate chain.
                        Log.w(TAG, "Beat fatal verdict (status=$status) — stopping team tracking")
                        emitState("error")
                        stopSelf()
                    }
                }
            } finally {
                http.disconnect()
            }
        } catch (e: Exception) {
            // Transport failure: retry next tick — never a session verdict.
            Log.w(TAG, "Beat transport failure", e)
        } finally {
            posting.set(false)
        }
    }

    /** Bounded body read: the response is server-controlled but still capped. */
    private fun readBody(http: HttpURLConnection, status: Int): String {
        val stream = try {
            if (status in 200..299) http.inputStream else http.errorStream ?: return ""
        } catch (e: Exception) {
            return ""
        }
        return try {
            val buffer = ByteArray(MAX_RESPONSE_BYTES + 1)
            var offset = 0
            while (offset < buffer.size) {
                val read = stream.read(buffer, offset, buffer.size - offset)
                if (read < 0) break
                offset += read
            }
            String(buffer, 0, minOf(offset, MAX_RESPONSE_BYTES), StandardCharsets.UTF_8)
        } catch (e: Exception) {
            ""
        } finally {
            try {
                stream.close()
            } catch (e: Exception) {
                // stream already closed
            }
        }
    }

    private fun readBatteryPct(): Int? {
        return try {
            val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
            val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            if (pct in 1..100) pct else null
        } catch (e: Exception) {
            null
        }
    }

    // ========================
    // NOTIFICATION
    // ========================

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "تتبع الفريق الميداني",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "نبضات موقع فريق الإطفاء أثناء المناوبة"
            setSound(null, null)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notificationText(state: String?): String = when (state) {
        "waiting-gps" -> "بانتظار إشارة GPS..."
        else -> "يتم إرسال موقعك إلى قيادة الحملة بشكل دوري"
    }

    private fun buildNotification(text: String): Notification {
        val stopIntent = PendingIntent.getService(
            this, 0,
            Intent(this, TeamLocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("تتبع الفريق نشط")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
        builder.addAction(
            Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                "إيقاف التتبع",
                stopIntent
            ).build()
        )
        return builder.build()
    }

    private fun startInForeground() {
        val notification = buildNotification(notificationText(null))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification(text))
        } catch (e: Exception) {
            Log.w(TAG, "Notification update failed", e)
        }
    }
}
