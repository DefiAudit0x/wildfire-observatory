import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Radio, Navigation, LogOut, MapPin, ShieldAlert, Smartphone, CheckCircle2 } from "lucide-react";
import { Language } from "../types";
import {
  TeamFatalCode,
  TeamMissionState,
  TeamSessionState,
  buildNativeTrackingConfig,
  clearTeamSession,
  flipMissionOnScene,
  getTeamTrackingBridge,
  joinTeam,
  leaveTeam,
  loadTeamSession,
  probeTeamSession,
  saveTeamSession,
  sendTeamHeartbeat,
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

  const [nativeActive, setNativeActive] = useState(false);
  const [nativeHint, setNativeHint] = useState<string | null>(null);

  // Overlap guard: one in-flight beat at a time — a slow 15s request must not
  // stack with the next tick (same single-flight lesson as the relay queue).
  const beatBusyRef = useRef(false);
  const sessionRef = useRef<TeamSessionState | null>(session);
  sessionRef.current = session;

  // ======================
  // RESUME: validate the persisted token once on mount. The server verdict is
  // the only authority — a network hiccup keeps the session (retry happens
  // with the heartbeat loop), a fatal code clears it with a reason.
  // ======================
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const result = await probeTeamSession(session.token);
      if (cancelled) return;
      setResuming(false);
      if (result.ok) {
        setMission(result.mission ?? null);
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
              setMission(verdict.mission);
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
  // NATIVE STATE EVENTS — the FGS reports started/stopped/revoked so the
  // panel never guesses what the service is doing.
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
        setNativeHint(isArabic ? "تعذّر إرسال نبضة من خدمة التتبع — سيُعاد تلقائياً." : "Échec d'un battement natif — nouvelle tentative automatique.");
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
    setMission(result.mission ?? null);
    if (result.heartbeatIntervalMs) setIntervalMs(result.heartbeatIntervalMs);
    setJoinCode("");
    setJoinName("");
  }, [joining, joinCode, joinName, isArabic]);

  const handleFlipOnScene = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || flipBusy) return;
    setFlipBusy(true);
    setFlipNote(null);
    const result = await flipMissionOnScene(current.token);
    setFlipBusy(false);
    if (result.ok) {
      setMission(result.mission ?? null);
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

  const handleLeave = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || leaving) return;
    setLeaving(true);
    setLeaveError(false);
    const result = await leaveTeam(current.token);
    setLeaving(false);
    if (result.ok) {
      clearTeamSession();
      setSession(null);
      setMission(null);
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
              {isArabic ? "فريقي — وضع الفريق الميداني" : "Mon Équipe — Mode Terrain"}
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
              {isArabic ? "رمز الفريق (8 أحرف من قيادة الحملة)" : "Code d'équipe (8 caractères du commandement)"}
            </label>
            <input
              id="team-code"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={12}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
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
            <span>{joining ? (isArabic ? "جارٍ الانضمام..." : "Connexion...") : (isArabic ? "انضمام إلى الفريق" : "Rejoindre l'équipe")}</span>
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
                    <span>{flipBusy ? (isArabic ? "جارٍ الإرسال..." : "Envoi...") : (isArabic ? "وصلت إلى الموقع (on_scene)" : "Arrivé sur les lieux (on_scene)")}</span>
                  </button>
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
                    {leaving ? (isArabic ? "جارٍ الانسحاب..." : "Retrait...") : (isArabic ? "نعم، انسحاب" : "Oui, quitter")}
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
