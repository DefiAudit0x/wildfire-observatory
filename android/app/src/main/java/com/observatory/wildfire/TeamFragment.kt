package com.observatory.wildfire

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

/**
 * v2.0.0 — الفريق والشبكة. The member screen: join with the commander's
 * code (native door into the SAME TeamLocationService the WebView stack
 * used — beats, auto-arrival and the mission mirror are all unchanged,
 * battle-tested native code), plus the BLE mesh panel (state, peers, chat
 * log, echo broadcast) that works with zero connectivity.
 */
class TeamFragment : Fragment() {

    private val app get() = requireActivity().application as ObservatoryApp

    private var codeInput: EditText? = null
    private var nameInput: EditText? = null
    private var joinButton: View? = null
    private var joinError: TextView? = null
    private var statusCard: View? = null
    private var statusLine: TextView? = null
    private var missionLine: TextView? = null
    private var stopButton: View? = null
    private var meshStateLine: TextView? = null
    private var chatList: LinearLayout? = null
    private var chatInput: EditText? = null
    private var sendButton: View? = null
    private var renderedChatIds: HashSet<String> = HashSet()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_team, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        codeInput = view.findViewById(R.id.team_code)
        nameInput = view.findViewById(R.id.team_name)
        joinButton = view.findViewById(R.id.team_join)
        joinError = view.findViewById(R.id.team_join_error)
        statusCard = view.findViewById(R.id.team_status_card)
        statusLine = view.findViewById(R.id.team_status_line)
        missionLine = view.findViewById(R.id.team_mission_line)
        stopButton = view.findViewById(R.id.team_stop)
        meshStateLine = view.findViewById(R.id.mesh_state_line)
        chatList = view.findViewById(R.id.mesh_chat_list)
        chatInput = view.findViewById(R.id.mesh_input)
        sendButton = view.findViewById(R.id.mesh_send)

        // Saved join code/name survive restarts (the 12h token does NOT —
        // a rejoin mints a fresh one through the same endpoint).
        app.repository.savedTeamInfo()?.let { (code, name) ->
            codeInput?.setText(code)
            nameInput?.setText(name)
        }

        joinButton?.setOnClickListener { join() }
        stopButton?.setOnClickListener {
            app.repository.stopTeam()
            app.repository.clearSavedTeam()
        }
        sendButton?.setOnClickListener { sendMeshEcho() }

        view.findViewById<View>(R.id.team_open_console)?.setOnClickListener {
            try {
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(ObservatoryApp.PRODUCTION_BASE_URL))
                )
            } catch (e: Exception) {
                Toast.makeText(requireContext(), R.string.team_no_browser, Toast.LENGTH_SHORT).show()
            }
        }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repository.state.collect { snap -> render(snap) }
            }
        }
    }

    private fun join() {
        val ctx = context ?: return
        val code = codeInput?.text?.toString().orEmpty()
        val name = nameInput?.text?.toString().orEmpty()
        joinError?.text = ""
        joinButton?.isEnabled = false
        app.repository.joinTeam(code, name, app.deviceId) { ok, teamNameAr, error ->
            activity?.runOnUiThread {
                joinButton?.isEnabled = true
                if (ok) {
                    Toast.makeText(ctx, getString(R.string.team_joined_fmt, teamNameAr ?: ""), Toast.LENGTH_LONG).show()
                } else if (error != null) {
                    joinError?.text = error
                }
            }
        }
    }

    private fun render(snap: AppRepository.Snapshot) {
        val team = snap.team
        statusCard?.visibility = if (team.active) View.VISIBLE else View.GONE
        joinButton?.visibility = if (team.active) View.GONE else View.VISIBLE
        if (team.active) {
            statusLine?.text = getString(R.string.team_active_fmt, team.teamNameAr, team.state)
            missionLine?.text = when {
                team.missionJson == null -> getString(R.string.team_no_mission)
                else -> {
                    val phase = TeamLocationLogic.parseMissionPhase(team.missionJson) ?: "؟"
                    val target = TeamLocationLogic.parseMissionCoords(team.missionJson)
                    val fix = app.locationEngine.currentFix()
                    val distLine = if (target != null && fix != null) {
                        val km = TeamLocationLogic.haversineMeters(fix.lat, fix.lng, target.first, target.second) / 1000.0
                        getString(R.string.team_mission_dist_fmt, km)
                    } else ""
                    getString(R.string.team_mission_fmt, phaseLabel(phase), distLine)
                }
            }
        }

        meshStateLine?.text = getString(
            R.string.mesh_panel_fmt,
            meshStateLabel(snap.meshState),
            snap.meshPeers
        )

        renderChat(snap)
    }

    private fun meshStateLabel(state: String): String = when (state) {
        "connected" -> getString(R.string.mesh_connected)
        "starting" -> getString(R.string.mesh_starting)
        "disconnected", "failed" -> getString(R.string.mesh_down)
        "unavailable" -> getString(R.string.mesh_unavailable)
        else -> getString(R.string.mesh_unknown)
    }

    private fun phaseLabel(phase: String): String = when (phase) {
        "en_route" -> getString(R.string.phase_en_route)
        "on_scene" -> getString(R.string.phase_on_scene)
        else -> phase
    }

    private fun renderChat(snap: AppRepository.Snapshot) {
        val list = chatList ?: return
        val ctx = context ?: return
        for (entry in snap.meshChat) {
            if (renderedChatIds.contains(entry.id)) continue
            renderedChatIds.add(entry.id)
            val line = TextView(ctx).apply {
                text = getString(
                    if (entry.fromMe) R.string.mesh_entry_me_fmt else R.string.mesh_entry_fmt,
                    timeLabel(entry.tsMs),
                    entry.text.take(160)
                )
                setTextColor(
                    if (entry.fromMe) 0xFF7DD3FC.toInt()
                    else if (entry.kind == "sos") 0xFFFCA5A5.toInt()
                    else 0xFFCBD5E1.toInt()
                )
                textSize = 13f
                setPadding(0, 12, 0, 12)
            }
            list.addView(line)
        }
        while (list.childCount > 50) {
            list.removeViewAt(0)
        }
    }

    private fun timeLabel(tsMs: Long): String {
        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
        return sdf.format(java.util.Date(tsMs))
    }

    private fun sendMeshEcho() {
        val ctx = context ?: return
        val text = chatInput?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        val fix = app.locationEngine.currentFix()
        val ok = app.repository.broadcastMeshIntel(
            "report", text,
            fix?.lat ?: 36.7538, fix?.lng ?: 3.0588
        )
        chatInput?.setText("")
        Toast.makeText(
            ctx,
            if (ok) R.string.mesh_queued_local else R.string.mesh_unavailable_toast,
            Toast.LENGTH_SHORT
        ).show()
    }

    override fun onDestroyView() {
        codeInput = null
        nameInput = null
        joinButton = null
        joinError = null
        statusCard = null
        statusLine = null
        missionLine = null
        stopButton = null
        meshStateLine = null
        chatList = null
        chatInput = null
        sendButton = null
        renderedChatIds.clear()
        super.onDestroyView()
    }
}
