package com.observatory.wildfire

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

/**
 * v2.0.0 — المرصد: the native dashboard. One screen answers "هل أنا بخير
 * الآن؟": GPS verdict chip, connection/mesh chips, the /100 risk gauge, the
 * HUD radar, weather at the user's position, and the proximity banner that
 * shares ProximityLogic with the SOS screen (v1.0.4's contradiction lesson).
 */
class ObservatoryFragment : Fragment() {

    private val app get() = requireActivity().application as ObservatoryApp

    private var radarView: RadarView? = null
    private var gpsChip: TextView? = null
    private var netChip: TextView? = null
    private var meshChip: TextView? = null
    private var riskScoreText: TextView? = null
    private var riskLabelText: TextView? = null
    private var riskDetailText: TextView? = null
    private var weatherText: TextView? = null
    private var banner: View? = null
    private var bannerText: TextView? = null
    // Fix 21 (NOBS-2): the once-per-view flag is gone — the last ATTEMPT
    // time throttles refreshes (MapFragment's pattern). Set BEFORE the
    // call, so a failing endpoint is retried at most every 10 min, not on
    // every location publish.
    private var lastWeatherAttemptMs = 0L

    // Fix 21c: time-based freshness re-evaluation. Location events alone
    // cannot expire the banner or the weather line — the engine suppresses
    // unchanged non-FIXED states and, while offline, no repository state
    // emission ever fires render(). A 10 s tick re-runs the three
    // freshness-gated displays while the view is resumed.
    private val freshnessHandler = Handler(Looper.getMainLooper())
    private val freshnessTick = object : Runnable {
        override fun run() {
            refreshFreshnessDisplays()
            freshnessHandler.postDelayed(this, FRESHNESS_TICK_MS)
        }
    }

    companion object {
        private const val FRESHNESS_TICK_MS = 10_000L
    }

    // v2.19.0 — the compass: the radar went heading-up and the awareness line
    // carries "your wilaya + nearest threat". Created per-view (nothing else
    // needs it) and stopped with the view.
    private var headingEngine: HeadingEngine? = null
    private var currentHeadingDeg: Double? = null
    private var radarModeLabel: TextView? = null
    private var awarenessText: TextView? = null

    // v2.20.0 — the Neo risk meter: a 5-level gradient track with a white
    // marker that rides to the current score (absolute translationX). Never
    // drawn = the track still communicates the scale by itself.
    private var riskBar: FrameLayout? = null
    private var riskBarMarker: View? = null
    private var lastMarkerX = -1f

    private val headingListener: (HeadingEngine.State) -> Unit = { state ->
        activity?.runOnUiThread {
            currentHeadingDeg = state.headingDeg
            radarModeLabel?.setText(
                if (state.headingDeg != null) R.string.radar_mode_heading_up
                else R.string.radar_mode_north_up
            )
            updateRadar()
        }
    }

    // F2: named listener so onDestroyView can deregister from the
    // application-scoped engine (an inline lambda leaked this view forever).
    private val locationListener: (LocationEngine.State) -> Unit = { state ->
        activity?.runOnUiThread { renderGps(state) }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_observatory, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        radarView = view.findViewById(R.id.radar_view)
        radarModeLabel = view.findViewById(R.id.radar_mode_label)
        awarenessText = view.findViewById(R.id.radar_awareness)
        view.findViewById<TextView>(R.id.version_badge)?.text =
            getString(R.string.version_badge_fmt, BuildConfig.VERSION_NAME)
        gpsChip = view.findViewById(R.id.chip_gps)
        netChip = view.findViewById(R.id.chip_net)
        meshChip = view.findViewById(R.id.chip_mesh)
        riskScoreText = view.findViewById(R.id.risk_score)
        riskLabelText = view.findViewById(R.id.risk_label)
        riskDetailText = view.findViewById(R.id.risk_detail)
        riskBar = view.findViewById(R.id.risk_bar)
        riskBarMarker = view.findViewById(R.id.risk_bar_marker)
        // Fix 57 (NRESBG-1): the track is a programmatic 5-stop gradient
        // single-sourced from RiskScore.bandColor — drawable XML cannot
        // express 5 stops (start/center/end only), and the old drawable
        // defined 3 stops matching neither the bands nor the code colors.
        // GradientDrawable has no public positions API, so the 5 band
        // colors are evenly distributed (pure at 0/25/50/75/100%) rather
        // than at the band centers (10/30/50/70/90%) — same colors, same
        // order, only the stop positions differ. Corner radius matches
        // the old drawable's 99dp.
        val trackBackground = GradientDrawable(
            GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(
                RiskScore.bandColor(10),
                RiskScore.bandColor(30),
                RiskScore.bandColor(50),
                RiskScore.bandColor(70),
                RiskScore.bandColor(90)
            )
        )
        trackBackground.cornerRadius = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 99f, resources.displayMetrics
        )
        riskBar?.background = trackBackground
        weatherText = view.findViewById(R.id.weather_line)
        banner = view.findViewById(R.id.proximity_banner)
        bannerText = view.findViewById(R.id.proximity_text)
        view.findViewById<View>(R.id.proximity_action)?.setOnClickListener {
            (activity as? NativeMainActivity)?.openMapTab()
        }

