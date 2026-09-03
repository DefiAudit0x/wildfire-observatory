package com.observatory.wildfire

import android.os.Bundle
import android.preference.PreferenceManager
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.XYTileSource
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline

/**
 * v2.1.0 — the field map, rescued from the "API KEY REQUIRED" disaster:
 * v2.0.0 rode CartoDarkMatter, and CARTO started serving anonymous clients
 * placeholder tiles stamped "API KEY REQUIRED" — the owner's device showed a
 * black map drowning in watermarks (the "prehistoric" verdict). Now standard
 * OpenStreetMap raster tiles: no key, no registration, valid UA below, and
 * the sqlite cache still keeps visited tiles offline. osmdroid's stock white
 * zoom buttons are hidden and replaced with styled in-layout controls.
 * Everything else from v2.0.0 stands: FIRMS hotspots, verified fires,
 * safezones, mesh intel, user marker, and the hybrid OSRM evacuation with
 * the per-vertex 2.5 km fire-corridor red warning.
 */
class MapFragment : Fragment() {

    companion object {
        // Same threshold the web SafeEvacuation uses (2.5 km corridor).
        private const val ROUTE_FIRE_WARNING_M = 2_500.0
        private const val DEFAULT_ZOOM = 11.0
    }

    private val app get() = requireActivity().application as ObservatoryApp

    private var map: MapView? = null
    private var statusText: TextView? = null
    private var routeButton: View? = null
    private var routeInfoText: TextView? = null
    private var userMarker: Marker? = null
    private var routeLine: Polyline? = null
    private var mapReady = false
    private var lastUserLatLng: Pair<Double, Double>? = null

