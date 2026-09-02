package com.observatory.wildfire

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERMISSION_REQUEST_CODE = 1001
        private val REQUIRED_PERMISSIONS = buildList {
            // These are mesh prerequisites only. Notification permission is
            // optional for the PWA and must not prevent WebView startup.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH)
                add(Manifest.permission.BLUETOOTH_ADMIN)
                add(Manifest.permission.ACCESS_FINE_LOCATION)
                add(Manifest.permission.ACCESS_COARSE_LOCATION)
            } else {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_ADVERTISE)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            // Nearby Connections P2P_CLUSTER may use Wi-Fi transports on
            // Android 13+, so keep this permission coupled to mesh startup.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
            // v1.0.4: the WebView's getUserMedia({audio}) — the SOS voice
            // message — needs RECORD_AUDIO at the OS level BEFORE the
            // WebChromeClient can grant a WebView PermissionRequest. Without
            // this runtime grant the mic bridge could never work on any
            // device.
            add(Manifest.permission.RECORD_AUDIO)
        }

        // PWA URL — the deploy target is Render (free tier, owner-owned):
        // https://wildfire-observatory.onrender.com. History: this constant
        // was still pointing at the DEAD Fly origin through v1.0.1–v1.0.3 —
        // the v1.0.1 "migration" commit (PR #78) never actually landed on
        // this file, so the WebView kept loading a dead host (the UI the
        // owner saw was the PWA service worker's cached shell), the bridge
        // stayed inert because its origin gate expected the even-older
        // Railway host, and geolocation/mic/camera prompts were unreachable
        // for the same reason. v1.0.4 completes the migration for real: URL,
        // allow-list, bridge gate, FGS gate and the new WebChromeClient
        // permission bridge now ALL point at the same origin.
        private const val APP_URL = "https://wildfire-observatory.onrender.com"
    }

    private var meshService: MeshService? = null
    private var meshBound = false
    private var meshInitialized = false
    private var meshBindingInProgress = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeNetworks = ConcurrentHashMap.newKeySet<Network>()
    private var rebindRunnable: Runnable? = null
    private var rebindAttempt = 0
    private var bindingTimeoutRunnable: Runnable? = null
    private val meshUiQueue = ArrayDeque<String>()
    private var meshUiDrainScheduled = false
    private val meshUiQueueLock = Any()
    @Volatile
    private var rendererRecoveryInProgress = false

    // Audit round 11: the message listener added on bind is KEPT as a field so
    // onDestroy can remove THAT EXACT instance. The old code called
    // removeMessageListener { } — a fresh lambda that could never match the
    // registered one — leaking the listener (and its activity reference) on
    // every unbind.
    private var meshMessageListener: ((String) -> Unit)? = null

    // Phase 2: forwards TeamLocationService state changes into the WebView as
    // `teamTrackingState` CustomEvents (F3 adds the optional mission-JSON
    // payload). Kept as a field so onDestroy removes THE EXACT instance (same
    // leak lesson as meshMessageListener below).
    private var teamStateListener: ((String, String?) -> Unit)? = null

    // Audit round 11: the connectivity callback is kept as a field and
    // unregistered in onDestroy — the old code registered a fresh anonymous
    // callback per activity instance and never unregistered it, stacking a
    // duplicate network monitor (and duplicate 'online'/'offline' events)
    // per activity recreation.
    private var connectivityCallback: ConnectivityManager.NetworkCallback? = null

    /**
     * STABLE device identity (SharedPreferences-backed): survives app restarts
     * and is distinct from the rotating ephemeral mesh key. "Device ID" means
     * identity — server-side dedup (clientGeneratedId, heartbeat) depends on it.
     */
    private fun stableDeviceId(): String {
        val prefs = getSharedPreferences("observatory_identity", Context.MODE_PRIVATE)
        return prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }
            ?: UUID.randomUUID().toString().also {
                prefs.edit().putString("device_id", it).apply()
            }
    }

    private val meshConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? MeshService.LocalBinder
            if (binder == null) {
                meshBindingInProgress = false
                meshInitialized = false
                dispatchMeshState("failed")
                scheduleMeshRebind()
                return
            }
            meshBindingInProgress = false
            rebindAttempt = 0
            bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
            bindingTimeoutRunnable = null
            rebindRunnable?.let(mainHandler::removeCallbacks)
            rebindRunnable = null
            // Remove a previous listener before replacing the bound service
            // instance. This prevents listener accumulation across rebinds.
            meshMessageListener?.let { previous ->
                meshService?.removeMessageListener(previous)
            }
            meshService = binder.getService()
            meshBound = true
            meshInitialized = true

            // Forward received mesh messages to WebView (sanitized JSON string)
            val listener: (String) -> Unit = { message ->
                enqueueMeshUiMessage(message)
            }
            meshMessageListener = listener
            meshService?.addMessageListener(listener)
            dispatchMeshState("connected")
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            val oldService = meshService
            meshMessageListener?.let { oldService?.removeMessageListener(it) }
            meshMessageListener = null
            meshBound = false
            meshService = null
            meshInitialized = false
            meshBindingInProgress = false
            bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
            bindingTimeoutRunnable = null
            dispatchMeshState("disconnected")
            scheduleMeshRebind()
        }
    }

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // F13 (A7): the team-state forwarder is registered ONCE per activity —
        // setupWebView() also runs on renderer recovery, and registering there
        // stacked duplicate listeners (every state event dispatched twice per
        // recovery). The dispatch itself is renderer-agnostic (guarded on
        // webView initialization and re-reads the CURRENT webView), so this
        // listener safely outlives individual WebView instances and keeps the
        // panel in sync after every recovery too.
        val teamListener: (String, String?) -> Unit = { state, payload ->
            dispatchTeamTrackingState(state, payload)
        }
        teamStateListener = teamListener
        TeamLocationService.addStateListener(teamListener)

        // The PWA is useful even when optional mesh permissions are denied.
        // Create it before registering callbacks so network events cannot touch
        // an uninitialized WebView during the permission dialog.
        setupWebView()
        registerConnectivityMonitor()
        checkPermissions()
    }

    private fun initializeMesh() {
        if (meshInitialized || meshBindingInProgress) return
        meshBindingInProgress = true
        dispatchMeshState("starting")
        if (!bindMeshService()) {
            meshBindingInProgress = false
            meshInitialized = false
            dispatchMeshState("failed")
            scheduleMeshRebind()
        } else {
            scheduleBindingTimeout()
        }
    }

    private fun scheduleBindingTimeout() {
        bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
        val timeout = Runnable {
            bindingTimeoutRunnable = null
            if (!meshBindingInProgress) return@Runnable
            meshBindingInProgress = false
            meshInitialized = false
            try {
                unbindService(meshConnection)
            } catch (e: IllegalArgumentException) {
                // Binding was never established or was already released.
            }
            dispatchMeshState("failed")
            scheduleMeshRebind()
        }
        bindingTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, 10_000L)
    }

    private fun scheduleMeshRebind() {
        if (isFinishing || isDestroyed || rebindRunnable != null) return
        val retry = Runnable {
            rebindRunnable = null
            initializeMesh()
        }
        rebindRunnable = retry
        val delaysMs = longArrayOf(2_000L, 5_000L, 10_000L, 30_000L)
        val delay = delaysMs[rebindAttempt.coerceAtMost(delaysMs.lastIndex)]
        rebindAttempt++
        mainHandler.postDelayed(retry, delay)
    }

    override fun onDestroy() {
        // Phase 2: remove the EXACT team-state listener instance registered in
        // setupWebView — a fresh lambda would never match (leak lesson above).
        teamStateListener?.let { TeamLocationService.removeStateListener(it) }
        teamStateListener = null
        if (meshBound || meshBindingInProgress) {
            meshMessageListener?.let { meshService?.removeMessageListener(it) }
        synchronized(meshUiQueueLock) {
            meshUiQueue.clear()
            meshUiDrainScheduled = false
        }
            meshMessageListener = null
            try {
                unbindService(meshConnection)
            } catch (e: IllegalArgumentException) {
                // Binding was never established or was already released.
            }
        } else {
            meshMessageListener = null
        }
        // Audit round 11: unregister the network monitor — the old code left
        // it registered for the lifetime of the process, stacking duplicates
        // per activity recreation.
        connectivityCallback?.let { callback ->
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                    .unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                // Already unregistered or never registered
            }
        }
        connectivityCallback = null
        rebindRunnable?.let(mainHandler::removeCallbacks)
        rebindRunnable = null
        bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
        bindingTimeoutRunnable = null
        rebindAttempt = 0
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /**
     * Allow-list for WebView navigation (audit): mirrors WebAppInterface's
     * trusted-origin set. HTTPS required for the production host; the emulator
     * loopback hosts are allowed for local testing. Host matching is exact —
     * never a substring test.
     */
    private fun isAllowedAppUrl(url: String): Boolean {
        val scheme = url.substringBefore("://").lowercase()
        if (scheme != "https" && scheme != "http") return false
        val host = try {
            android.net.Uri.parse(url).host?.lowercase()
        } catch (e: Exception) {
            null
        } ?: return false
        if (host == "wildfire-observatory.onrender.com") return scheme == "https"
        // The dead Fly origin is deliberately NOT in the allow-list: expired-
        // trial subdomains can be re-registered by strangers, and this check
        // guards WebView navigation, the JS bridge and the geolocation/media
        // prompts — an exact match against a recycled host would leak trust.
        return host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
    }

    private fun setupWebView() {
        webView = WebView(this)
        setContentView(webView)

        // TargetSdk 36: edge-to-edge is ENFORCED (the opt-out attribute is
        // gone on Android 16, and status/navigation-bar colors in the theme
        // are ignored) — the WebView would draw under the system bars and
        // the RTL panel header would be unreachable behind the status bar.
        // We draw edge-to-edge deliberately and pad the WebView with the
        // real insets (system bars + display cutout + IME), which also
        // gives us keyboard-resize behavior consistently across API 26–36.
        // Re-registered on every setupWebView() call because renderer
        // recovery swaps the WebView instance (same listener-per-instance
        // lesson as the teamListener in onCreate).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val bars: Insets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    or WindowInsetsCompat.Type.displayCutout()
                    or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            // ARC-L25: restored the secure default (true). Autoplay was never
            // needed — SOS audio playback is user-initiated — and a WebView
            // that plays media without a gesture is a surprise cost.
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        webView.webViewClient = object : WebViewClient() {
            // Navigation policy (audit): keep the WebView on allow-listed
            // hosts ONLY. The PWA is a single-page app — every real "page
            // move" happens in-app via the history API, so external loads
            // (links, redirects, injected iframes escaping) are never needed.
            // This is the compensating control for the bridge's URL-at-call-
            // time origin check (see WebAppInterface header): with navigation
            // locked to our hosts, the URL the gate reads is always one we
            // chose.
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return true
                val allowed = isAllowedAppUrl(url)
                if (!allowed) {
                    Toast.makeText(
                        this@MainActivity,
                        "External navigation blocked (security policy).",
                        Toast.LENGTH_LONG
                    ).show()
                }
                return !allowed // true = handled here, WebView does NOT load it
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // NEVER bypass TLS in production. The bypass is scoped to
                // debuggable builds AND specifically to hostname-mismatch
                // errors (local emulator IPs): SSL_IDMISMATCH is NOT a
                // self-signed/untrusted-certificate case (those surface as
                // different primaryError values), and no other error type is
                // ever proceeded. Self-signed certs stay rejected even in
                // debug builds.
                val isDebuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
                val host = runCatching { Uri.parse(error?.url.orEmpty()).host?.lowercase() }.getOrNull()
                val isTrustedLocalHost = host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
                if (isDebuggable && isTrustedLocalHost && error?.primaryError == SslError.SSL_IDMISMATCH) {
                    handler?.proceed()
                } else {
                    handler?.cancel()
                    Toast.makeText(this@MainActivity, "Secure connection error. Using a secure URL is required.", Toast.LENGTH_LONG).show()
                }
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val crashedView = view ?: return true
                if (crashedView !== webView) return true
                if (rendererRecoveryInProgress || isFinishing || isDestroyed) return true
                rendererRecoveryInProgress = true
                mainHandler.post {
                    try {
                        if (!isFinishing && !isDestroyed) {
                            crashedView.stopLoading()
                            crashedView.destroy()
                            setupWebView()
                            dispatchMeshState(if (meshService != null) "connected" else "unavailable")
                        }
                    } catch (e: Exception) {
                        Log.e("MainActivity", "WebView renderer recovery failed", e)
                        dispatchMeshState("failed")
                    } finally {
                        rendererRecoveryInProgress = false
                    }
                }
                return true
            }
        }

        // Expose JS bridge — the bound MeshService instance is resolved lazily so
        // the same bridge handles the service even after the async bind completes.
        // The bridge only answers while the main frame is on our trusted origin:
        // if the WebView is ever navigated elsewhere, the native surface goes inert.
        webView.addJavascriptInterface(
            WebAppInterface(
                meshProvider = { meshService },
                urlProvider = { webView.url ?: "" },
                deviceIdProvider = { stableDeviceId() },
                    capabilityProvider = { hasMeshRuntimeCapability() },
                appContext = applicationContext
            ),
            "AndroidBridge"
        )

        // Mirror the team-tracking FGS state into the WebView. F13 (A7): the
        // listener itself is registered ONCE in onCreate — this comment marks
        // the deliberate absence of a registration here, because setupWebView
        // also runs on renderer recovery and would stack duplicates.
        // The service outlives the WebView; the panel re-syncs from events
        // after every renderer recovery via the single onCreate listener.

        // Install the progress observer before starting navigation so a fast
        // load cannot finish before the bridge injection callback exists.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress == 100) {
                    injectMeshBridge()
                }
            }

            // v1.0.4 — the missing half of the permission story: the OS grants
            // the APP camera/location/mic, but a WebView page asks the
            // WebChromeClient, not the OS. These overrides never existed, so
            // navigator.geolocation was permanently denied (no report could
            // be filed, SOS could not locate the user, radar had no center)
            // and getUserMedia was dead (SOS voice recording could never
            // start). Both gates reuse isAllowedAppUrl — a prompt can only be
            // granted on the same trusted origin that may navigate at all.
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                val originAllowed = origin != null && isAllowedAppUrl(origin)
                val locationGranted = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                callback?.invoke(origin, originAllowed && locationGranted, false)
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                val origin = request?.origin?.toString()
                val originAllowed = origin != null && isAllowedAppUrl(origin)
                val resources = request?.resources.orEmpty()
                val wantsAudio = resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                val wantsVideo = resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                val audioOk = !wantsAudio || ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                val videoOk = !wantsVideo || ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.CAMERA
                ) == PackageManager.PERMISSION_GRANTED
                if (originAllowed && (wantsAudio || wantsVideo) && audioOk && videoOk) {
                    request.grant(resources)
                } else {
                    request?.deny()
                }
            }
        }

        // Load PWA after all WebView callbacks are installed.
        webView.loadUrl(APP_URL)
    }

    /**
     * ARC-L25: the hardware/system back button used to exit the app even when
     * the WebView had internal history to pop (the PWA is SPA + history API,
     * so users lose in-app state on a stray back press). Back now navigates
     * the WebView when it can; only at the SPA root does it exit as before.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun injectMeshBridge() {
        val deviceIdJs = JSONObject.quote(stableDeviceId())
        val js = """
        (function() {
            if (window.__meshBridgeInjected) return;
            window.__meshBridgeInjected = true;
            window.__meshServiceState = window.__meshServiceState || { state: 'unknown', ready: false };
            window.dispatchEvent(new CustomEvent('meshReady', {
                detail: Object.assign({ deviceId: $deviceIdJs }, window.__meshServiceState)
            }));
            window.addEventListener('meshMessage', function(e) {
                const handler = window.onMeshMessage;
                if (handler) handler(e.detail);
            });
        })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun bindMeshService(): Boolean {
        val intent = Intent(this, MeshService::class.java)
        var bound = false
        return try {
            bound = bindService(intent, meshConnection, Context.BIND_AUTO_CREATE)
            if (!bound) return false
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
                true
            } catch (e: Exception) {
                try {
                    unbindService(meshConnection)
                } catch (unbindError: IllegalArgumentException) {
                    // Binding was already released or never established.
                }
                Log.e("MainActivity", "Unable to start MeshService", e)
                false
            }
        } catch (e: Exception) {
            if (bound) {
                try {
                    unbindService(meshConnection)
                } catch (unbindError: IllegalArgumentException) {
                    // Binding was already released or never established.
                }
            }
            Log.e("MainActivity", "Unable to bind MeshService", e)
            false
        }
    }

    // ========================
    // PERMISSIONS
    // ========================

    private fun hasMeshRuntimeCapability(): Boolean {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false
        val bluetoothReady = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
                (getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true)
        } else {
            (getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true)
        }
        return bluetoothReady && REQUIRED_PERMISSIONS.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        } && meshBound && meshService != null
    }

    private fun enqueueMeshUiMessage(message: String) {
        synchronized(meshUiQueueLock) {
            if (meshUiQueue.size >= 100) meshUiQueue.removeFirst()
            meshUiQueue.addLast(message)
            if (meshUiDrainScheduled) return
            meshUiDrainScheduled = true
        }
        mainHandler.post(::drainMeshUiQueue)
    }

    private fun drainMeshUiQueue() {
        if (isFinishing || isDestroyed || !::webView.isInitialized) {
            synchronized(meshUiQueueLock) {
                meshUiQueue.clear()
                meshUiDrainScheduled = false
            }
            return
        }
        repeat(25) {
            val message = synchronized(meshUiQueueLock) {
                if (meshUiQueue.isEmpty()) null else meshUiQueue.removeFirst()
            } ?: return@repeat
            val messageJs = JSONObject.quote(message)
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('meshMessage', { detail: $messageJs }));", null
            )
        }
        synchronized(meshUiQueueLock) {
            if (meshUiQueue.isEmpty()) {
                meshUiDrainScheduled = false
            } else {
                mainHandler.post(::drainMeshUiQueue)
            }
        }
    }

    private fun dispatchMeshState(state: String) {
        if (isFinishing || isDestroyed || !::webView.isInitialized) return
        val escaped = JSONObject.quote(state)
        val ready = state == "connected"
        runOnUiThread {
            val js = """
                (function() {
                    const detail = { state: $escaped, ready: $ready };
                    window.__meshServiceState = detail;
                    window.__meshReady = $ready;
                    window.dispatchEvent(new CustomEvent('meshServiceState', { detail }));
                    if ($ready) window.dispatchEvent(new CustomEvent('meshReady', { detail }));
                })();
            """.trimIndent()
            webView.evaluateJavascript(js, null)
        }
    }

    private fun checkPermissions() {
        val needed = REQUIRED_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (needed.isNotEmpty()) {
            if (needsRationale(needed)) {
                AlertDialog.Builder(this)
                    .setTitle("Permissions Required")
                    .setMessage(
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            "Bluetooth and nearby-device permissions are required for emergency peer-to-peer communication."
                        } else {
                            "Location and Bluetooth permissions are required for emergency peer-to-peer communication."
                        }
                    )
                    .setPositiveButton("Grant") { _, _ ->
                        ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CODE)
                    }
                    .setNegativeButton("Continue without Mesh") { _, _ ->
                        dispatchMeshState("unavailable")
                    }
                    .show()
            } else {
                ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CODE)
            }
        } else {
            // All permissions already granted — initialize mesh immediately.
            initializeMesh()
        }
    }

    private fun needsRationale(permissions: List<String>): Boolean {
        return permissions.any { ActivityCompat.shouldShowRequestPermissionRationale(this, it) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST_CODE) {
            val denied = permissions.filterIndexed { i, _ -> grantResults[i] != PackageManager.PERMISSION_GRANTED }
            if (denied.isNotEmpty()) {
                Toast.makeText(this, "Mesh networking disabled: ${denied.size} permission(s) denied", Toast.LENGTH_LONG).show()
                dispatchMeshState("unavailable")
            } else {
                // All mesh permissions granted — initialize mesh now.
                initializeMesh()
            }
        }
    }

    // ========================
    // OFFLINE DETECTION
    // ========================

    private fun registerConnectivityMonitor() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (connectivityCallback != null) return // only one monitor per activity
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                activeNetworks.add(network)
                dispatchConnectivityState(activeNetworks.isNotEmpty())
            }

            override fun onLost(network: Network) {
                activeNetworks.remove(network)
                dispatchConnectivityState(activeNetworks.isNotEmpty())
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            cm.registerNetworkCallback(request, callback)
            connectivityCallback = callback
            cm.activeNetwork?.let { network ->
                if (cm.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) {
                    activeNetworks.add(network)
                }
            }
            dispatchConnectivityState(activeNetworks.isNotEmpty())
        } catch (e: Exception) {
            connectivityCallback = null
            activeNetworks.clear()
            Log.w("MainActivity", "Unable to register connectivity monitor", e)
            dispatchConnectivityState(false)
        }
    }

    private fun dispatchConnectivityState(online: Boolean) {
        if (!::webView.isInitialized) return
        val event = if (online) "online" else "offline"
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript("window.dispatchEvent(new Event('$event'));", null)
            }
        }
    }

    /**
     * Phase 2: forward a TeamLocationService state change (started / stopped /
     * revoked / error / beat) into the WebView. The panel never guesses the
     * native service's state — it asks isTeamTrackingActive() on mount and
     * listens for these events afterwards.
     *
     * F3/S5: for the "beat" state the optional payload is the RAW mission JSON
     * extracted from the server's heartbeat response. It crosses into the
     * WebView as a QUOTED string (JSONObject.quote) — the panel JSON.parses it
     * and re-normalizes it through its own field allow-list — never interpolated
     * as raw markup, so server-origin text cannot become executable content.
     */
    private fun dispatchTeamTrackingState(state: String, payload: String? = null) {
        if (!::webView.isInitialized) return
        val escapedState = JSONObject.quote(state)
        val payloadJs = if (payload != null) ", missionJson: ${JSONObject.quote(payload)}" else ""
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('teamTrackingState', { detail: { state: $escapedState$payloadJs } }));",
                    null
                )
            }
        }
    }
}
