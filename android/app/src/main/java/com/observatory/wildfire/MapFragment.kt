package com.observatory.wildfire

import android.os.Bundle
import android.preference.PreferenceManager
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.tileprovider.tilesource.XYTileSource
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.util.MapTileIndex
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Overlay
import org.osmdroid.views.overlay.Polygon
import org.osmdroid.views.overlay.Polyline
import kotlin.math.roundToInt

/**
 * v2.10.0 (S4 Radar v2) — the INTEGRATED OPERATIONAL MAP. Everything the
 * field needs fused into one native screen (previously the "integrated map"
 * existed on NEITHER platform: the web EvacuationRadar is range-rings-only
 * and this fragment was user-marker + route + threat pins):
 *
 *  - Range rings (7.5/15/22.5/30 km) around the user, toggleable, web ring
 *    spec — drawn UNDER every other layer.
 *  - LIVE WIND + SPREAD CONE: the repository's WeatherNow (Open-Meteo, same
 *    provider the web radar calls) drives a ±22° translucent downwind cone
 *    at 55% of the 30 km range. Explicitly disclaimed: wind reference, NOT a
 *    fire model. No wind reading → no cone, no drift hint, ever.
 *  - ROUTE ALTERNATIVES, SAFETY-FIRST: the OSRM request now asks for
 *    alternatives; every candidate road gets a per-vertex fire-corridor
 *    measurement (reports + hotspots) and the radar auto-draws the SAFEST
 *    (max clearance) rather than the fastest, with tappable chips to switch.
 *  - AI SAFETY BRIEFING: the server's /api/ai/guidance (prompt-sanitized,
 *    6/min limited, fallback-bodied) rendered in an overlay card. Client
 *    discipline mirrors the web AICopilot: 1h cache, ≥5s between requests,
 *    honest failure — the client never authors guidance text.
 *  - MISSION TARGET: an active team mission (own team only — teammate
 *    positions remain command-center-only by the S-M2 design) paints its SOS
 *    target + phase chip from the same service state TeamFragment reads.
 *
 * Everything from v2.1.1 stands: OSM/CARTO tiles, FIRMS hotspots, verified
 * fires, safezones, mesh intel, recenter discipline (F11 — now upgraded: the
 * recenter button engages FOLLOW mode, and any manual pan releases it).
 *
 * v2.19.0 — the map stopped being a static picture (owner verdict: "كأنها
 * صورة ثابتة"):
 *  - SATELLITE LAYER: one chip cycles street ⇄ Esri World Imagery (z/y/x
 *    tile order — the osmdroid default is z/x/y, so a custom source);
 *  - FOLLOW MODE: the camera animates to every fresh fix; a manual scroll
 *    releases it (our own programmatic moves are time-suppressed so the
 *    animation never cancels itself);
 *  - the user dot is now a HEADING ARROW: GPS course while moving, compass
 *    (HeadingEngine) while standing — it turns as you turn;
 *  - the status line names your WILAYA (nearest-centroid, offline-safe).
 */
class MapFragment : Fragment() {

    companion object {
        private const val DEFAULT_ZOOM = 11.0
        /** Web parity: wind refresh every 10 minutes while fixes arrive. */
        private const val WIND_REFRESH_MS = 10L * 60L * 1000L
        /** Chips drawn for the top-ranked routes (OSRM caps alternatives ~3). */
        private const val MAX_ROUTE_CHIPS = 3
        /** Window that hides our own animateTo from the scroll listener. */
        private const val ANIMATE_SUPPRESS_MS = 900L
    }

    private val app get() = requireActivity().application as ObservatoryApp

    private var map: MapView? = null
    private var statusText: TextView? = null
    private var routeButton: View? = null
    private var routeInfoText: TextView? = null
    private var routeChipsScroll: View? = null
    private var routeChipsRow: LinearLayout? = null
    private var ringsToggle: TextView? = null
    private var aiButton: TextView? = null
    private var windChip: TextView? = null
    private var radarNote: TextView? = null
    private var missionChip: TextView? = null
    private var aiCard: View? = null
    private var aiCardBody: TextView? = null
    private var styleToggle: TextView? = null
    private var followButton: TextView? = null

