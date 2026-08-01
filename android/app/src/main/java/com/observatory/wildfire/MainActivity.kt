package com.observatory.wildfire

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERMISSION_REQUEST_CODE = 1001
        private val REQUIRED_PERMISSIONS = mutableListOf(
            Manifest.permission.BLUETOOTH,
            Manifest.permission.BLUETOOTH_ADMIN,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_ADVERTISE)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        // PWA URL — change to your deployment URL
        private const val APP_URL = "https://wildfire-observatory-production.up.railway.app"
    }

    private var meshService: MeshService? = null
    private var meshBound = false

    private val meshConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as MeshService.LocalBinder
            meshService = binder.getService()
            meshBound = true

            // Forward received mesh messages to WebView
            meshService?.addMessageListener { message ->
                runOnUiThread {
                    webView.evaluateJavascript(
                        """
                        (function() {
                            var event = new CustomEvent('meshMessage', { detail: $message });
                            window.dispatchEvent(event);
                        })();
                        """.trimIndent(), null
                    )
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            meshBound = false
            meshService = null
        }
    }

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        checkPermissions()
        setupWebView()
        bindMeshService()

        // Monitor connectivity for offline detection
        registerConnectivityMonitor()
    }

    override fun onDestroy() {
        if (meshBound) {
            meshService?.removeMessageListener { }
            unbindService(meshConnection)
        }
        super.onDestroy()
    }

    private fun setupWebView() {
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            setAppCacheEnabled(true)
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.proceed()  // Allow self-signed certs in emergency
            }
        }

        // Expose JS bridge
        webView.addJavascriptInterface(
            WebAppInterface(meshService ?: MeshService()),
            "AndroidBridge"
        )

        // Load PWA
        webView.loadUrl(APP_URL)

        // Inject mesh config on page load
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress == 100) {
                    injectMeshBridge()
                }
            }
        }
    }

    private fun injectMeshBridge() {
        val js = """
        (function() {
            // Signal to web layer that mesh is available
            window.dispatchEvent(new CustomEvent('meshReady', { 
                detail: { deviceId: '${meshService?.getEphemeralId() ?: ""}' } 
            }));
            
            // Listen for incoming messages from MeshService
            var originalOnMessage = window.onMeshMessage;
            window.addEventListener('meshMessage', function(e) {
                if (originalOnMessage) originalOnMessage(e.detail);
            });
        })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun bindMeshService() {
        val intent = Intent(this, MeshService::class.java)
        bindService(intent, meshConnection, Context.BIND_AUTO_CREATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ========================
    // PERMISSIONS
    // ========================

    private fun checkPermissions() {
        val needed = REQUIRED_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (needed.isNotEmpty()) {
            if (needsRationale(needed)) {
                AlertDialog.Builder(this)
                    .setTitle("Permissions Required")
                    .setMessage("Bluetooth mesh networking requires Location + Bluetooth permissions for emergency peer-to-peer communication.")
                    .setPositiveButton("Grant") { _, _ ->
                        ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CODE)
                    }
                    .setNegativeButton("Exit") { _, _ -> finish() }
                    .show()
            } else {
                ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CODE)
            }
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
            }
        }
    }

    // ========================
    // OFFLINE DETECTION
    // ========================

    private fun registerConnectivityMonitor() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new Event('online'));", null
                    )
                }
            }

            override fun onLost(network: Network) {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new Event('offline'));", null
                    )
                }
            }
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(request, callback)
    }
}