        app.locationEngine.addListener(locationListener)
        headingEngine = HeadingEngine(requireContext()).also {
            it.addListener(headingListener)
            it.start()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap -> render(snap) }
            }
        }

        playEntranceCascade(view)
    }

    override fun onResume() {
        super.onResume()
        // Fix 21c: start the freshness tick while the view is resumed.
        freshnessHandler.post(freshnessTick)
    }

    override fun onPause() {
        freshnessHandler.removeCallbacks(freshnessTick)
        super.onPause()
    }

    /**
     * v2.20.0 Neo motion — the dashboard sections rise into place with a
     * light stagger once per view creation (280 ms each, 60 ms apart).
     * Pure view-layer polish: no state, no listeners, nothing to clean up
     * (animator fields die with the view; values land at identity).
     */
    private fun playEntranceCascade(view: View) {
        val content = view.findViewById<ViewGroup>(R.id.observatory_content) ?: return
        for (i in 0 until content.childCount) {
            val child = content.getChildAt(i)
            child.alpha = 0f
            child.translationY = 36f
            child.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(60L * i)
                .setDuration(280L)
                .setInterpolator(DecelerateInterpolator(1.6f))
                .start()
        }
    }

    /**
     * Ride the white marker to the score position along the gradient track.
     * The gradient drawable is ALWAYS left→right (low score on the left) —
     * drawables do not mirror in RTL — so the target is an absolute X inside
     * the track: targetX = frac·(trackW − markerW), and translationX is the
     * delta from wherever layout actually placed the marker (start-aligned
     * means marker.left is 0 in LTR but trackW − markerW in RTL).
     */
    private fun positionRiskMarker(score: Int) {
        val track = riskBar ?: return
        val marker = riskBarMarker ?: return
        track.post {
            if (track.width == 0 || marker.width == 0) return@post
            val range = (track.width - marker.width).toFloat()
            if (range <= 0f) return@post
            // score/100f keeps this in Float space (translationX is a Float
            // and Double arithmetic here was a compile error on CI).
            val targetX = (score / 100f) * range - marker.left
            if (kotlin.math.abs(targetX - lastMarkerX) < 0.5f) return@post
            lastMarkerX = targetX
            marker.animate()
                .translationX(targetX)
                .setDuration(450L)
                .setInterpolator(DecelerateInterpolator(1.4f))
                .start()
        }
    }

    private fun renderGps(state: LocationEngine.State) {
        val ctx = context ?: return
        val (text, color) = when (state.status) {
            LocationLogic.Status.NO_PERMISSION ->
                getString(R.string.gps_no_permission) to 0xFFFF6B35.toInt()
            LocationLogic.Status.PROVIDERS_OFF ->
                getString(R.string.gps_providers_off) to 0xFFFF6B35.toInt()
            LocationLogic.Status.SEARCHING ->
                getString(R.string.gps_searching) to 0xFF38BDF8.toInt()
            LocationLogic.Status.FIXED -> {
                val fix = state.fix
                val fresh = fix != null && LocationLogic.isFreshFix(fix, System.currentTimeMillis())
                // Fix 52 (NLOC-1): a fix without reported accuracy shows
                // "unknown", never "0 m".
                val acc = if (fix?.hasAccuracy == true) "${fix.accuracyM.toInt()} م" else getString(R.string.accuracy_unknown)
                val label = if (fresh) {
                    getString(R.string.gps_fixed_fmt, acc)
                } else {
                    getString(R.string.gps_stale_fmt, acc)
                }
                label to 0xFF2E9E5B.toInt()
            }
        }
        gpsChip?.text = text
        gpsChip?.setTextColor(color)

        // Weather follows the fix, throttled to one attempt per 10 min and
        // only while the reading is stale (Fix 21, NOBS-2). The fresh-fix
        // gate stays: no fetch is triggered from a dead position.
        val fix = state.fix
        val now = System.currentTimeMillis()
        val snap = app.repository.state.value
        val weatherStale = snap.weather == null || !RadarV2.weatherFresh(snap.weatherFetchedAtMs, now)
        if (fix != null && LocationLogic.isFreshFix(fix, now) && weatherStale &&
                now - lastWeatherAttemptMs >= RadarV2.WEATHER_MAX_AGE_MS) {
            lastWeatherAttemptMs = now
            app.repository.fetchWeatherAt(fix.lat, fix.lng) { w ->
                activity?.runOnUiThread {
                    weatherText?.visibility = if (w == null) View.GONE else View.VISIBLE
                    w?.let {
                        weatherText?.text = formatWeatherText(it)
                    }
                }
            }
        }
        refreshFreshnessDisplays()
    }

    // Fix 21c: the single re-evaluation point for every freshness-gated
    // display — weather line, proximity banner, radar. Driven by location
    // events (renderGps), repository emissions (render, via the banner +
    // radar calls) and the 10 s tick, so nothing stays live past its age
    // gate just because no event arrived.
    private fun refreshFreshnessDisplays() {
        val snap = app.repository.state.value
        val now = System.currentTimeMillis()
        updateWeatherLine(snap, now)
        updateProximityBanner(snap)
        updateRiskDisplay(snap, now)
        updateRadar()
    }

    private fun updateRiskDisplay(snap: AppRepository.Snapshot, now: Long) {
        val scoredReports = snap.reports.filter {
            it.status != "rejected" && it.status != "resolved" &&
                ProximityLogic.isFresh(it.timestampMs, now)
        }
        val score = RiskScore.score(
            scoredReports.map { it.severity to (it.status == "verified") },
            snap.hotspots.count { it.confidence >= 70 && ProximityLogic.isFresh(it.scanTimeMs, now) }
        )
        val fresh = snap.lastSyncMs > 0 && ProximityLogic.isFresh(snap.lastSyncMs, now)
        riskScoreText?.text = if (fresh) score.toString() else "—"
        positionRiskMarker(score)
        riskScoreText?.setTextColor(RiskScore.bandColor(score))
        riskLabelText?.text = if (fresh) RiskScore.labelAr(score) else getString(R.string.risk_unknown)
        riskDetailText?.text = getString(
            R.string.risk_detail_fmt,
            snap.reports.count { it.status == "verified" },
            snap.reports.count { it.status != "verified" && it.status != "rejected" && it.status != "resolved" },
            snap.hotspots.count { it.confidence >= 70 }
        )
    }

    // Fix 49 (NMODEL-1): one formatting point for the weather line. A
    // null wind is unknown weather — the line shows temperature + humidity
    // only (weather_no_wind_fmt) instead of fabricating a wind from 0.0.
    private fun formatWeatherText(w: WeatherNow): String {
        val windKph = w.windKph
        val windFromDeg = w.windFromDeg
        return if (windKph != null && windFromDeg != null && RadarV2.hasWindReading(windKph, windFromDeg)) {
            getString(
                R.string.weather_fmt,
                w.tempC.toInt(), w.humidityPct, windKph.toInt(), windFromDeg.toInt()
            )
        } else {
            getString(R.string.weather_no_wind_fmt, w.tempC.toInt(), w.humidityPct)
        }
    }

    // Fix 21b/21c: render the fresh snapshot weather into the line (text
    // + VISIBLE when weatherFresh, else GONE). Called from renderGps and
    // from the 10 s freshness tick, so the line expires on time even when
    // no location event arrives.
    private fun updateWeatherLine(snap: AppRepository.Snapshot, now: Long) {
        val w = snap.weather
        if (w != null && RadarV2.weatherFresh(snap.weatherFetchedAtMs, now)) {
            weatherText?.text = formatWeatherText(w)
            weatherText?.visibility = View.VISIBLE
        } else {
            weatherText?.visibility = View.GONE
        }
    }

    // Fix 21c: the proximity banner, extracted from render() so the same
    // isFreshFix gate runs from render, renderGps and the freshness tick —
    // render() alone cannot expire it (no state emission while offline).
    private fun updateProximityBanner(snap: AppRepository.Snapshot) {
        val now = System.currentTimeMillis()
        // Proximity banner — needs a user position.
        // Fix 21 (NOBS-1): a retained fix is not a live position — the
        // banner stays GONE on a stale fix, exactly as when there is none.
        val fix = app.locationEngine.currentFix().takeIf { LocationLogic.isFreshFix(it, now) }
        banner?.visibility = View.GONE
        if (fix != null) {
            // v2.15.0: threat pins exclude rejected AND resolved reports —
            // a resolved fire must never raise "خطر مباشر" again (staleness
            // is filtered inside ProximityLogic via `now`).
            val freshReports = snap.reports.filter { it.status != "rejected" && it.status != "resolved" }
            val pins = freshReports.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.timestampMs) } +
                snap.hotspots.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.scanTimeMs) } +
                snap.meshIntel.filter { it.kind == "report" }.mapNotNull { intel ->
                    val lat = intel.lat ?: return@mapNotNull null
                    val lng = intel.lng ?: return@mapNotNull null
                    ProximityLogic.ThreatPin(lat, lng, intel.tsMs)
                }
            when (val level = ProximityLogic.evaluate(fix.lat, fix.lng, pins, now)) {
                null -> Unit
                else -> {
                    banner?.visibility = View.VISIBLE
                    val nearest = ProximityLogic.nearestFreshKm(fix.lat, fix.lng, pins, now)
                    bannerText?.text = getString(
                        when (level) {
                            ProximityLogic.Level.CRITICAL -> R.string.proximity_critical_fmt
                            ProximityLogic.Level.WARNING -> R.string.proximity_warning_fmt
                            ProximityLogic.Level.WATCH -> R.string.proximity_watch_fmt
                        },
                        nearest ?: 0.0
                    )
                    banner?.setBackgroundColor(
                        when (level) {
                            ProximityLogic.Level.CRITICAL -> 0x33D21034
                            ProximityLogic.Level.WARNING -> 0x33FF6B35
                            ProximityLogic.Level.WATCH -> 0x3338BDF8
                        }
                    )
                }
            }
        }
    }

    private fun render(snap: AppRepository.Snapshot) {
        val ctx = context ?: return

        netChip?.text = if (snap.online) getString(R.string.net_online) else getString(R.string.net_offline)
        netChip?.setTextColor(if (snap.online) 0xFF2E9E5B.toInt() else 0xFFE63A55.toInt())
        meshChip?.text = getString(R.string.mesh_state_fmt, meshLabel(snap.meshState), snap.meshPeers)
        meshChip?.setTextColor(if (snap.meshState == "connected") 0xFF22D3EE.toInt() else 0xFF94A3B8.toInt())

        val now = System.currentTimeMillis()
        updateRiskDisplay(snap, now)

        // Fix 21c: the banner lives in updateProximityBanner() so the same
        // isFreshFix gate runs from render, renderGps and the freshness tick.
        updateProximityBanner(snap)
        updateRadar()
    }

    private fun updateRadar() {
        val radar = radarView ?: return
        val snap = app.repository.state.value
        val fix = app.locationEngine.currentFix()
        val now = System.currentTimeMillis()

        // Fix 21 (NOBS-1): a retained fix is not a live position. Without
        // this gate the radar kept asserting current proximity from wherever
        // the user WAS after GPS loss (userHasFix=true, blips, wilaya and
        // nearest-threat all anchored on the old coordinates).
        val liveFix = fix.takeIf { LocationLogic.isFreshFix(it, now) }
        if (liveFix == null) {
            radar.setData(emptyList(), userHasFix = false, windFromDeg = null, headingDeg = currentHeadingDeg)
            awarenessText?.setText(R.string.radar_awareness_waiting)
            return
        }
        val blips = ArrayList<RadarModel.Blip>()
        for (r in snap.reports) {
            // Fix 53 (NOBS-3): resolved reports are not threats — the banner
            // and the score already exclude them; the radar did not.
            if (r.status == "rejected" || r.status == "resolved") continue
            // Fix 54b: same coordinate check as the banner — an out-of-range
            // report must not render while the banner ignores it (CodeRabbit on PR #185).
            if (!ProximityLogic.isFresh(r.timestampMs, now) || !ProximityLogic.isValidCoordinates(r.lat, r.lng)) continue
            val kind = if (r.status == "verified") RadarModel.Kind.VERIFIED_REPORT else RadarModel.Kind.PENDING_REPORT
            blips.add(RadarModel.blipFrom(liveFix.lat, liveFix.lng, r.lat, r.lng, kind, r.locationName))
        }
        for (h in snap.hotspots) {
            if (h.confidence < 70) continue
            // Fix 54b: same coordinate check as the report loop (CodeRabbit on PR #185).
            if (!ProximityLogic.isFresh(h.scanTimeMs, now) || !ProximityLogic.isValidCoordinates(h.lat, h.lng)) continue
            blips.add(RadarModel.blipFrom(liveFix.lat, liveFix.lng, h.lat, h.lng, RadarModel.Kind.HOTSPOT, h.satellite))
        }
        for (s in snap.safezones) {
            blips.add(RadarModel.blipFrom(liveFix.lat, liveFix.lng, s.lat, s.lng, RadarModel.Kind.SAFEZONE, s.nameAr))
        }
        for (m in snap.meshIntel.filter { it.kind == "report" }) {
            val lat = m.lat ?: continue
            val lng = m.lng ?: continue
            // Fix 53 (NOBS-3): stale mesh blips are not threats — same
            // 30-minute window the banner uses (ProximityLogic.isFresh).
            // Fix 54 (NPROX-1): mesh pins get the same coordinate check as
            // the banner — a lat-360 pin must not render while the banner
            // ignores it (Fix 53 follow-up (4)).
            if (!ProximityLogic.isFresh(m.tsMs, now) || !ProximityLogic.isValidCoordinates(lat, lng)) continue
            blips.add(RadarModel.blipFrom(liveFix.lat, liveFix.lng, lat, lng, RadarModel.Kind.MESH_INTEL, m.text))
        }
        // Fix 21 (NOBS-2): a stale wind passes null (existing path in
        // RadarView.setData — the drift cone simply does not draw).
        val freshWind = snap.weather?.takeIf { RadarV2.weatherFresh(snap.weatherFetchedAtMs, now) }?.windFromDeg
        radar.setData(blips, userHasFix = true, windFromDeg = freshWind, headingDeg = currentHeadingDeg)

        // v2.19.0 awareness line: your wilaya + the nearest threat inside the
        // 30 km card (distance + Arabic compass direction) — "أين أنا وماذا
        // يفعل هذا الرادار" answered in one honest sentence.
        val wilaya = Wilayas.nearest(liveFix.lat, liveFix.lng)
        val nearest = blips.filter { it.kind != RadarModel.Kind.SAFEZONE }.minByOrNull { it.distKm }
        awarenessText?.text = if (nearest == null || nearest.distKm > RadarModel.RANGE_KM) {
            getString(R.string.radar_awareness_unknown_fmt, wilaya.nameAr)
        } else {
            val dirAr = TelemetryCamera.bearingDirectionAr(nearest.angleDeg)
            getString(R.string.radar_awareness_fmt, wilaya.nameAr, nearest.distKm, dirAr)
        }
    }

    private fun meshLabel(state: String): String = when (state) {
        "connected" -> getString(R.string.mesh_connected)
        "starting" -> getString(R.string.mesh_starting)
        "disconnected", "failed" -> getString(R.string.mesh_down)
        "unavailable" -> getString(R.string.mesh_unavailable)
        else -> getString(R.string.mesh_unknown)
    }

    override fun onDestroyView() {
        freshnessHandler.removeCallbacks(freshnessTick)
        app.locationEngine.removeListener(locationListener)
        headingEngine?.let { it.removeListener(headingListener); it.stop() }
        headingEngine = null
        super.onDestroyView()
        radarView = null
        radarModeLabel = null
        awarenessText = null
        gpsChip = null
        netChip = null
        meshChip = null
        riskScoreText = null
        riskLabelText = null
        riskDetailText = null
        riskBar = null
        riskBarMarker = null
        weatherText = null
        banner = null
        bannerText = null
    }
}
