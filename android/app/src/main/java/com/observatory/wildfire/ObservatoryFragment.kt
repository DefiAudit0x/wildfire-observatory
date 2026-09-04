package com.observatory.wildfire

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
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
    private var weatherRequested = false

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
        gpsChip = view.findViewById(R.id.chip_gps)
        netChip = view.findViewById(R.id.chip_net)
        meshChip = view.findViewById(R.id.chip_mesh)
        riskScoreText = view.findViewById(R.id.risk_score)
        riskLabelText = view.findViewById(R.id.risk_label)
        riskDetailText = view.findViewById(R.id.risk_detail)
        weatherText = view.findViewById(R.id.weather_line)
        banner = view.findViewById(R.id.proximity_banner)
        bannerText = view.findViewById(R.id.proximity_text)
        view.findViewById<View>(R.id.proximity_action)?.setOnClickListener {
            (activity as? NativeMainActivity)?.openMapTab()
        }

        app.locationEngine.addListener(locationListener)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap -> render(snap) }
            }
        }
    }

    private fun renderGps(state: LocationEngine.State) {
        val ctx = context ?: return
        val (text, color) = when (state.status) {
            LocationLogic.Status.NO_PERMISSION ->
                getString(R.string.gps_no_permission) to 0xFFF59E0B.toInt()
            LocationLogic.Status.PROVIDERS_OFF ->
                getString(R.string.gps_providers_off) to 0xFFF59E0B.toInt()
            LocationLogic.Status.SEARCHING ->
                getString(R.string.gps_searching) to 0xFF38BDF8.toInt()
            LocationLogic.Status.FIXED -> {
                val fix = state.fix
                val fresh = fix != null && LocationLogic.isFreshFix(fix, System.currentTimeMillis())
                val acc = fix?.accuracyM?.toInt() ?: 0
                val label = if (fresh) {
                    getString(R.string.gps_fixed_fmt, acc)
                } else {
                    getString(R.string.gps_stale_fmt, acc)
                }
                label to 0xFF10B981.toInt()
            }
        }
        gpsChip?.text = text
        gpsChip?.setTextColor(color)

        // Weather follows the fix (fetched at most once per fragment view).
        val fix = state.fix
        if (!weatherRequested && fix != null && LocationLogic.isFreshFix(fix, System.currentTimeMillis())) {
            weatherRequested = true
            app.repository.fetchWeatherAt(fix.lat, fix.lng) { w ->
                activity?.runOnUiThread {
                    weatherText?.visibility = if (w == null) View.GONE else View.VISIBLE
                    w?.let {
                        weatherText?.text = getString(
                            R.string.weather_fmt,
                            it.tempC.toInt(), it.humidityPct, it.windKph.toInt(), it.windFromDeg.toInt()
                        )
                    }
                }
            }
        }
        updateRadar()
    }

    private fun render(snap: AppRepository.Snapshot) {
        val ctx = context ?: return

        netChip?.text = if (snap.online) getString(R.string.net_online) else getString(R.string.net_offline)
        netChip?.setTextColor(if (snap.online) 0xFF10B981.toInt() else 0xFFF87171.toInt())
        meshChip?.text = getString(R.string.mesh_state_fmt, meshLabel(snap.meshState), snap.meshPeers)
        meshChip?.setTextColor(if (snap.meshState == "connected") 0xFF22D3EE.toInt() else 0xFF94A3B8.toInt())

        // Risk gauge from the SAME freshness rule as the banner (one authority).
        // v2.15.0 audit fix: RESOLVED fires no longer feed the CURRENT-risk
        // gauge (verified==resolved was double-counting an extinguished fire
        // forever), and reports are FRESHNESS-gated before scoring (the list
        // variable used to be named "fresh" while never gating on freshness).
        // Resolved incidents still count in the honest detail line below.
        val now = System.currentTimeMillis()
        val scoredReports = snap.reports.filter {
            it.status != "rejected" && it.status != "resolved" &&
                ProximityLogic.isFresh(it.timestampMs, now)
        }
        val score = RiskScore.score(
            scoredReports.map { it.severity to (it.status == "verified") },
            snap.hotspots.count { it.confidence >= 70 && ProximityLogic.isFresh(it.scanTimeMs, now) }
        )
        riskScoreText?.text = score.toString()
        // v2.1.0: band the number's color — a calm 6/100 must never scream red.
        riskScoreText?.setTextColor(
            when {
                score < 25 -> 0xFF10B981.toInt()
                score < 50 -> 0xFFF59E0B.toInt()
                score < 75 -> 0xFFF97316.toInt()
                else -> 0xFFEF4444.toInt()
            }
        )
        riskLabelText?.text = RiskScore.labelAr(score)
        riskDetailText?.text = getString(
            R.string.risk_detail_fmt,
            snap.reports.count { it.status == "verified" },
            snap.reports.count { it.status != "verified" && it.status != "rejected" && it.status != "resolved" },
            snap.hotspots.count { it.confidence >= 70 }
        )

        // Proximity banner — needs a user position.
        val fix = app.locationEngine.currentFix()
        banner?.visibility = View.GONE
        if (fix != null) {
            val pins = freshReports.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.timestampMs) } +
                snap.hotspots.map { ProximityLogic.ThreatPin(it.lat, it.lng, it.scanTimeMs) } +
                snap.meshIntel.mapNotNull { intel ->
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
                            ProximityLogic.Level.CRITICAL -> 0x33EF4444
                            ProximityLogic.Level.WARNING -> 0x33F59E0B
                            ProximityLogic.Level.WATCH -> 0x3338BDF8
                        }
                    )
                }
            }
        }
        updateRadar()
    }

    private fun updateRadar() {
        val radar = radarView ?: return
        val snap = app.repository.state.value
        val fix = app.locationEngine.currentFix()
        val now = System.currentTimeMillis()

        if (fix == null) {
            radar.setData(emptyList(), userHasFix = false, windFromDeg = null)
            return
        }
        val blips = ArrayList<RadarModel.Blip>()
        for (r in snap.reports) {
            if (r.status == "rejected") continue
            if (!ProximityLogic.isFresh(r.timestampMs, now)) continue
            val kind = if (r.status == "verified") RadarModel.Kind.VERIFIED_REPORT else RadarModel.Kind.PENDING_REPORT
            blips.add(RadarModel.blipFrom(fix.lat, fix.lng, r.lat, r.lng, kind, r.locationName))
        }
        for (h in snap.hotspots) {
            if (h.confidence < 70) continue
            if (!ProximityLogic.isFresh(h.scanTimeMs, now)) continue
            blips.add(RadarModel.blipFrom(fix.lat, fix.lng, h.lat, h.lng, RadarModel.Kind.HOTSPOT, h.satellite))
        }
        for (s in snap.safezones) {
            blips.add(RadarModel.blipFrom(fix.lat, fix.lng, s.lat, s.lng, RadarModel.Kind.SAFEZONE, s.nameAr))
        }
        for (m in snap.meshIntel) {
            val lat = m.lat ?: continue
            val lng = m.lng ?: continue
            blips.add(RadarModel.blipFrom(fix.lat, fix.lng, lat, lng, RadarModel.Kind.MESH_INTEL, m.text))
        }
        radar.setData(blips, userHasFix = true, windFromDeg = snap.weather?.windFromDeg)
    }

    private fun meshLabel(state: String): String = when (state) {
        "connected" -> getString(R.string.mesh_connected)
        "starting" -> getString(R.string.mesh_starting)
        "disconnected", "failed" -> getString(R.string.mesh_down)
        "unavailable" -> getString(R.string.mesh_unavailable)
        else -> getString(R.string.mesh_unknown)
    }

    override fun onDestroyView() {
        app.locationEngine.removeListener(locationListener)
        super.onDestroyView()
        radarView = null
        gpsChip = null
        netChip = null
        meshChip = null
        riskScoreText = null
        riskLabelText = null
        riskDetailText = null
        weatherText = null
        banner = null
        bannerText = null
    }
}