    private var userMarker: Marker? = null
    private var missionMarker: Marker? = null
    private var routeLine: Polyline? = null
    private var ringLines: List<Polyline> = emptyList()
    private var conePolygon: Polygon? = null

    private var mapReady = false
    private var lastUserLatLng: Pair<Double, Double>? = null
    // F11: recenter discipline. The old onFix called animateTo on EVERY
    // fix, fighting the user's free pan. Recentering now happens only on
    // the first fix, when the user walks their marker OUT of the visible
    // window, or when the recenter button is pressed.
    private var firstFixSeen = false

    // S4 radar state.
    private var ringsVisible = true
    private var lastWindFetchMs = 0L
    private var rankedRoutes: List<RadarV2.RouteOption> = emptyList()
    private var selectedRouteIndex = -1
    private var lastSafezoneNameAr: String? = null
    private var routeFetchInFlight = false

    // v2.19.0 — satellite layer + follow mode + compass.
    private var satelliteActive = false
    private var followMode = false
    /** Suppression window that hides our own animateTo from the scroll
     *  listener (otherwise follow mode would cancel its own animation). */
    private var programmaticMoveUntilMs = 0L
    private var streetSource: XYTileSource? = null
    private var headingEngine: HeadingEngine? = null
    private var currentHeadingDeg: Double? = null

    private val headingListener: (HeadingEngine.State) -> Unit = { state ->
        activity?.runOnUiThread {
            currentHeadingDeg = state.headingDeg
            updateUserMarkerRotation()
        }
    }

    private val scrollListener = object : org.osmdroid.events.MapListener {
        override fun onScroll(event: org.osmdroid.events.ScrollEvent?): Boolean {
            // A scroll we did not program = the user grabbed the map → release
            // follow (F11's descendant: never fight the operator's hands).
            if (followMode && System.currentTimeMillis() > programmaticMoveUntilMs) {
                followMode = false
                renderFollowButton()
            }
            return true
        }

        override fun onZoom(event: org.osmdroid.events.ZoomEvent?): Boolean = true
    }

    // F2: named listeners so onDestroyView can deregister from the
    // application-scoped engines (inline lambdas leaked this view forever).
    private val locationListener: (LocationEngine.State) -> Unit = { state ->
        activity?.runOnUiThread {
            state.fix?.let { onFix(it) }
        }
    }

    // S4: team service beats carry the ACTIVE MISSION of the member's own
    // team ("beat" → missionJson; "stopped"/"revoked"/"error" → clear).
    private val serviceListener: (String, String?) -> Unit = { state, payload ->
        activity?.runOnUiThread { onServiceState(state, payload) }
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
        routeChipsScroll = view.findViewById(R.id.route_chips_scroll)
        routeChipsRow = view.findViewById(R.id.route_chips_row)
        ringsToggle = view.findViewById(R.id.rings_toggle)
        aiButton = view.findViewById(R.id.ai_briefing_button)
        windChip = view.findViewById(R.id.wind_chip)
        radarNote = view.findViewById(R.id.radar_note)
        missionChip = view.findViewById(R.id.mission_chip)
        aiCard = view.findViewById(R.id.ai_card)
        aiCardBody = view.findViewById(R.id.ai_card_body)
        styleToggle = view.findViewById(R.id.map_style_toggle)
        followButton = view.findViewById(R.id.follow_button)
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
        streetSource = XYTileSource(
            "OpenStreetMap", 1, 19, 256, ".png",
            arrayOf("https://tile.openstreetmap.org/")
        )
        mv.setTileSource(streetSource!!)
        // v2.19.0: street ⇄ satellite cycle + manual-scroll releases follow.
        mv.addMapListener(scrollListener)
        styleToggle?.setOnClickListener { toggleMapStyle() }
        followButton?.setOnClickListener {
            followMode = !followMode
            renderFollowButton()
            val ll = lastUserLatLng
            if (followMode && ll != null) {
                programmaticMoveUntilMs = System.currentTimeMillis() + ANIMATE_SUPPRESS_MS
                mv.controller.animateTo(GeoPoint(ll.first, ll.second))
            }
        }
        // F11 evolved: recenter ENGAGES follow mode (map rides every fix)
        // instead of a single jump — field users walk, a one-shot jump dies
        // two steps later. Manual pan releases it (scrollListener above).
        view.findViewById<View>(R.id.recenter_button).setOnClickListener {
            val ll = lastUserLatLng ?: return@setOnClickListener
            followMode = true
            renderFollowButton()
            programmaticMoveUntilMs = System.currentTimeMillis() + ANIMATE_SUPPRESS_MS
            mv.controller.animateTo(GeoPoint(ll.first, ll.second))
        }
        // Stock white +/- squares belong to the stone age — styled controls
        // live in fragment_map.xml and call controller.zoomIn/zoomOut below.
        mv.zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
        view.findViewById<View>(R.id.zoom_in).setOnClickListener { mv.controller.zoomIn() }
        view.findViewById<View>(R.id.zoom_out).setOnClickListener { mv.controller.zoomOut() }
        renderFollowButton()
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
            val cartoSource = XYTileSource(
                "CartoVoyager-rt-${key.takeLast(6)}", 1, 19, 256, ".png?key=$key",
                arrayOf("https://basemaps.cartocdn.com/rastertiles/voyager/")
            )
            mv2.setTileSource(cartoSource)
            streetSource = cartoSource
            mv2.invalidate()
        }

