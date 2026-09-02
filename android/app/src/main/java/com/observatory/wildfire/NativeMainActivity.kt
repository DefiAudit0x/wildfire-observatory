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
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * v2.0.0 — PURE NATIVE shell. There is NO WebView in this app anymore, by the
 * owner's explicit direction ("تطبيق أندرويد خالص لا تغليف الموقع"). Every
 * screen is a native Fragment reading AppRepository/LocationEngine; the only
 * server dependency is data sync over HTTPS (same API the web console uses).
 *
 * What this activity owns:
 *  - bottom navigation (5 RTL tabs) + edge-to-edge insets (targetSdk 36 rule);
 *  - the permission ladder: location FIRST (the field-critical feature the
 *    last three versions could not deliver), then mesh transport, then mic
 *    lazily on first voice recording (SosFragment);
 *  - MeshService binding with the battle-tested rebind/backoff loop (ported
 *    from the WebView shell, now feeding AppRepository instead of JS events);
 *  - the connectivity monitor that wakes the offline queue.
 */
class NativeMainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "NativeMainActivity"
        private const val PERMISSION_REQUEST_CODE = 1001

        /** Location runtime permissions — requested FIRST, alone. */
        private val LOCATION_PERMISSIONS = listOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )

        /** Mesh transport permissions (BLE/Nearby) — requested after location. */
        private val MESH_PERMISSIONS = buildList {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH)
                add(Manifest.permission.BLUETOOTH_ADMIN)
            } else {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_ADVERTISE)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
        }

        /** Post-notification permission on T+ — visibility for the FGS notices. */
        private val NOTIFICATION_PERMISSIONS =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                listOf(Manifest.permission.POST_NOTIFICATIONS)
            } else emptyList()
    }

    private var meshService: MeshService? = null
    private var meshBound = false
    private var meshInitialized = false
    private var meshBindingInProgress = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeNetworks = java.util.concurrent.ConcurrentHashMap.newKeySet<Network>()
    private var rebindRunnable: Runnable? = null
    private var rebindAttempt = 0
    private var bindingTimeoutRunnable: Runnable? = null
    private var connectivityCallback: ConnectivityManager.NetworkCallback? = null

    private val meshConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? MeshService.LocalBinder
            if (binder == null) {
                meshBindingInProgress = false
                meshInitialized = false
                repo.attachMesh(null)
                scheduleMeshRebind()
                return
            }
            meshBindingInProgress = false
            rebindAttempt = 0
            bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
            bindingTimeoutRunnable = null
            rebindRunnable?.let(mainHandler::removeCallbacks)
            rebindRunnable = null
            meshService = binder.getService()
            meshBound = true
            meshInitialized = true
            // The repository owns the message listener (attachMesh removes it
            // from any previous instance first) — the activity never adds its
            // own, so a rebind can never double-deliver a mesh frame.
            repo.attachMesh(meshService)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            meshBound = false
            meshService = null
            meshInitialized = false
            meshBindingInProgress = false
            repo.attachMesh(null)
            bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
            bindingTimeoutRunnable = null
            scheduleMeshRebind()
        }
    }

    private val repo get() = (application as ObservatoryApp).repository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // targetSdk 36: edge-to-edge is enforced — draw full-bleed and pad the
        // root with real insets (bars + cutout + IME). Same contract the
        // WebView shell honored; now it pads the fragment container instead.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_native_main)
        val root = findViewById<View>(R.id.root_container)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars: Insets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    or WindowInsetsCompat.Type.displayCutout()
                    or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val nav = findViewById<BottomNavigationView>(R.id.bottom_nav)
        if (savedInstanceState == null) {
            switchTo(ObservatoryFragment())
            nav.selectedItemId = R.id.nav_observatory
        }
        nav.setOnItemSelectedListener { item ->
            val fragment: Fragment? = when (item.itemId) {
                R.id.nav_observatory -> ObservatoryFragment()
                R.id.nav_map -> MapFragment()
                R.id.nav_report -> ReportFragment()
                R.id.nav_sos -> SosFragment()
                R.id.nav_team -> TeamFragment()
                else -> null
            }
            if (fragment != null) {
                switchTo(fragment)
                true
            } else false
        }
        // Re-tapping the current tab keeps its state (a reselect must not
        // rebuild the fragment and wipe a half-written report/SOS form).
        nav.setOnItemReselectedListener { /* no-op */ }

        registerConnectivityMonitor()
        runPermissionLadder()
    }

    override fun onStart() {
        super.onStart()
        // Visible = own the GPS stream (LocationEngine kdoc contract). The
        // team FGS keeps its own independent stream in the background.
        if ((application as ObservatoryApp).locationEngine.hasPermission()) {
            (application as ObservatoryApp).locationEngine.start()
        }
    }

    override fun onStop() {
        (application as ObservatoryApp).locationEngine.stop()
        super.onStop()
    }

    private fun switchTo(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment)
            .commit()
    }

    /** From ObservatoryFragment's "عرض على الخريطة" banner action. */
    fun openMapTab() {
        findViewById<BottomNavigationView>(R.id.bottom_nav).selectedItemId = R.id.nav_map
    }

    // ========================
    // PERMISSION LADDER
    // ========================

    private fun runPermissionLadder() {
        val missingLocation = LOCATION_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missingLocation.isNotEmpty()) {
            permissionStage = 1
            AlertDialog.Builder(this)
                .setTitle(R.string.perm_location_title)
                .setMessage(R.string.perm_location_rationale)
                .setPositiveButton(R.string.perm_grant) { _, _ ->
                    ActivityCompat.requestPermissions(
                        this, missingLocation.toTypedArray(), PERMISSION_REQUEST_CODE
                    )
                }
                // "لاحقًا" must NOT kill the ladder: mesh permissions and the
                // mesh itself still come up — only location stays missing.
                .setNegativeButton(R.string.perm_later) { _, _ ->
                    permissionStage = 0
                    requestMeshPermissionsIfNeeded()
                }
                .show()
        } else {
            onLocationPermissionOutcome(granted = true)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != PERMISSION_REQUEST_CODE) return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        // Stage 1 = location, stage 2 = mesh, stage 3 = notifications.
        when (permissionStage) {
            1 -> onLocationPermissionOutcome(granted)
            2 -> onMeshPermissionOutcome(granted)
            else -> Unit
        }
    }

    private var permissionStage = 0

    private fun onLocationPermissionOutcome(granted: Boolean) {
        permissionStage = 0
        if (granted) {
            (application as ObservatoryApp).locationEngine.onPermissionGranted()
        } else {
            android.widget.Toast.makeText(
                this, R.string.perm_location_denied_hint, android.widget.Toast.LENGTH_LONG
            ).show()
        }
        // Mesh permissions come next regardless — location denial must not
        // take the offline mesh down with it.
        requestMeshPermissionsIfNeeded()
    }

    private fun requestMeshPermissionsIfNeeded() {
        val missing = MESH_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            onMeshPermissionOutcome(granted = true)
            return
        }
        permissionStage = 2
        ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSION_REQUEST_CODE)
    }

    private fun onMeshPermissionOutcome(granted: Boolean) {
        permissionStage = 0
        if (!granted) {
            android.widget.Toast.makeText(
                this, R.string.perm_mesh_denied_hint, android.widget.Toast.LENGTH_LONG
            ).show()
            repo.setMeshState("unavailable")
        } else {
            initializeMesh()
            requestNotificationPermissionIfNeeded()
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        val missing = NOTIFICATION_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            permissionStage = 3
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSION_REQUEST_CODE)
        }
    }

    /** Called by fragments when a lazily-granted permission lands (mic). */
    fun notifyPermissionGranted(permission: String) {
        // Location grants can arrive from Settings deep-links too.
        if (permission == Manifest.permission.ACCESS_FINE_LOCATION) {
            (application as ObservatoryApp).locationEngine.onPermissionGranted()
        }
    }

    // ========================
    // MESH BINDING (ported from the WebView shell)
    // ========================

    private fun initializeMesh() {
        if (meshInitialized || meshBindingInProgress) return
        meshBindingInProgress = true
        repo.setMeshState("starting")
        if (!bindMeshService()) {
            meshBindingInProgress = false
            meshInitialized = false
            repo.setMeshState("failed")
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
                // never bound / already released
            }
            repo.setMeshState("failed")
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
                    // already released
                }
                Log.e(TAG, "Unable to start MeshService", e)
                false
            }
        } catch (e: Exception) {
            if (bound) {
                try {
                    unbindService(meshConnection)
                } catch (unbindError: IllegalArgumentException) {
                    // already released
                }
            }
            Log.e(TAG, "Unable to bind MeshService", e)
            false
        }
    }

    // ========================
    // CONNECTIVITY
    // ========================

    private fun registerConnectivityMonitor() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                activeNetworks.add(network)
                repo.onConnectivityChanged(activeNetworks.isNotEmpty())
            }

            override fun onLost(network: Network) {
                activeNetworks.remove(network)
                repo.onConnectivityChanged(activeNetworks.isNotEmpty())
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            cm.registerNetworkCallback(request, callback)
            connectivityCallback = callback
            cm.activeNetwork?.let { network ->
                if (cm.getNetworkCapabilities(network)
                        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
                ) {
                    activeNetworks.add(network)
                }
            }
            repo.onConnectivityChanged(activeNetworks.isNotEmpty())
        } catch (e: Exception) {
            connectivityCallback = null
            activeNetworks.clear()
            Log.w(TAG, "Unable to register connectivity monitor", e)
            repo.onConnectivityChanged(false)
        }
    }

    override fun onDestroy() {
        connectivityCallback?.let { callback ->
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                    .unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                // already unregistered
            }
        }
        connectivityCallback = null
        if (meshBound || meshBindingInProgress) {
            try {
                unbindService(meshConnection)
            } catch (e: IllegalArgumentException) {
                // never bound
            }
        }
        repo.attachMesh(null)
        rebindRunnable?.let(mainHandler::removeCallbacks)
        rebindRunnable = null
        bindingTimeoutRunnable?.let(mainHandler::removeCallbacks)
        bindingTimeoutRunnable = null
        rebindAttempt = 0
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