    // F2: named listener so onDestroyView can deregister from the
    // application-scoped engine (an inline lambda leaked this view forever).
    private val locationListener: (LocationEngine.State) -> Unit = { state ->
        activity?.runOnUiThread {
            state.fix?.let { onFix(it) }
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_map, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        statusText = view.findViewById(R.id.map_status)
        routeButton = view.findViewById(R.id.route_button)
        routeInfoText = view.findViewById(R.id.route_info)

        // osmdroid session config: a descriptive UA (tile servers require one)
        // and app-private cache paths (no storage permission needed on 26+).
        val ctx = requireContext()
        Configuration.getInstance().apply {
            load(ctx, PreferenceManager.getDefaultSharedPreferences(ctx))
            userAgentValue = ObservatoryApi.USER_AGENT
            osmdroidBasePath = ctx.cacheDir.resolve("osmdroid")
            osmdroidTileCache = ctx.cacheDir.resolve("osmdroid/tiles")
        }

        val mv = view.findViewById<MapView>(R.id.map_view)
        map = mv
        mv.setTileSource(
            XYTileSource(
                "OpenStreetMap", 1, 19, 256, ".png",
                arrayOf("https://tile.openstreetmap.org/")
            )
        )
        // Stock white +/- squares belong to the stone age — styled controls
        // live in fragment_map.xml and call controller.zoomIn/zoomOut below.
        mv.zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
        view.findViewById<View>(R.id.zoom_in).setOnClickListener { mv.controller.zoomIn() }
        view.findViewById<View>(R.id.zoom_out).setOnClickListener { mv.controller.zoomOut() }
        mv.controller.setZoom(DEFAULT_ZOOM)
        // Cold start over Algiers until the first fix arrives.
        mv.controller.setCenter(GeoPoint(36.7538, 3.0588))
        mapReady = true

        // v2.1.1: if the server carries a CARTO basemap key (Render env
        // CARTO_BASEMAP_KEY → GET /api/config), upgrade the basemap to the
        // keyed voyager style (sunlight-readable, richer labels). Until a key
        // is confirmed live the app stays on keyless OSM above — the
        // watermark era can never return by default, key or no key.
        viewLifecycleOwner.lifecycleScope.launch {
            val key = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                when (val r = app.api.get("/api/config")) {
                    is ObservatoryApi.Result.Ok -> Parsers.parseCartoKey(r.body)
                    else -> null
                }
            }
            val mv2 = map ?: return@launch
            if (!isAdded || key.isNullOrEmpty()) return@launch
            // Key-derived source name: rotating the key starts a fresh
            // tile-cache namespace so watermarked responses from a dead-key
            // episode are never resurrected offline. The "-rt-" slot bumps the
            // namespace again for v2.1.2 (rastertiles/voyager path fix — the
            // v2.1.1 base URL lacked the style segment and 404'd every tile).
            mv2.setTileSource(
                XYTileSource(
                    "CartoVoyager-rt-${key.takeLast(6)}", 1, 19, 256, ".png?key=$key",
                    arrayOf("https://basemaps.cartocdn.com/rastertiles/voyager/")
                )
            )
            mv2.invalidate()
        }

        routeButton?.setOnClickListener { fetchEvacuationRoute() }

        app.locationEngine.addListener(locationListener)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap -> render(snap) }
            }
        }
    }

    private fun onFix(fix: LocationLogic.FixSnapshot) {
        val mv = map ?: return
        lastUserLatLng = fix.lat to fix.lng
        val point = GeoPoint(fix.lat, fix.lng)
        if (userMarker == null) {
            userMarker = Marker(mv).apply {
                position = point
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                title = getString(R.string.map_you_marker)
                icon = ContextCompat.getDrawable(requireContext(), R.drawable.ic_user_dot) ?: return@apply
                mv.overlays.add(this)
            }
        }
        userMarker?.position = point
        mv.controller.animateTo(point)
        statusText?.text = getString(R.string.map_status_fix_fmt, fix.accuracyM.toInt(), fix.provider)
    }

    private fun render(snap: AppRepository.Snapshot) {
        val mv = map ?: return
        if (!mapReady) return
        val now = System.currentTimeMillis()

        // Rebuild data overlays (keep user marker + route line).
        val keep = mv.overlays.filter { it === userMarker || it === routeLine }
        mv.overlays.clear()
        mv.overlays.addAll(keep)

        renderThreats(mv, snap, now)
        statusText?.text = if (snap.online) {
            getString(R.string.map_status_sync_fmt, snap.reports.size, snap.hotspots.size)
        } else {
            getString(R.string.map_status_offline_fmt, snap.reports.size, snap.hotspots.size)
        }
        mv.invalidate()
    }

    private fun renderThreats(mv: MapView, snap: AppRepository.Snapshot, now: Long) {
        val ctx = context ?: return
        for (h in snap.hotspots) {
            if (h.confidence < 70) continue
            val marker = Marker(mv).apply {
                position = GeoPoint(h.lat, h.lng)
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                title = getString(R.string.map_hotspot_title, h.confidence)
                snippet = getString(R.string.map_hotspot_snippet, h.satellite, h.confidence)
                icon = ContextCompat.getDrawable(ctx, R.drawable.ic_hotspot) ?: return@apply
            }
            mv.overlays.add(marker)
        }
        for (r in snap.reports) {
            if (r.status == "rejected") continue
            if (!ProximityLogic.isFresh(r.timestampMs, now)) continue
            val verified = r.status == "verified" || r.status == "resolved"
            val marker = Marker(mv).apply {
                position = GeoPoint(r.lat, r.lng)
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                title = if (verified) getString(R.string.map_fire_verified) else getString(R.string.map_fire_pending)
                snippet = "${r.locationName} — ${r.description.take(80)}"
                icon = ContextCompat.getDrawable(
                    ctx,
                    if (verified) R.drawable.ic_fire_verified else R.drawable.ic_fire_pending
                ) ?: return@apply
            }
            mv.overlays.add(marker)
        }
        for (s in snap.safezones) {
            val marker = Marker(mv).apply {
                position = GeoPoint(s.lat, s.lng)
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                title = getString(R.string.map_safezone_title)
                snippet = s.nameAr
                icon = ContextCompat.getDrawable(ctx, R.drawable.ic_safezone) ?: return@apply
            }
            mv.overlays.add(marker)
        }
        for (m in snap.meshIntel) {
            val lat = m.lat ?: continue
            val lng = m.lng ?: continue
            val marker = Marker(mv).apply {
                position = GeoPoint(lat, lng)
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                title = getString(R.string.map_mesh_title)
                snippet = m.text.take(100)
                icon = ContextCompat.getDrawable(ctx, R.drawable.ic_mesh_dot) ?: return@apply
            }
            mv.overlays.add(marker)
        }
    }

    /**
     * Hybrid evacuation, native: nearest safezone by haversine, then the real
     * OSRM road geometry, then the fire-corridor check along the polyline.
     */
    private fun fetchEvacuationRoute() {
        val mv = map ?: return
        val user = lastUserLatLng
        if (user == null) {
            Toast.makeText(requireContext(), R.string.route_need_fix, Toast.LENGTH_LONG).show()
            return
        }
        val snap = app.repository.state.value
        val target = snap.safezones.minByOrNull {
            TeamLocationLogic.haversineMeters(user.first, user.second, it.lat, it.lng)
        }
        if (target == null) {
            Toast.makeText(requireContext(), R.string.route_no_safezones, Toast.LENGTH_LONG).show()
            return
        }
        routeInfoText?.text = getString(R.string.route_fetching)
        viewLifecycleOwner.lifecycleScope.launch {
            val url = ApiPayloads.buildOsrmUrl(user.first, user.second, target.lat, target.lng)
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                when (val r = app.api.get(url)) {
                    is ObservatoryApi.Result.Ok -> Parsers.parseOsrmRoute(r.body)
                    else -> null
                }
            }
            if (!isAdded) return@launch
            val (points, distDur) = result ?: run {
                // Honest fallback: NO invented route line — say what we know.
                val straightKm = TeamLocationLogic.haversineMeters(user.first, user.second, target.lat, target.lng) / 1000.0
                routeInfoText?.text = getString(R.string.route_offline_fmt, target.nameAr, straightKm)
                routeLine?.let { mv.overlays.remove(it); routeLine = null }
                Toast.makeText(requireContext(), R.string.route_offline_toast, Toast.LENGTH_LONG).show()
                return@launch
            }
            routeLine?.let { mv.overlays.remove(it) }
            val now = System.currentTimeMillis()
            val threats = snap.reports.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.timestampMs) } +
                snap.hotspots.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.scanTimeMs) }
            var minFireM = Double.MAX_VALUE
            for (p in points) {
                val d = GeoMath.minDistanceToPolylineM(p.first, p.second, threats.map { it.lat to it.lng })
                if (d < minFireM) minFireM = d
            }
            val crossesFire = minFireM < ROUTE_FIRE_WARNING_M
            val line = Polyline(mv).apply {
                setPoints(points.map { GeoPoint(it.first, it.second) })
                outlinePaint.color = if (crossesFire) 0xFFEF4444.toInt() else 0xFF10B981.toInt()
                outlinePaint.strokeWidth = 12f
            }
            routeLine = line
            mv.overlays.add(line)
            try {
                mv.zoomToBoundingBox(BoundingBox.fromGeoPoints(points.map { GeoPoint(it.first, it.second) }), false, 90)
            } catch (e: Exception) {
                // degenerate bounding box — keep current zoom
            }
            val km = distDur.first / 1000.0
            val min = distDur.second / 60.0
            routeInfoText?.text = if (crossesFire) {
                getString(R.string.route_warn_fmt, target.nameAr, km, min.toInt(), (minFireM / 1000.0))
            } else {
                getString(R.string.route_ok_fmt, target.nameAr, km, min.toInt())
            }
        }
    }

    override fun onResume() {
        super.onResume()
        map?.onResume()
    }

    override fun onPause() {
        map?.onPause()
        super.onPause()
    }

    override fun onDestroyView() {
        app.locationEngine.removeListener(locationListener)
        map?.onDetach()
        map = null
        userMarker = null
        routeLine = null
        super.onDestroyView()
    }
}