        routeButton?.setOnClickListener { fetchEvacuationRoute() }
        ringsToggle?.setOnClickListener { onRingsToggled() }
        aiButton?.setOnClickListener { onAiBriefingRequested() }
        view.findViewById<View>(R.id.ai_card_close).setOnClickListener {
            aiCard?.visibility = View.GONE
        }

        app.locationEngine.addListener(locationListener)
        TeamLocationService.addStateListener(serviceListener)
        headingEngine = HeadingEngine(requireContext()).also {
            it.addListener(headingListener)
            it.start()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap -> render(snap) }
            }
        }
    }

    private fun onFix(fix: LocationLogic.FixSnapshot) {
        val mv = map ?: return
        val moved = lastUserLatLng != null &&
            (lastUserLatLng!!.first != fix.lat || lastUserLatLng!!.second != fix.lng)
        lastUserLatLng = fix.lat to fix.lng
        val point = GeoPoint(fix.lat, fix.lng)
        if (userMarker == null) {
            userMarker = Marker(mv).apply {
                position = point
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                title = getString(R.string.map_you_marker)
                icon = ContextCompat.getDrawable(requireContext(), R.drawable.ic_user_arrow)
                    ?: ContextCompat.getDrawable(requireContext(), R.drawable.ic_user_dot)
                mv.overlays.add(this)
            }
        }
        userMarker?.position = point
        updateUserMarkerRotation(fix)
        // v2.19.0 follow mode: the map RIDES the person (every fresh fix),
        // not just a one-shot jump — that was the "static picture" verdict.
        if (followMode) {
            programmaticMoveUntilMs = System.currentTimeMillis() + ANIMATE_SUPPRESS_MS
            mv.controller.animateTo(point)
        }
        // F11 residual: no fix was ever seen (cold start) → first jump still
        // applies even without follow; leaving follow ON afterwards.
        if (!firstFixSeen) {
            firstFixSeen = true
            if (!followMode) mv.controller.animateTo(point)
        }
        val box = mv.boundingBox
        val outsideView = box == null || !box.contains(point)
        if (!followMode && outsideView) {
            programmaticMoveUntilMs = System.currentTimeMillis() + ANIMATE_SUPPRESS_MS
            mv.controller.animateTo(point)
        }
        // Status line now names the wilaya — offline-safe nearest-centroid.
        val wilayaAr = Wilayas.nearest(fix.lat, fix.lng).nameAr
        statusText?.text = getString(R.string.map_status_wilaya_fmt, fix.accuracyM.toInt(), wilayaAr)
        // S4: rings ride the user's position; wind refreshes on web parity's
        // 10-minute cadence (the cone itself redraws via the snapshot flow).
        if (moved || ringLines.isEmpty()) drawRings(mv)
        maybeFetchWind(fix)
    }

    /** Arrow rotation: GPS course while moving, compass when standing. */
    private fun updateUserMarkerRotation(fix: LocationLogic.FixSnapshot? = app.locationEngine.currentFix()) {
        val marker = userMarker ?: return
        val heading = fix?.bearingDeg ?: currentHeadingDeg ?: return
        marker.rotation = heading.toFloat()
    }

    /** Street ⇄ Esri World Imagery. Esri tiles are z/y/x ordered — the
     *  osmdroid default path builder is z/x/y, hence the custom source. */
    private fun toggleMapStyle() {
        val mv = map ?: return
        satelliteActive = !satelliteActive
        if (satelliteActive) {
            mv.setTileSource(satelliteSource())
            styleToggle?.setText(R.string.map_style_map)
            styleToggle?.setTextColor(ContextCompat.getColor(requireContext(), R.color.accent_cyan))
        } else {
            streetSource?.let { mv.setTileSource(it) }
            styleToggle?.setText(R.string.map_style_sat)
            styleToggle?.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_secondary))
        }
        mv.invalidate()
    }

    private fun satelliteSource(): OnlineTileSourceBase =
        object : OnlineTileSourceBase(
            "EsriWorldImagery", 1, 19, 256, ".jpg",
            arrayOf("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/")
        ) {
            override fun getTileURLString(pMapTileIndex: Long): String =
                baseUrl + MapTileIndex.getZoom(pMapTileIndex) + "/" +
                    MapTileIndex.getY(pMapTileIndex) + "/" +
                    MapTileIndex.getX(pMapTileIndex) + mImageFilenameEnding
        }

    private fun renderFollowButton() {
        val btn = followButton ?: return
        btn.setText(if (followMode) R.string.map_follow_on else R.string.map_follow_toggle)
        btn.setTextColor(
            ContextCompat.getColor(
                requireContext(),
                if (followMode) R.color.accent_green else R.color.accent_cyan
            )
        )
    }

    // ---------- S4 radar layers ----------

    private fun onRingsToggled() {
        ringsVisible = !ringsVisible
        val mv = map ?: return
        val c = lastUserLatLng
        if (c != null) drawRings(mv)
        ringsToggle?.setTextColor(
            ContextCompat.getColor(
                requireContext(),
                if (ringsVisible) R.color.accent_red else R.color.text_secondary
            )
        )
    }

    /** Range rings UNDER everything else; empty center → nothing drawn. */
    private fun drawRings(mv: MapView) {
        ringLines.forEach { mv.overlays.remove(it) }
        ringLines = emptyList()
        if (!ringsVisible) return
        val c = lastUserLatLng ?: return
        ringLines = RadarV2.RANGE_RINGS_KM.map { km ->
            Polyline(mv).apply {
                setPoints(
                    RadarV2.circleGeoPoints(c.first, c.second, km)
                        .map { GeoPoint(it.first, it.second) }
                )
                outlinePaint.color = 0x1FFFFFFF // white ~12%, web ring tint
                outlinePaint.strokeWidth = 2f
            }
        }
        mv.overlays.addAll(ringLines)
        mv.invalidate()
    }

    /** ±22° downwind cone at 55% range. No wind → cone removed, note hidden. */
    private fun drawCone(mv: MapView, weather: WeatherNow?) {
        conePolygon?.let { mv.overlays.remove(it) }
        conePolygon = null
        val c = lastUserLatLng
        if (weather == null || c == null) {
            radarNote?.visibility = View.GONE
            return
        }
        val drift = RadarV2.driftHeading(weather.windFromDeg.roundToInt())
        val pts = RadarV2.coneGeoPoints(c.first, c.second, drift)
        if (pts.isEmpty()) {
            radarNote?.visibility = View.GONE
            return
        }
        conePolygon = Polygon(mv).apply {
            points = pts.map { GeoPoint(it.first, it.second) }
            fillPaint.color = 0x47FF6B35.toInt() // orange-500 at ~28% (web sector tint)
            outlinePaint.color = 0x66FF6B35.toInt()
            outlinePaint.strokeWidth = 1.5f
        }
        mv.overlays.add(conePolygon)
        radarNote?.visibility = View.VISIBLE
        mv.invalidate()
    }

    private fun updateWindChip(weather: WeatherNow?) {
        val chip = windChip ?: return
        if (weather == null) {
            chip.text = getString(R.string.wind_no_fix)
            return
        }
        val dirAr = TelemetryCamera.bearingDirectionAr(weather.windFromDeg)
        chip.text = getString(
            R.string.wind_chip_fmt,
            RadarV2.speedLabel(weather.windKph),
            RadarV2.tempLabel(weather.tempC),
            dirAr,
            RadarV2.windBrief(weather.windKph)
        )
    }

    /**
     * Web parity wind refresh: Open-Meteo every 10 minutes while fixes flow.
     * The result lands in the repository snapshot, and the snapshot collector
     * below redraws the cone + chip — this call only TRIGGERS.
     */
    private fun maybeFetchWind(fix: LocationLogic.FixSnapshot) {
        val now = System.currentTimeMillis()
        if (now - lastWindFetchMs < WIND_REFRESH_MS) return
        lastWindFetchMs = now
        app.repository.fetchWeatherAt(fix.lat, fix.lng) { }
    }

    // ---------- AI safety briefing ----------

    private fun onAiBriefingRequested() {
        val now = System.currentTimeMillis()
        val cached = app.aiBriefingText
        if (cached != null && RadarV2.aiCacheFresh(app.aiBriefingAt, now)) {
            showAiCard(cached)
            return
        }
        if (!RadarV2.aiRequestAllowed(app.aiLastRequestMs, now)) {
            Toast.makeText(requireContext(), R.string.ai_wait, Toast.LENGTH_SHORT).show()
            return
        }
        app.aiLastRequestMs = now
        aiCard?.visibility = View.VISIBLE
        aiCardBody?.text = getString(R.string.ai_loading)
        val coords = lastUserLatLng
        viewLifecycleOwner.lifecycleScope.launch {
            val body = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                when (val r = app.api.post("/api/ai/guidance", ApiPayloads.buildAiGuidanceBody(coords?.first, coords?.second))) {
                    is ObservatoryApi.Result.Ok -> Parsers.parseAiGuidance(r.body)
                    else -> null
                }
            }
            if (!isAdded) return@launch
            if (body == null) {
                // Honest failure — no locally authored guidance, ever.
                if (cached != null) showAiCard(cached) else {
                    aiCardBody?.text = getString(R.string.ai_failed)
                }
                return@launch
            }
            app.aiBriefingText = body
            app.aiBriefingAt = System.currentTimeMillis()
            showAiCard(body)
        }
    }

    private fun showAiCard(text: String) {
        // The server returns markdown-ish "### …" section heads; the card
        // renders them as plain emphasis lines (no markdown parser shipped).
        aiCardBody?.text = text.replace("### ", "▪ ")
        aiCard?.visibility = View.VISIBLE
    }

    // ---------- Mission target (own team only) ----------

    private fun onServiceState(state: String, payload: String?) {
        val mv = map ?: return
        if (state == "beat") {
            val phase = TeamLocationLogic.parseMissionPhase(payload)
            val coords = TeamLocationLogic.parseMissionCoords(payload)
            if (phase != null && phase != "cleared" && coords != null) {
                val point = GeoPoint(coords.first, coords.second)
                if (missionMarker == null) {
                    missionMarker = Marker(mv).apply {
                        setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                        title = getString(R.string.mission_target_title)
                        snippet = getString(R.string.mission_target_snippet)
                        icon = ContextCompat.getDrawable(requireContext(), R.drawable.ic_mission_target)
                            ?: return@apply
                        mv.overlays.add(this)
                    }
                }
                missionMarker?.position = point
                val phaseAr = when (phase) {
                    "en_route" -> getString(R.string.phase_en_route)
                    "on_scene" -> getString(R.string.phase_on_scene)
                    else -> phase
                }
                missionChip?.text = getString(R.string.mission_chip_fmt, phaseAr)
                missionChip?.visibility = View.VISIBLE
            } else {
                removeMissionTarget(mv)
            }
        } else if (state == "stopped" || state == "revoked" || state == "error") {
            removeMissionTarget(mv)
        }
    }

    private fun removeMissionTarget(mv: MapView) {
        missionMarker?.let { mv.overlays.remove(it) }
        missionMarker = null
        missionChip?.visibility = View.GONE
    }

    // ---------- Snapshot rendering ----------

    private fun render(snap: AppRepository.Snapshot) {
        val mv = map ?: return
        if (!mapReady) return
        val now = System.currentTimeMillis()

        // Rebuild data overlays (keep identity markers + route line).
        val keep = mv.overlays.filter { it === userMarker || it === routeLine || it === missionMarker }
        mv.overlays.clear()
        mv.overlays.addAll(keep)

        drawRings(mv)
        drawCone(mv, snap.weather)
        renderThreats(mv, snap, now)
        updateWindChip(snap.weather)
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

    // ---------- Route alternatives (safety-first) ----------

    /**
     * v2.10.0: OSRM now returns up to ~3 candidate roads (alternatives=true).
     * Each gets its per-vertex fire-corridor clearance measured against the
     * CURRENT threat picture (fresh reports + hotspots); RadarV2 ranks them
     * SAFETY-FIRST and the safest is drawn automatically. Chips let the
     * driver compare and switch — the fastest road is no longer privileged
     * over the safest one.
     */
    private fun fetchEvacuationRoute() {
        val mv = map ?: return
        val user = lastUserLatLng
        if (user == null) {
            Toast.makeText(requireContext(), R.string.route_need_fix, Toast.LENGTH_LONG).show()
            return
        }
        if (routeFetchInFlight) return
        val snap = app.repository.state.value
        val target = snap.safezones.minByOrNull {
            TeamLocationLogic.haversineMeters(user.first, user.second, it.lat, it.lng)
        }
        if (target == null) {
            Toast.makeText(requireContext(), R.string.route_no_safezones, Toast.LENGTH_LONG).show()
            return
        }
        lastSafezoneNameAr = target.nameAr
        routeInfoText?.text = getString(R.string.route_fetching)
        routeFetchInFlight = true
        viewLifecycleOwner.lifecycleScope.launch {
            val url = ApiPayloads.buildOsrmUrl(user.first, user.second, target.lat, target.lng)
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                when (val r = app.api.get(url)) {
                    is ObservatoryApi.Result.Ok -> Parsers.parseOsrmAlternatives(r.body)
                    else -> null
                }
            }
            routeFetchInFlight = false
            if (!isAdded) return@launch
            val raw = result ?: run {
                // Honest fallback: NO invented route line — say what we know.
                val straightKm = TeamLocationLogic.haversineMeters(user.first, user.second, target.lat, target.lng) / 1000.0
                routeInfoText?.text = getString(R.string.route_offline_fmt, target.nameAr, straightKm)
                routeLine?.let { mv.overlays.remove(it); routeLine = null }
                routeChipsScroll?.visibility = View.GONE
                rankedRoutes = emptyList()
                Toast.makeText(requireContext(), R.string.route_offline_toast, Toast.LENGTH_LONG).show()
                return@launch
            }
            // One threat picture, reused for every candidate (fresh reports +
            // hotspots — the same corridor discipline as v2.1.0, now per-route).
            val now = System.currentTimeMillis()
            val threats: List<Pair<Double, Double>> =
                snap.reports.filter { ProximityLogic.isFresh(it.timestampMs, now) }
                    .map { it.lat to it.lng } +
                    snap.hotspots.map { it.lat to it.lng }
            rankedRoutes = RadarV2.rankRoutes(
                raw.map { (pts, dist, dur) ->
                    val minFire = if (pts.isEmpty()) {
                        Double.NaN
                    } else if (threats.isEmpty()) {
                        Double.MAX_VALUE
                    } else {
                        pts.minOf { p -> GeoMath.minDistanceToPolylineM(p.first, p.second, threats) }
                    }
                    RadarV2.RouteOption(pts, dist, dur, minFire)
                }
            )
            renderRouteChips()
            if (rankedRoutes.isEmpty()) {
                routeChipsScroll?.visibility = View.GONE
                routeInfoText?.text = getString(R.string.route_offline_fmt, target.nameAr, 0.0)
                return@launch
            }
            selectRoute(0)
        }
    }

    private fun renderRouteChips() {
        val row = routeChipsRow ?: return
        row.removeAllViews()
        if (rankedRoutes.isEmpty()) {
            routeChipsScroll?.visibility = View.GONE
            return
        }
        val density = resources.displayMetrics.density
        rankedRoutes.take(MAX_ROUTE_CHIPS).forEachIndexed { idx, opt ->
            val chip = TextView(requireContext()).apply {
                val verdict = getString(if (opt.crossesFire) R.string.route_cross else R.string.route_safe)
                val base = getString(
                    R.string.route_chip_fmt,
                    opt.distanceM / 1000.0,
                    (opt.durationS / 60.0).roundToInt(),
                    verdict
                )
                text = if (idx == 0) getString(R.string.route_safest_mark, base) else base
                setBackgroundResource(R.drawable.bg_chip)
                setPadding(
                    (10 * density).toInt(), (5 * density).toInt(),
                    (10 * density).toInt(), (5 * density).toInt()
                )
                textSize = 11f
                setTextColor(
                    ContextCompat.getColor(
                        requireContext(),
                        when {
                            idx == selectedRouteIndex -> R.color.accent_red
                            opt.crossesFire -> R.color.accent_orange
                            else -> R.color.text_secondary
                        }
                    )
                )
                setOnClickListener { selectRoute(idx) }
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = (8 * density).toInt() }
            row.addView(chip, lp)
        }
        routeChipsScroll?.visibility = View.VISIBLE
    }

    /** Draws the selected alternative + honest corridor-verdict info line. */
    private fun selectRoute(idx: Int) {
        val mv = map ?: return
        val opt = rankedRoutes.getOrNull(idx) ?: return
        selectedRouteIndex = idx
        routeLine?.let { mv.overlays.remove(it) }
        val line = Polyline(mv).apply {
            setPoints(opt.points.map { GeoPoint(it.first, it.second) })
            outlinePaint.color = if (opt.crossesFire) 0xFFD21034.toInt() else 0xFF2E9E5B.toInt()
            outlinePaint.strokeWidth = 12f
        }
        routeLine = line
        mv.overlays.add(line)
        try {
            mv.zoomToBoundingBox(
                BoundingBox.fromGeoPoints(opt.points.map { GeoPoint(it.first, it.second) }),
                false, 90
            )
        } catch (e: Exception) {
            // degenerate bounding box — keep current zoom
        }
        val nameAr = lastSafezoneNameAr
        val km = opt.distanceM / 1000.0
        val min = (opt.durationS / 60.0).roundToInt()
        routeInfoText?.text = if (opt.crossesFire && !opt.minFireDistanceM.isNaN()) {
            getString(R.string.route_warn_fmt, nameAr ?: "", km, min, opt.minFireDistanceM / 1000.0)
        } else {
            getString(R.string.route_ok_fmt, nameAr ?: "", km, min)
        }
        renderRouteChips()
        mv.invalidate()
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
        TeamLocationService.removeStateListener(serviceListener)
        headingEngine?.let { it.removeListener(headingListener); it.stop() }
        headingEngine = null
        map?.onDetach()
        map = null
        userMarker = null
        missionMarker = null
        routeLine = null
        ringLines = emptyList()
        conePolygon = null
        rankedRoutes = emptyList()
        super.onDestroyView()
    }
}
