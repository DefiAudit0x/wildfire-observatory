import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Radio, Navigation, LogOut, MapPin, ShieldAlert, Smartphone, CheckCircle2 } from "lucide-react";
import { Language } from "../types";
import {
  ARRIVAL_RADIUS_M,
  ARRIVAL_STREAK_NEEDED,
  TeamFatalCode,
  TeamMissionState,
  TeamSessionState,
  buildNativeTrackingConfig,
  clearTeamSession,
  distanceMeters,
  flipMissionOnScene,
  getTeamTrackingBridge,
  joinTeam,
  leaveTeam,
  loadTeamSession,
  normalizeNativeMission,
  openMissionNavigation,
  probeTeamSession,
  saveTeamSession,
  sendTeamHeartbeat,
  updateArrivalStreak,
} from "../utils/teamSession";

/**
 * Phase 2 — the team-member panel (لوحة الفريق).
 *
 * Field-device surface for registered teams: join by dispatcher code, then a
 * self-driving GPS heartbeat loop (server-paced via heartbeatIntervalMs) that
 * keeps the command map live and the member's mission state in sync. On
 * Android the member can delegate the loop to the native foreground service
 * (TeamLocationService) which survives screen-off/backgrounding — the WebView
 * JS loop cannot (system suspends its timers), so the two modes are mutually
 * exclusive and the panel switches between them by listening to the native
 * `teamTrackingState` event.
 *
 * Session death is ALWAYS the server's verdict (401/403 gate chain), never a
 * guess from a network error: transient failures keep the session alive and
 * simply flag the connection, because a needless local logout would force a
 * code re-join and burn the code budget (Round B finding).
 */

function missionLabel(phase: string | null | undefined, isArabic: boolean): string {
  if (phase === "on_scene") return isArabic ? "في موقع الحادث" : "Sur les lieux";
  if (phase === "en_route") return isArabic ? "في الطريق إلى الموقع" : "En route vers les lieux";
  return isArabic ? "لا توجد مهمة حالية" : "Aucune mission active";
}

function teamFatalMessage(code: TeamFatalCode | undefined, isArabic: boolean): string {
  switch (code) {
    case "MEMBER_REVOKED":
      return isArabic
        ? "أُلغيت عضويتك من قِبل قيادة الحملة — تواصل مع قائد الفريق."
        : "Votre adhésion a été révoquée par le commandement.";
    case "MEMBER_INACTIVE":
      return isArabic
        ? "العضوية موقوفة حالياً — تواصل مع قيادة الحملة."
        : "Adhésion désactivée — contactez le commandement.";
    case "TEAM_INACTIVE":
      return isArabic
        ? "هذا الفريق موقوف حالياً من قِبل القيادة."
        : "Cette équipe est désactivée par le commandement.";
    case "MEMBER_INVALID":
      return isArabic
        ? "لم يُعثر على العضوية — انضم مجدداً برمز صالح."
        : "Adhésion introuvable — rejoignez avec un code valide.";
    default:
      return isArabic
        ? "انتهت جلسة الفريق — انضم مجدداً برمز الفريق."
        : "Session d'équipe expirée — rejoignez avec le code.";
  }
}

type BeatState = "idle" | "waiting-gps" | "live" | "transient";

interface TeamPanelProps {
  lang: Language;
}

