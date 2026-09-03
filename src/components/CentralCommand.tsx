import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Report, SatelliteHotspot, Language, TrappedSOS } from "../types";
import { Crown, RefreshCw } from "lucide-react";
import CommandLock from "./command/CommandLock";
import StatCards, { UserLocationData } from "./command/StatCards";
import CommandMap from "./command/CommandMap";
import SosPanel from "./command/SosPanel";
import ActivityFeed from "./command/ActivityFeed";
import RegisteredTeams from "./command/RegisteredTeams";
import ActiveUsersTable from "./command/ActiveUsersTable";
import ReportsTable from "./command/ReportsTable";
import ConfirmDialog from "./ui/ConfirmDialog";
import ToastStack from "./ui/ToastStack";
import useToasts from "../hooks/useToasts";
import { RegisteredTeam, MapTeamMember } from "./command/registeredTeams";
import { apiFetch, isSessionExpiry } from "../utils/adminApi";

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
  const [authChecking, setAuthChecking] = useState(true);
  const [activeUsers, setActiveUsers] = useState<UserLocationData[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [fullSos, setFullSos] = useState<TrappedSOS[]>(sosCalls);
  const [registeredTeams, setRegisteredTeams] = useState<RegisteredTeam[]>([]);
  const isArabic = lang === "ar";
  const [confirmResolve, setConfirmResolve] = useState<TrappedSOS | null>(null);
  const { toasts, push } = useToasts();
  // ARC-M32: one error ref used to guard BOTH the SOS and the locations
  // fetchers — the first failure silenced the other's toast until any success
  // reset the shared flag. Each consumer now owns its ref and resets it on its
  // own success.
  const sosErrorRef = useRef(false);
  const locationsErrorRef = useRef(false);
  const reportedFallbackRef = useRef(false);

  const fetchFullSos = useCallback(async () => {
    if (!unlocked) return;
    try {
      const res = await fetch("/api/sos/full", { credentials: "same-origin" });
      if (res.ok) {
        setFullSos(await res.json());
        sosErrorRef.current = false;
        const source = res.headers.get("X-SOS-Source");
        if (source === "memory_fallback" && !reportedFallbackRef.current) {
          reportedFallbackRef.current = true;
          push(
            isArabic ? "قاعدة بيانات الاستغاثات غير متاحة؛ المعروض حاليًا بيانات محلية مؤقتة." : "Base SOS indisponible : affichage local temporaire.",
            "error"
          );
        } else if (source === "firestore") {
          reportedFallbackRef.current = false;
        }
      } else if (!sosErrorRef.current) {
        sosErrorRef.current = true;
        push(isArabic ? "تعذر جلب قائمة الاستغاثات" : "Impossible de charger les SOS", "error");
      }
    } catch (err) {
      console.error("Failed to fetch full SOS list:", err);
      if (!sosErrorRef.current) {
        sosErrorRef.current = true;
        push(isArabic ? "تعذر جلب قائمة الاستغاثات" : "Impossible de charger les SOS", "error");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  const fetchUserLocations = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/locations", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setActiveUsers(data);
        locationsErrorRef.current = false;
      } else if (!locationsErrorRef.current) {
        locationsErrorRef.current = true;
        push(isArabic ? "تعذر جلب مواقع المستخدمين" : "Failed to load user locations", "error");
      }
      if (onRefresh) {
        onRefresh();
      }
    } catch (err) {
      console.error("Failed to fetch user locations:", err);
      if (!locationsErrorRef.current) {
        locationsErrorRef.current = true;
        push(isArabic ? "تعذر جلب مواقع المستخدمين" : "Failed to load user locations", "error");
      }
    } finally {
      setLoadingUsers(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRefresh]);

  const teamsFetchSeq = useRef(0);
  // B3 + W4: the panel can request inactive teams (deactivate/activate levers),
  // and the header shows whether a roster fetch is in flight + when data last
  // landed — an operator staring at a stale map mid-emergency can tell.
  const [showInactiveTeams, setShowInactiveTeams] = useState(false);
  const [teamsRefreshing, setTeamsRefreshing] = useState(false);
  const [teamsLastUpdated, setTeamsLastUpdated] = useState<number | null>(null);
  const fetchRegisteredTeams = useCallback(async (includeInactive?: boolean) => {
    if (!unlocked) return;
    const wantInactive = includeInactive ?? showInactiveTeams;
    // ARC-W1: this fetcher fires from three unsynchronized paths (the 15s
    // interval, post-dispatch refresh, onTeamsChanged). A slow response from
    // an EARLIER fetch used to land last and clobber fresher state — hiding a
    // just-reported mission, resurrecting a removed member chip. Only the
    // latest-issued fetch may commit state.
    const seq = ++teamsFetchSeq.current;
    setTeamsRefreshing(true);
    try {
      const res = await apiFetch(`/api/teams${wantInactive ? "?includeInactive=1" : ""}`, "GET");
      if (seq !== teamsFetchSeq.current) return;
      if (res.ok) {
        const data = (await res.json()) as RegisteredTeam[];
        if (seq !== teamsFetchSeq.current) return;
        if (Array.isArray(data)) {
          setRegisteredTeams(data);
          setTeamsLastUpdated(Date.now());
        }
      } else if (isSessionExpiry(res)) {
        setUnlocked(false);
      }
      // Silent on transient errors: the next 15s poll recovers on its own.
    } catch {
      // Network hiccup — the poll loop retries.
    } finally {
      if (seq === teamsFetchSeq.current) setTeamsRefreshing(false);
    }
  }, [unlocked, showInactiveTeams]);

  useEffect(() => {
    if (unlocked) {
      fetchFullSos();
      fetchUserLocations();
      fetchRegisteredTeams();
      const interval = setInterval(() => {
        fetchFullSos();
        fetchUserLocations();
        fetchRegisteredTeams();
      }, 15000);
      return () => clearInterval(interval);
    }
  }, [unlocked, fetchFullSos, fetchUserLocations, fetchRegisteredTeams]);

  useEffect(() => {
    let cancelled = false;
    const probeSession = async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (cancelled) return;
        if (res.ok) {
          setUnlocked(true);
        }
      } catch {
        // no session
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    };
    probeSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // v2.3.0 (simulation purge): getTeamsStatusAndPositions — the six phantom
  // units that glided toward SOS calls on a fabricated 2-minute timer — is
  // gone. Every team surface below reads the live registered-team roster.
  // Memoized: the map's marker effect rebuilds on identity change — without
  // this, every unrelated CentralCommand render would churn the layer too.
  const mapTeamMembers: MapTeamMember[] = useMemo(
    () =>
      registeredTeams.flatMap((team) =>
        team.members
          .filter((m) => m.lat !== null && m.lng !== null)
          .map((m) => ({
            memberId: m.memberId,
            name: m.name,
            online: m.online,
            lat: m.lat as number,
            lng: m.lng as number,
            accuracy: m.accuracy,
            speed: m.speed,
            batteryPct: m.batteryPct,
            lastSeen: m.lastSeenAt,
            trail: m.trail,
            teamId: team.teamId,
            teamName: isArabic ? team.nameAr : team.name,
            teamType: team.type,
          }))
      ),
    [registeredTeams, isArabic]
  );

  const handleUnlocked = () => {
    setUnlocked(true);
  };

  const applyLocalDispatch = (sosId: string, dispatchItem: any) => {
    setFullSos((prev) =>
      prev.map((s) =>
        s.id === sosId
          ? { ...s, dispatchedTeams: [...(s.dispatchedTeams || []), dispatchItem] }
          : s
      )
    );
  };

  const sendDispatchRequest = async (sosId: string, body: any): Promise<boolean> => {
    try {
      // ARC-W2 + ARC-R7: this was a raw fetch — a dead session came back as a
      // generic failure ("فريق مشغول" lie, no relock) and a hung link wedged
      // the dispatch button for minutes. It now rides apiFetch (15s ceiling)
      // and routes 401 through the one session-expiry classifier (ARC-M33).
      const res = await apiFetch(`/api/sos/${encodeURIComponent(sosId)}/dispatch`, "POST", body);
      if (isSessionExpiry(res)) {
        setUnlocked(false);
        return false;
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        applyLocalDispatch(sosId, data?.dispatch || body);
        if (onRefresh) onRefresh();
        return true;
      }
      return false;
    } catch (err) {
      console.error("Dispatch request failed:", err);
      return false;
    }
  };

  // v2.3.0: single dispatch path — a REGISTERED team by server identity.
  // The legacy free-text dispatch (phantom unit names) was removed with the
  // simulated tables; the server now rejects anything but teamId.
  const handleDispatchRegistered = async (sosId: string, teamId: string, notes: string): Promise<boolean> => {
    setDispatchLoading(true);
    try {
      const ok = await sendDispatchRequest(sosId, { teamId, notes: notes || "" });
      // ARC-W1: refresh on BOTH outcomes — a 409 usually means another tab
      // dispatched this team first, and the operator's roster is stale.
      await fetchRegisteredTeams();
      return ok;
    } finally {
      setDispatchLoading(false);
    }
  };

  const handleTargetMember = (teamId: string, memberId: string) => {
    const team = registeredTeams.find((t) => t.teamId === teamId);
    const member = team?.members.find((m) => m.memberId === memberId);
    if (!team || !member || member.lat === null || member.lng === null) return;
    setFocus({
      lat: member.lat,
      lng: member.lng,
      html: `
        <div class="text-xs font-mono p-1 text-slate-100" dir="${isArabic ? "rtl" : "ltr"}">
          <strong class="text-amber-400">⌖ ${esc(member.name)}</strong><br/>
          <span class="text-slate-300">${esc(isArabic ? team.nameAr : team.name)}</span><br/>
          <span class="text-gray-500 text-[10px]">GPS: ${member.lat.toFixed(5)}, ${member.lng.toFixed(5)}</span>
        </div>
      `,
    });
  };

  const handleResolveSos = async (sos: TrappedSOS) => {
    try {
      const res = await fetch(`/api/sos/${sos.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
        setFullSos((prev) => prev.filter((s) => s.id !== sos.id));
        push(isArabic ? `تم إثبات النجدة — ${sos.name} بأمان` : `SOS résolu — ${sos.name} sain et sauf`);
      } else {
        push(isArabic ? "فشل حل الاستغاثة" : "Échec de résolution du SOS", "error");
      }
    } catch (err) {
      console.error(err);
      push(isArabic ? "فشل حل الاستغاثة" : "Échec de résolution du SOS", "error");
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

  if (authChecking) {
    return (
      <div className="col-span-12 max-w-md mx-auto mt-12">
        <div className="bg-zinc-900/70 border border-amber-500/20 rounded-2xl p-8 shadow-[0_8px_40px_rgba(0,0,0,0.6)] text-center space-y-4">
          <div className="mx-auto w-12 h-12 bg-zinc-800 rounded-2xl flex items-center justify-center">
            <RefreshCw className="h-6 w-6 text-amber-400 animate-spin" />
          </div>
          <p className="text-sm text-slate-300">{isArabic ? "جارٍ التحقق من الجلسة..." : "Vérification de la session..."}</p>
        </div>
      </div>
    );
  }

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
        sosCalls={fullSos}
        activeUsers={activeUsers}
        registeredTeams={registeredTeams}
      />

      {/* Map + Activity Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <CommandMap
          isArabic={isArabic}
          satellites={satellites}
          activeUsers={activeUsers}
          reports={reports}
          sosCalls={fullSos}
          teamMembers={mapTeamMembers}
          focus={focus}
        />

        {/* Dual-Panel Sidebar: Active SOS alerts + Activity Feed */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          <SosPanel
            isArabic={isArabic}
            sosCalls={fullSos}
            dispatchLoading={dispatchLoading}
            registeredTeams={registeredTeams}
            onDispatch={handleDispatchRegistered}
            onResolve={(sos) => setConfirmResolve(sos)}
            onFocusSos={handleFocusSos}
            onAudioError={() => push(isArabic ? "تعذر تحميل التسجيل الصوتي" : "Impossible de charger l'audio", "error")}
          />
          <ActivityFeed isArabic={isArabic} reports={reports} />
        </div>
      </div>

      {/* Rescue & Support Teams Panel — the real registered roster (v2.3.0:
          the simulated dispatch table that used to sit below was removed) */}
      <RegisteredTeams
        isArabic={isArabic}
        teams={registeredTeams}
        sosCalls={fullSos}
        dispatchLoading={dispatchLoading}
        refreshing={teamsRefreshing}
        lastUpdated={teamsLastUpdated}
        showInactive={showInactiveTeams}
        onToggleInactive={() => {
          const next = !showInactiveTeams;
          setShowInactiveTeams(next);
          void fetchRegisteredTeams(next);
        }}
        onDispatch={(teamId, sosId, notes) => handleDispatchRegistered(sosId, teamId, notes)}
        onTargetMember={handleTargetMember}
        onTeamsChanged={fetchRegisteredTeams}
        onSessionExpired={() => setUnlocked(false)}
        notify={push}
      />

      {/* Full Reports Registry */}
      <ReportsTable
        isArabic={isArabic}
        reports={reports}
        onChanged={onRefresh || (() => {})}
        notify={push}
      />

      {/* User Locations Table */}
      <ActiveUsersTable isArabic={isArabic} activeUsers={activeUsers} />
      <ConfirmDialog
        open={confirmResolve !== null}
        title={isArabic ? "تأكيد الإثبات" : "Confirmer le sauvetage"}
        message={confirmResolve
          ? (isArabic ? `هل تم إنقاذ ${confirmResolve.name} وحل الاستغاثة؟` : `Marquer ${confirmResolve.name} comme secouru ?`)
          : ""}
        confirmLabel={isArabic ? "تم الإنقاذ" : "Secouru"}
        danger={false}
        onConfirm={() => {
          const sos = confirmResolve;
          setConfirmResolve(null);
          if (sos) handleResolveSos(sos);
        }}
        onCancel={() => setConfirmResolve(null)}
        lang={lang}
      />
      <ToastStack toasts={toasts} />
    </div>
  );
}
