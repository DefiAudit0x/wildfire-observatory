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
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
        }

        // PWA URL — change to your deployment URL
        private const val APP_URL = "https://wildfire-observatory-production.up.railway.app"
    }

    private var meshService: MeshService? = null
    private var meshBound = false
    private var meshInitialized = false
    private var meshBindingInProgress = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeNetworks = ConcurrentHashMap.newKeySet<Network>()
    private var rebindRunnable: Runnable? = null
    private var rebindAttempt = 0

    // Audit round 11: the message listener added on bind is KEPT as a field so
    // onDestroy can remove THAT EXACT instance. The old code called
    // removeMessageListener { } — a fresh lambda that could never match the
    // registered one — leaking the listener (and its activity reference) on
    // every unbind.
    private var meshMessageListener: ((String) -> Unit)? = null

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
                runOnUiThread {
                    val messageJs = JSONObject.quote(message)
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('meshMessage', { detail: $messageJs }));", null
                    )
                }
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
            dispatchMeshState("disconnected")
            scheduleMeshRebind()
        }
    }

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
        }
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
        if (meshBound || meshBindingInProgress) {
            meshMessageListener?.let { meshService?.removeMessageListener(it) }
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
        if (host == "wildfire-observatory-production.up.railway.app") return scheme == "https"
        return host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
    }

    private fun setupWebView() {
        webView = WebView(this)
        setContentView(webView)

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
            mediaPlaybackRequiresUserGesture = false
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
                if (isDebuggable && error?.primaryError == SslError.SSL_IDMISMATCH) {
                    handler?.proceed()
                } else {
                    handler?.cancel()
                    Toast.makeText(this@MainActivity, "Secure connection error. Using a secure URL is required.", Toast.LENGTH_LONG).show()
                }
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
                    capabilityProvider = { hasMeshRuntimeCapability() }
            ),
            "AndroidBridge"
        )

        // Install the progress observer before starting navigation so a fast
        // load cannot finish before the bridge injection callback exists.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress == 100) {
                    injectMeshBridge()
                }
            }
        }

        // Load PWA after all WebView callbacks are installed.
        webView.loadUrl(APP_URL)
    }

    private fun injectMeshBridge() {
        val deviceIdJs = JSONObject.quote(stableDeviceId())
        val js = """
        (function() {
            if (window.__meshBridgeInjected) return;
            window.__meshBridgeInjected = true;
            window.__meshServiceState = window.__meshServiceState || { state: 'unknown', ready: false };
            window.dispatchEvent(new CustomEvent('meshReady', {
                detail: { deviceId: $deviceIdJs }
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
        return try {
            val bound = bindService(intent, meshConnection, Context.BIND_AUTO_CREATE)
            if (!bound) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            bound
        } catch (e: Exception) {
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

    private fun dispatchMeshState(state: String) {
        if (!::webView.isInitialized) return
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
                    .setNegativeButton("Exit") { _, _ -> finish() }
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
}
