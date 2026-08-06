import { useState, useEffect, useCallback } from "react";
import { Report, SatelliteHotspot, Language, TrappedSOS } from "../types";
import { Crown, RefreshCw } from "lucide-react";
import CommandLock from "./command/CommandLock";
import StatCards, { UserLocationData } from "./command/StatCards";
import CommandMap from "./command/CommandMap";
import SosPanel from "./command/SosPanel";
import ActivityFeed from "./command/ActivityFeed";
import TeamsTable from "./command/TeamsTable";
import ActiveUsersTable from "./command/ActiveUsersTable";
import { getTeamsStatusAndPositions, getTeamNames, getTeamStatusBadge, TeamStatus } from "./command/teams";

interface CentralCommandProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  sosCalls?: TrappedSOS[];
  userLocation: { lat: number; lng: number } | null;
  lang: Language;
  onRefresh?: () => void;
}

interface FocusTarget {
  lat: number;
  lng: number;
  html: string;
}

function esc(value: unknown): string {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

export default function CentralCommand({ reports, satellites, sosCalls = [], userLocation, lang, onRefresh }: CentralCommandProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [commandToken, setCommandToken] = useState("");
  const [activeUsers, setActiveUsers] = useState<UserLocationData[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const isArabic = lang === "ar";

  const fetchUserLocations = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/locations", {
        headers: { Authorization: `Bearer ${commandToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setActiveUsers(data);
      }
      if (onRefresh) {
        onRefresh();
      }
    } catch (err) {
      console.error("Failed to fetch user locations:", err);
    } finally {
      setLoadingUsers(false);
    }
  }, [commandToken, onRefresh]);

  useEffect(() => {
    if (unlocked) {
      fetchUserLocations();
      const interval = setInterval(fetchUserLocations, 15000);
      return () => clearInterval(interval);
    }
  }, [unlocked, fetchUserLocations]);

  const teams = getTeamsStatusAndPositions(sosCalls);

  const handleUnlocked = (token: string) => {
    sessionStorage.setItem("command_token", token);
    setCommandToken(token);
    setUnlocked(true);
  };

  const handleDispatchSubmit = async (sosId: string, type: "protection_civile" | "volunteers", teamId: string, notes: string): Promise<boolean> => {
    if (!teamId) return false;
    setDispatchLoading(true);
    const names = getTeamNames(teamId);
    try {
      const res = await fetch(`/api/sos/${sosId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${commandToken}` },
        body: JSON.stringify({
          type,
          teamNameAr: names.nameAr,
          teamNameFr: names.nameFr,
          notes: notes || "",
        }),
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
        return true;
      }
      return false;
    } catch (err) {
      console.error("Dispatch request failed:", err);
      return false;
    } finally {
      setDispatchLoading(false);
    }
  };

  const handleDirectDispatch = async (teamId: string, sosId: string, notes: string) => {
    if (!sosId) return;
    setDispatchLoading(true);

    const team = teams.find((t) => t.id === teamId);
    if (!team) {
      setDispatchLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/sos/${sosId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${commandToken}` },
        body: JSON.stringify({
          type: team.type,
          teamNameAr: team.teamNameAr,
          teamNameFr: team.teamNameFr,
          notes: notes || "",
        }),
      });

      if (res.ok) {
        if (onRefresh) onRefresh();
      }
    } catch (err) {
      console.error("Direct dispatch failed:", err);
    } finally {
      setDispatchLoading(false);
    }
  };

  const handleResolveSos = async (sos: TrappedSOS) => {
    if (!confirm(isArabic ? `تأكيد إنقاذ ${sos.name} وحل الاستغاثة؟` : `Marquer ${sos.name} comme secouru ?`)) return;
    try {
      const res = await fetch(`/api/sos/${sos.id}/resolve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${commandToken}` },
      });
      if (res.ok && onRefresh) onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const handleFocusSos = (sos: TrappedSOS) => {
    setFocus({
      lat: sos.lat,
      lng: sos.lng,
      html: `
        <div class="text-xs font-mono">
          <strong style="color:#ef4444;">🚨 SOS: ${esc(sos.name)}</strong><br/>
          ${sos.phone ? `Tél: ${esc(sos.phone)}` : ""}
        </div>
      `,
    });
  };

  const handleTargetTeam = (team: TeamStatus) => {
    const badge = getTeamStatusBadge(team, isArabic);
    setFocus({
      lat: team.currentLat,
      lng: team.currentLng,
      html: `
        <div class="text-xs font-mono p-1 text-slate-100" dir="${isArabic ? "rtl" : "ltr"}">
          <strong class="text-amber-400">${esc(team.emoji)} ${esc(isArabic ? team.teamNameAr : team.teamNameFr)}</strong><br/>
          <span class="text-slate-300">${esc(badge.text)}</span><br/>
          <span class="text-gray-500 text-[10px]">GPS: ${team.currentLat.toFixed(4)}, ${team.currentLng.toFixed(4)}</span>
        </div>
      `,
    });
  };

  if (!unlocked) {
    return <CommandLock lang={lang} onUnlocked={handleUnlocked} />;
  }

  return (
    <div className="col-span-12 space-y-4">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-950/40 via-zinc-950 to-amber-950/40 border border-amber-500/10 rounded-2xl p-4 md:p-6 shadow-[0_4px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-gradient-to-br from-amber-600 to-yellow-500 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.15)]">
              <Crown className="h-6 w-6 text-white" />
            </div>
            <div>
              <h2 className="font-extrabold text-lg text-amber-400 flex items-center gap-2">
                {isArabic ? "القيادة المركزية" : "Commandement Central"}
                <span className="bg-amber-500/10 text-amber-400 text-[9px] px-1.5 py-0.5 rounded-full border border-amber-500/20 font-bold">
                  SUPER ADMIN
                </span>
              </h2>
              <p className="text-[10px] text-gray-500">
                {isArabic ? "رؤية شاملة — كل المستخدمين، كل البلاغات، كل البؤر" : "Vision globale — Tous les utilisateurs, tous les signalements, tous les foyers"}
              </p>
            </div>
          </div>
          <button
            onClick={fetchUserLocations}
            disabled={loadingUsers}
            className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${loadingUsers ? "animate-spin" : ""}`} />
            {isArabic ? "تحديث" : "Rafraîchir"}
          </button>
        </div>
      </div>

      <StatCards
        isArabic={isArabic}
        reports={reports}
        satellites={satellites}
        sosCalls={sosCalls}
        activeUsers={activeUsers}
      />

      {/* Map + Activity Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <CommandMap
          isArabic={isArabic}
          satellites={satellites}
          activeUsers={activeUsers}
          reports={reports}
          sosCalls={sosCalls}
          teams={teams}
          focus={focus}
        />

        {/* Dual-Panel Sidebar: Active SOS alerts + Activity Feed */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          <SosPanel
            isArabic={isArabic}
            sosCalls={sosCalls}
            dispatchLoading={dispatchLoading}
            onDispatch={handleDispatchSubmit}
            onResolve={handleResolveSos}
            onFocusSos={handleFocusSos}
          />
          <ActivityFeed isArabic={isArabic} reports={reports} />
        </div>
      </div>

      {/* Rescue & Support Teams Panel & Dispatcher Table */}
      <TeamsTable
        isArabic={isArabic}
        teams={teams}
        sosCalls={sosCalls}
        dispatchLoading={dispatchLoading}
        onDirectDispatch={handleDirectDispatch}
        onTargetTeam={handleTargetTeam}
      />

      {/* User Locations Table */}
      <ActiveUsersTable isArabic={isArabic} activeUsers={activeUsers} />
    </div>
  );
}