export default function TeamPanel({ lang }: TeamPanelProps) {
  const isArabic = lang === "ar";
  const [session, setSession] = useState<TeamSessionState | null>(() => loadTeamSession());
  const [resuming, setResuming] = useState<boolean>(() => loadTeamSession() !== null);
  const [mission, setMission] = useState<TeamMissionState | null>(null);
  const [intervalMs, setIntervalMs] = useState(15_000);
  const [beat, setBeat] = useState<BeatState>("idle");
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [sessionFatal, setSessionFatal] = useState<TeamFatalCode | null>(null);

  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const [flipBusy, setFlipBusy] = useState(false);
  const [flipNote, setFlipNote] = useState<string | null>(null);

  // F4 (A3/P3): the panel ASKS the bridge for the live FGS state, and it asks
  // SYNCHRONOUSLY at first render — an effect-based query would race the
  // heartbeat loop's immediate first tick (effects run in declaration order,
  // and the loop's mount tick would fire exactly one JS beat beside the FGS
  // on every re-mount). Absent bridge / absent method → false, matching the
  // feature-detection doctrine.
  const [nativeActive, setNativeActive] = useState<boolean>(() => {
    const bridge = getTeamTrackingBridge();
    return typeof bridge?.isTeamTrackingActive === "function" && bridge.isTeamTrackingActive() === true;
  });
  const [nativeHint, setNativeHint] = useState<string | null>(null);

  // Overlap guard: one in-flight beat at a time — a slow 15s request must not
  // stack with the next tick (same single-flight lesson as the relay queue).
  const beatBusyRef = useRef(false);
  const sessionRef = useRef<TeamSessionState | null>(session);
  sessionRef.current = session;

  // F7 (P6): monotonic mission-source sequence — join/probe/beat/flip/native-
  // beat each take a number when they START and may only commit setMission
  // while still the newest source. A heartbeat launched before the member
  // pressed "وصلت إلى الموقع" must never flash its older en_route verdict
  // over the on_scene answer (the W1 family, applied inside the panel).
  const missionSeqRef = useRef(0);

  // Phase 3 — auto-arrival chain: which mission the streak belongs to, and
  // how many CONSECUTIVE fixes have landed inside the radius. Reset on every
  // mission change and every out-of-range fix (one stray GPS jump is not an
  // arrival — ARCHITECTURE.md §5.5).
  const arrivalStreakRef = useRef(0);
  const arrivalMissionRef = useRef<string | null>(null);

  // ======================
  // RESUME: validate the persisted token once on mount. The server verdict is
  // the only authority — a network hiccup keeps the session (retry happens
  // with the heartbeat loop), a fatal code clears it with a reason.
  // ======================
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const seq = ++missionSeqRef.current; // F7: probe is a mission source
    (async () => {
      const result = await probeTeamSession(session.token);
      if (cancelled) return;
      setResuming(false);
      // F5 (P4): stale-probe guard — this verdict belongs to the session that
      // was current AT MOUNT. If the session changed mid-flight (the native
      // revoked event cleared it and a fresh join landed, or leave happened),
      // applying it would wipe the NEW session and burn another join code —
      // the same W1 discipline the beat path already has.
      if (sessionRef.current !== session) return;
      if (result.ok) {
        if (missionSeqRef.current === seq) setMission(result.mission ?? null);
        if (result.heartbeatIntervalMs) setIntervalMs(result.heartbeatIntervalMs);
        const refreshed: TeamSessionState = {
          ...session,
          teamName: result.teamName || session.teamName,
          teamNameAr: result.teamNameAr || session.teamNameAr,
          name: result.name || session.name,
        };
        setSession(refreshed);
        saveTeamSession(refreshed);
      } else if (result.fatal) {
        clearTeamSession();
        setSession(null);
        setSessionFatal(result.fatal);
      }
      // transient: keep session + resuming=false; the heartbeat loop retries.
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ======================
  // BROWSER HEARTBEAT LOOP — only while no native FGS owns the stream.
  // One interval for the session's lifetime; GPS fixes refresh through the
  // tick, so a chatty receiver never tears the loop down.
  // ======================
  useEffect(() => {
    if (!session || nativeActive) {
      setBeat((prev) => (prev === "idle" || prev === "waiting-gps" ? prev : "idle"));
      return;
    }
    const tick = async () => {
      const current = sessionRef.current;
      if (!current || beatBusyRef.current) return;
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setBeat("waiting-gps");
        return;
      }
      beatBusyRef.current = true;
      setBeat((prev) => (prev === "live" ? "live" : "waiting-gps"));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            beatBusyRef.current = false;
            setBeat("waiting-gps");
            return;
          }
          const seq = ++missionSeqRef.current; // F7: this beat is the newest mission source
          try {
            const verdict = await sendTeamHeartbeat(current.token, {
              lat,
              lng,
              accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
              heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
              speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
            });
            if (sessionRef.current !== current) return; // stale beat — session changed mid-flight
            if (verdict.ok) {
              // F7 (P6): only commit while still the newest source — a flip
              // (or join/probe/native beat) that started after this beat was
              // launched is the fresher authority; the older en_route response
              // must not flash over on_scene on a field screen.
              if (missionSeqRef.current === seq) {
                setMission(verdict.mission);
                // Phase 3 — auto-arrival (JS loop only; the native FGS runs
                // its own chain). TWO consecutive fixes inside the radius
                // fire ONE evidence flip; the server re-verifies the
                // geometry before accepting. The flip commits under the
                // SAME seq as its parent beat: it is fresher than that
                // beat, and any newer source (next beat / join) correctly
                // discards it.
                const m = verdict.mission;
                if (arrivalMissionRef.current !== (m?.sosId ?? null)) {
                  arrivalMissionRef.current = m?.sosId ?? null;
                  arrivalStreakRef.current = 0;
                }
                if (m && m.phase === "en_route" && m.sosLat !== null && m.sosLng !== null) {
                  const dist = distanceMeters(lat, lng, m.sosLat, m.sosLng);
                  arrivalStreakRef.current = updateArrivalStreak(arrivalStreakRef.current, dist <= ARRIVAL_RADIUS_M);
                  if (arrivalStreakRef.current >= ARRIVAL_STREAK_NEEDED) {
                    arrivalStreakRef.current = 0;
                    void flipMissionOnScene(current.token, {
                      lat,
                      lng,
                      accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
                    }).then((res) => {
                      if (sessionRef.current !== current) return;
                      if (res.ok && missionSeqRef.current === seq) setMission(res.mission ?? null);
                      // rejected/transient: the streak is already zero — two
                      // fresh in-range beats will re-attempt; the manual
                      // button stays available either way.
                    });
                  }
                }
              }
              if (verdict.heartbeatIntervalMs) setIntervalMs(verdict.heartbeatIntervalMs);
              setBeat("live");
              setLastBeatAt(Date.now());
            } else if (verdict.fatal) {
              clearTeamSession();
              setSession(null);
              setSessionFatal(verdict.fatal);
              setBeat("idle");
            } else {
              setBeat("transient");
            }
          } catch {
            setBeat("transient");
          } finally {
            beatBusyRef.current = false;
          }
        },
        () => {
          // GPS loss is NOT a verdict: keep the session, flag the state.
          beatBusyRef.current = false;
          setBeat("waiting-gps");
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 }
      );
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [session, nativeActive, intervalMs]);

  // ======================
  // NATIVE STATE EVENTS — the FGS reports started/stopped/revoked/error/beat;
  // combined with the synchronous isTeamTrackingActive() mount query (F4),
  // the panel never guesses what the service is doing.
  // ======================
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const state = String(detail.state || "");
      if (state === "started") {
        setNativeActive(true);
        setNativeHint(null);
      } else if (state === "stopped") {
        setNativeActive(false);
      } else if (state === "revoked") {
        setNativeActive(false);
        clearTeamSession();
        setSession(null);
        setSessionFatal("MEMBER_REVOKED");
      } else if (state === "error") {
        // F2 (P1): the service emits "error" right before stopSelf for EVERY
        // fatal verdict except MEMBER_REVOKED (expired 12h token, MEMBER_-
        // INACTIVE/INVALID, TEAM_INACTIVE). The old text ("سيُعاد تلقائياً")
        // was a lie — the service is DEAD — and leaving nativeActive=true
        // suspended the JS loop forever: a green "تتبع خلفي نشط" chip over a
        // dead stream while the member silently dropped off the command map
        // after the 90s online window. Honest reset: stop the mirror, then
        // let the server's verdict name the real reason (expired token ≠
        // network blip) without needing a GPS fix.
        setNativeActive(false);
        setNativeHint(
          isArabic
            ? "توقفت خدمة التتبع الخلفي — جارٍ التحقق من الجلسة..."
            : "Le suivi natif s'est arrêté — vérification de la session..."
        );
        const probedToken = sessionRef.current?.token;
        if (!probedToken) return;
        void probeTeamSession(probedToken).then((result) => {
          // F5 doctrine: the probe was launched for THIS token; a session
          // change mid-flight (fresh join / leave) makes the verdict stale.
          if (sessionRef.current?.token !== probedToken) return;
          if (result.fatal) {
            setNativeHint(null);
            clearTeamSession();
            setSession(null);
            setSessionFatal(result.fatal);
          } else if (result.ok) {
            // Session alive — the JS loop has already resumed (nativeActive
            // flipped false above); the member may re-start the FGS.
            setNativeHint(
              isArabic
                ? "توقفت خدمة التتبع الخلفي والجلسة سليمة — تُستأنف النبضات داخل التطبيق، ويمكنك إعادة تشغيل الخدمة."
                : "Suivi natif arrêté, session intacte — reprise intégrée; vous pouvez relancer le service."
            );
          } else {
            setNativeHint(
              isArabic
                ? "توقفت خدمة التتبع الخلفي (مشكلة شبكة) — تُستأنف النبضات داخل التطبيق تلقائياً."
                : "Suivi natif arrêté (réseau) — reprise automatique intégrée."
            );
          }
        });
      } else if (state === "beat") {
        // F3 (A2/P2): native beats carry the mission verdict while the FGS
        // owns the stream — without this channel a fresh dispatch NEVER
        // reached the member's screen (frozen "لا توجد مهمة" card through the
        // whole shift). S5: the payload crossed the bridge as a quoted JSON
        // STRING; JSON.parse + the same field allow-list as server responses,
        // never raw interpolation. A null/absent payload means "no mission"
        // and clears a stale card; the last-beat line refreshes too (P12).
        missionSeqRef.current++; // the native stream is the newest authority now
        setMission(normalizeNativeMission(typeof detail.missionJson === "string" ? detail.missionJson : null));
        setLastBeatAt(Date.now());
      }
    };
    window.addEventListener("teamTrackingState", handler);
    return () => window.removeEventListener("teamTrackingState", handler);
  }, [isArabic]);

  // ======================
  // ACTIONS
  // ======================
  const handleJoin = useCallback(async () => {
    if (joining) return;
    const code = joinCode.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const name = joinName.trim();
    setJoinError(null);
    setSessionFatal(null);
    if (code.length < 4 || name.length < 2) {
      setJoinError(isArabic ? "أدخل رمز الفريق واسم الظاهر (حرفان على الأقل)." : "Saisissez le code d'équipe et un nom (2 caractères min).");
      return;
    }
    setJoining(true);
    const seq = ++missionSeqRef.current; // F7: join is a mission source
    const result = await joinTeam(code, name);
    setJoining(false);
    if (!result.ok || !result.session) {
      setJoinError(
        result.message === "network"
          ? (isArabic ? "تعذر الاتصال بالخادم — تحقق من الشبكة." : "Connexion au serveur impossible — vérifiez le réseau.")
          : (result.message || (isArabic ? "تعذر الانضمام — تحقق من الرمز." : "Échec — vérifiez le code."))
      );
      return;
    }
    saveTeamSession(result.session);
    setSession(result.session);
    if (missionSeqRef.current === seq) setMission(result.mission ?? null);
    if (result.heartbeatIntervalMs) setIntervalMs(result.heartbeatIntervalMs);
    setJoinCode("");
    setJoinName("");
  }, [joining, joinCode, joinName, isArabic]);

  const handleFlipOnScene = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || flipBusy) return;
    setFlipBusy(true);
    setFlipNote(null);
    const seq = ++missionSeqRef.current; // F7: the flip is now the newest mission source
    const result = await flipMissionOnScene(current.token);
    setFlipBusy(false);
    if (result.ok) {
      // F7 (P6): a heartbeat launched BEFORE the flip still carries the older
      // en_route verdict — it must not flash over the on_scene answer the
      // member just earned.
      if (missionSeqRef.current === seq) setMission(result.mission ?? null);
    } else if (result.code === "NO_ACTIVE_MISSION") {
      setFlipNote(isArabic ? "لا توجد مهمة نشطة لتحديثها." : "Aucune mission active.");
    } else if (result.code === "fatal" && result.fatal) {
      clearTeamSession();
      setSession(null);
      setSessionFatal(result.fatal);
    } else {
      setFlipNote(isArabic ? "تعذر الإرسال — أعد المحاولة." : "Échec d'envoi — réessayez.");
    }
  }, [flipBusy, isArabic]);

  const handleOpenNavigation = useCallback(() => {
    if (!mission || mission.sosLat === null || mission.sosLng === null) return;
    const opened = openMissionNavigation(mission);
    if (!opened) {
      setFlipNote(
        isArabic
          ? "تعذر فتح تطبيق الملاحة على هذا الجهاز."
          : "Impossible d'ouvrir la navigation sur cet appareil."
      );
    }
  }, [mission, isArabic]);

  const handleLeave = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || leaving) return;
    setLeaving(true);
    setLeaveError(false);
    const result = await leaveTeam(current.token);
    setLeaving(false);
    if (result.ok) {
      // F6 (P5): leaving the team must also kill the native FGS — the stop
      // control is about to vanish with the session card, and an orphaned
      // service keeps collecting GPS + showing the notification AFTER the
      // member withdrew consent. Without a GPS fix no beat is ever sent, so
      // without this stop the orphan window is not 60s — it is indefinite.
      getTeamTrackingBridge()?.stopTeamTracking();
      clearTeamSession();
      setSession(null);
      setMission(null);
      setNativeActive(false);
      setNativeHint(null);
      setConfirmingLeave(false);
      setLastBeatAt(null);
      setBeat("idle");
    } else {
      // Network failure: the membership still EXISTS server-side. Do NOT
      // drop the token locally — re-joining would burn the code budget.
      setLeaveError(true);
    }
  }, [leaving]);

  const handleNativeStart = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    const bridge = getTeamTrackingBridge();
    if (!bridge) return;
    setNativeHint(null);
    const ok = bridge.startTeamTracking(buildNativeTrackingConfig(current, intervalMs));
    if (!ok) {
      const prereq = typeof bridge.teamTrackingPrerequisite === "function" ? bridge.teamTrackingPrerequisite() : "";
      setNativeHint(
        prereq === "missing-fine-location"
          ? (isArabic ? "إذن الموقع الدقيق غير مفعّل — فعّله من إعدادات النظام (خلال الاستخدام) ثم أعد المحاولة." : "Localisation précise non accordée — activez-la dans les réglages système puis réessayez.")
          : (isArabic ? "تعذر تشغيل خدمة التتبع على هذا الجهاز." : "Impossible de démarrer le service de suivi.")
      );
    }
    // "started" confirmation arrives via the native teamTrackingState event.
  }, [intervalMs, isArabic]);

  const handleNativeStop = useCallback(() => {
    const bridge = getTeamTrackingBridge();
    bridge?.stopTeamTracking();
    setNativeActive(false);
  }, []);

  // ======================
  // RENDER
  // ======================
  const teamDisplayName = isArabic
    ? (session?.teamNameAr || session?.teamName || "فريق ميداني")
    : (session?.teamName || session?.teamNameAr || "Équipe de terrain");

  return (
    <div className="col-span-12 max-w-2xl mx-auto w-full space-y-5 animate-fadeIn">
      {/* Panel header */}
      <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <Users className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="font-bold text-slate-100 text-base">
              {isArabic ? "فريقي الميداني" : "Mon Équipe Terrain"}
            </h2>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {isArabic
                ? "انضم برمز الفريق ليتصفّح قيادة الحملة موقعك ويعرض عليك المهمة."
                : "Rejoignez avec le code d'équipe pour partager votre position et recevoir la mission."}
            </p>
          </div>
        </div>
      </div>

      {/* RESUMING */}
      {session && resuming && (
        <div role="status" aria-live="polite" className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 text-sm text-gray-400 font-bold animate-pulse">
          {isArabic ? "جارٍ استئناف جلسة الفريق..." : "Reprise de la session d'équipe..."}
        </div>
      )}

      {/* FATAL: the server revoked/killed the previous session */}
      {!session && sessionFatal && (
        <div role="alert" className="bg-red-950/20 border border-red-500/30 rounded-xl p-4 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs font-bold text-red-300">{teamFatalMessage(sessionFatal, isArabic)}</p>
        </div>
      )}

      {/* JOIN FORM (guest) */}
      {!session && (
        <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 space-y-4">
          <h3 className="font-bold text-sm text-slate-200">
            {isArabic ? "الانضمام إلى فريق" : "Rejoindre une équipe"}
          </h3>
          <div>
            <label htmlFor="team-code" className="block text-[11px] font-black text-gray-400 mb-1.5">
              {isArabic ? "رمز الفريق (8 أحرف من قيادة الحملة)" : "Code d'équipe (fourni par le commandement)"}
            </label>
            <input
              id="team-code"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              // F11 (P10): a 12-char ceiling silently truncated longer pastes
              // (code + separators + context) into a corrupted submission.
              // 20 chars of headroom + strip-on-change keeps what the member
              // sees honest: separators are visible, junk never enters.
              maxLength={20}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^0-9A-Z\s-]/g, ""))}
              placeholder="A2B4C6D8"
              className="w-full bg-black/40 border border-white/10 rounded-lg px-3.5 py-3 text-sm font-mono font-black tracking-[0.3em] text-slate-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 text-left"
              dir="ltr"
            />
          </div>
          <div>
            <label htmlFor="team-name" className="block text-[11px] font-black text-gray-400 mb-1.5">
              {isArabic ? "الاسم الظاهر (مثال: عارة 1 — قائد)" : "Nom affiché (ex. Équipage 1 — chef)"}
            </label>
            <input
              id="team-name"
              type="text"
              autoComplete="off"
              maxLength={40}
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-lg px-3.5 py-3 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            />
          </div>
          <p className="text-[10px] leading-relaxed text-amber-300/90 bg-amber-950/20 border border-amber-500/20 rounded-lg px-3 py-2">
            {isArabic
              ? "بالانضمام أنت توافق على إرسال موقعك الجغرافي إلى قيادة الحملة بشكل دوري طوال المناوبة. يمكنك الانسحاب في أي وقت."
              : "En rejoignant, vous acceptez l'envoi périodique de votre position au commandement pendant la garde. Retrait possible à tout moment."}
          </p>
          {joinError && (
            <div role="alert" className="text-xs font-bold text-red-300 bg-red-950/20 border border-red-500/30 rounded-lg px-3 py-2">
              {joinError}
            </div>
          )}
          <button
            type="button"
            onClick={handleJoin}
            disabled={joining}
            className="w-full py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black text-sm transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>{joining ? (isArabic ? "جارٍ الانضمام..." : "Adhésion...") : (isArabic ? "انضمام إلى الفريق" : "Rejoindre l'équipe")}</span>
          </button>
        </div>
      )}

      {/* ACTIVE SESSION */}
      {session && !resuming && (
        <>
          {/* Team identity */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <Users className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="font-black text-sm text-slate-100">{teamDisplayName}</h3>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {isArabic ? "العضو: " : "Membre : "}
                    <span className="font-bold text-slate-300">{session.name}</span>
                  </p>
                </div>
              </div>
              <span
                role="status"
                aria-live="polite"
                className={`text-[10px] font-black px-2.5 py-1.5 rounded-full border flex items-center gap-1.5 ${
                  nativeActive
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    : beat === "live"
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                      : beat === "transient"
                        ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                        : beat === "waiting-gps"
                          ? "bg-sky-500/10 text-sky-300 border-sky-500/30"
                          : "bg-zinc-500/10 text-gray-400 border-white/10"
                }`}
              >
                <Radio className={`h-3 w-3 ${beat === "live" ? "animate-pulse" : ""}`} />
                {nativeActive
                  ? (isArabic ? "تتبع خلفي نشط" : "Suivi natif actif")
                  : beat === "live"
                    ? (isArabic ? "نبضات مباشرة" : "Battements en direct")
                    : beat === "transient"
                      ? (isArabic ? "شبكة متقطعة — إعادة محاولة" : "Réseau instable — réessai")
                      : beat === "waiting-gps"
                        ? (isArabic ? "بانتظار إشارة GPS" : "Attente du signal GPS")
                        : (isArabic ? "جاهز" : "Prêt")}
              </span>
            </div>
            {lastBeatAt && beat !== "transient" && (
              <p className="text-[10px] text-gray-500 mt-2">
                {isArabic ? "آخر نبضة: " : "Dernier battement : "}
                {new Date(lastBeatAt).toLocaleTimeString(isArabic ? "ar-DZ" : "fr-DZ")}
                {" · "}
                {isArabic ? `كل ${Math.round(intervalMs / 1000)} ثانية` : `toutes les ${Math.round(intervalMs / 1000)} s`}
              </p>
            )}
          </div>

          {/* Mission card */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2.5">
              <MapPin className={`h-4 w-4 ${mission?.phase === "on_scene" ? "text-emerald-400" : mission ? "text-amber-400" : "text-gray-500"}`} />
              <h3 className="font-bold text-sm text-slate-100">
                {isArabic ? "المهمة الحالية" : "Mission actuelle"}
              </h3>
            </div>
            {mission ? (
              <div className="space-y-3">
                <div
                  role="status"
                  aria-live="polite"
                  className={`rounded-lg px-4 py-3 border font-bold text-sm ${
                    mission.phase === "on_scene"
                      ? "bg-emerald-950/30 border-emerald-500/30 text-emerald-300"
                      : "bg-amber-950/20 border-amber-500/30 text-amber-300"
                  }`}
                >
                  {missionLabel(mission.phase, isArabic)}
                  <span className="block text-[10px] font-mono text-gray-500 mt-1" dir="ltr">
                    SOS #{mission.sosId.slice(-8)} · {mission.since ? new Date(mission.since).toLocaleTimeString(isArabic ? "ar-DZ" : "fr-DZ") : ""}
                  </span>
                </div>
                {mission.phase === "en_route" && (
                  <button
                    type="button"
                    onClick={handleFlipOnScene}
                    disabled={flipBusy}
                    className="w-full py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black text-sm transition-all cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Navigation className="h-4 w-4" />
                    <span>{flipBusy ? (isArabic ? "جارٍ الإرسال..." : "Envoi...") : (isArabic ? "وصلت إلى الموقع" : "Arrivé sur les lieux")}</span>
                  </button>
                )}
                {mission.sosLat !== null && mission.sosLng !== null && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={handleOpenNavigation}
                      className="w-full py-2.5 rounded-lg bg-sky-600/80 hover:bg-sky-500 text-white font-black text-xs transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Navigation className="h-3.5 w-3.5" />
                      <span>{isArabic ? "فتح الملاحة إلى الموقع" : "Ouvrir la navigation"}</span>
                    </button>
                    {mission.phase === "en_route" && (
                      <p className="text-[10px] text-gray-500 text-center">
                        {isArabic
                          ? `يُؤكَّد الوصول تلقائياً بعد نبضتين داخل ${ARRIVAL_RADIUS_M}م من الموقع — الزر أعلاه للتأكيد اليدوي عند الحاجة.`
                          : `Arrivée confirmée automatiquement après deux battements dans un rayon de ${ARRIVAL_RADIUS_M} m — le bouton ci-dessus reste pour une confirmation manuelle.`}
                      </p>
                    )}
                  </div>
                )}
                {flipNote && (
                  <p role="status" className="text-[11px] font-bold text-amber-300 bg-amber-950/20 border border-amber-500/20 rounded-lg px-3 py-2">
                    {flipNote}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-400 font-bold">
                {isArabic
                  ? "لا توجد مهمة موجهة إليك حالياً — ستظهر تلقائياً عند توجيه القيادة فريقك إلى بلاغ."
                  : "Aucune mission assignée — elle apparaîtra dès que le commandement dirigera votre équipe."}
              </p>
            )}
          </div>

          {/* Native FGS card (Android only — bridge feature-detected) */}
          {getTeamTrackingBridge() && (
            <div className="bg-zinc-900/50 border border-emerald-500/20 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2.5">
                <Smartphone className="h-4 w-4 text-emerald-400" />
                <h3 className="font-bold text-sm text-slate-100">
                  {isArabic ? "التتبع الخلفي (خدمة النظام)" : "Suivi en arrière-plan (service système)"}
                </h3>
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {isArabic
                  ? "يُبقي النبضات تعمل حتى مع إطفاء الشاشة أو انتقال التطبيق للخلف — مطلوب لعمليات الغابات الطويلة. يظهر إشعار دائم بالنظام."
                  : "Maintient les battements actifs écran éteint ou app en arrière-plan — indispensable pour les longues opérations. Une notification permanente s'affiche."}
              </p>
              {nativeActive ? (
                <button
                  type="button"
                  onClick={handleNativeStop}
                  className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-slate-200 font-black text-xs transition-all cursor-pointer border border-white/10"
                >
                  {isArabic ? "إيقاف التتبع الخلفي (العودة للنبضات داخل التطبيق)" : "Arrêter le suivi natif (retour au suivi intégré)"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNativeStart}
                  className="w-full py-2.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white font-black text-xs transition-all cursor-pointer"
                >
                  {isArabic ? "تشغيل التتبع الخلفي" : "Activer le suivi en arrière-plan"}
                </button>
              )}
              {nativeHint && (
                <p role="alert" className="text-[11px] font-bold text-amber-300 bg-amber-950/20 border border-amber-500/20 rounded-lg px-3 py-2">
                  {nativeHint}
                </p>
              )}
            </div>
          )}

          {/* Leave */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5">
            {!confirmingLeave ? (
              <button
                type="button"
                onClick={() => { setConfirmingLeave(true); setLeaveError(false); }}
                className="text-xs font-black text-red-400 hover:text-red-300 transition-colors cursor-pointer flex items-center gap-2"
              >
                <LogOut className="h-4 w-4" />
                <span>{isArabic ? "الانسحاب من الفريق" : "Quitter l'équipe"}</span>
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-300">
                  {isArabic
                    ? "سيتم إيقاف نبضات موقعك فوراً وإخفاؤك من خريطة القيادة. هل أنت متأكد؟"
                    : "Vos battements s'arrêteront immédiatement et vous disparaîtrez de la carte. Confirmer ?"}
                </p>
                {leaveError && (
                  <p role="alert" className="text-[11px] font-bold text-amber-300">
                    {isArabic
                      ? "تعذر الانسحاب الآن (مشكلة شبكة) — جارٍ الاحتفاظ بجلستك، أعد المحاولة."
                      : "Échec du retrait (réseau) — session conservée, réessayez."}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleLeave}
                    disabled={leaving}
                    className="flex-1 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-black text-xs transition-all cursor-pointer"
                  >
                    {leaving ? (isArabic ? "جارٍ الانسحاب..." : "Départ...") : (isArabic ? "نعم، انسحاب" : "Oui, quitter")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingLeave(false)}
                    className="flex-1 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-slate-300 font-black text-xs transition-all cursor-pointer"
                  >
                    {isArabic ? "تراجع" : "Annuler"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
