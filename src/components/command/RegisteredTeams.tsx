import { useEffect, useRef, useState } from "react";
import { Shield, HeartHandshake, KeyRound, MapPin, Plus, Radio, Search, Truck, Users, Copy, RefreshCw, UserMinus, X, Ban, Power, Pencil, Trash2 } from "lucide-react";
import { TrappedSOS } from "../../types";
import { apiFetch, isSessionExpiry } from "../../utils/adminApi";
import { RegisteredTeam, JoinCodeIssued } from "./registeredTeams";

/**
 * Team Mode (Phase 1) — registered field teams and their live GPS members.
 * This panel is the real replacement for the simulated dispatch table below
 * it (TeamsTable keeps rendering the legacy simulated rows until every
 * operation migrates). Dispatch here sends teamId; the server resolves the
 * team entity inside the dispatch transaction.
 *
 * Round B: dispatcher LEVERS (force-clear mission, deactivate/activate,
 * rename, device blocklist) land beside dispatch — every lever maps to a
 * server endpoint added in the same round; W4 adds the roster freshness
 * indicator; W5 turns the join-code expiry into a live countdown.
 */

interface RegisteredTeamsProps {
  isArabic: boolean;
  teams: RegisteredTeam[];
  sosCalls: TrappedSOS[];
  dispatchLoading: boolean;
  /** W4: a roster fetch is currently in flight. */
  refreshing?: boolean;
  /** W4: timestamp of the last successful roster commit. */
  lastUpdated?: number | null;
  /** B3: deactivated teams are included in the roster. */
  showInactive?: boolean;
  onToggleInactive?: () => void;
  onDispatch: (teamId: string, sosId: string, notes: string) => Promise<boolean>;
  onTargetMember: (teamId: string, memberId: string) => void;
  onTeamsChanged: () => Promise<void> | void;
  onSessionExpired: () => void;
  notify: (message: string, type?: "success" | "error" | "warning") => void;
}

function formatExpiry(ts: number, isArabic: boolean): string {
  const d = new Date(ts);
  return isArabic ? d.toLocaleString("ar", { hour12: false }) : d.toLocaleString("fr", { hour12: false });
}

/**
 * W5: a raw wall-clock expiry timestamp made an operator do the countdown
 * math mid-shift — and an expired code looked identical to a live one. The
 * chip now shows remaining time; "منتهي" renders red, <30min renders amber.
 */
function expiryCountdown(expiresAt: number, isArabic: boolean): { text: string; expired: boolean; soon: boolean } {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return { text: isArabic ? "منتهي" : "Expiré", expired: true, soon: false };
  const totalMins = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) {
    return { text: isArabic ? `ينتهي خلال ${days}ي ${hours % 24}س` : `Expire dans ${days}j ${hours % 24}h`, expired: false, soon: false };
  }
  if (hours >= 1) {
    return { text: isArabic ? `ينتهي خلال ${hours}س ${totalMins % 60}د` : `Expire dans ${hours}h ${totalMins % 60}min`, expired: false, soon: false };
  }
  return { text: isArabic ? `ينتهي خلال ${totalMins}د` : `Expire dans ${totalMins}min`, expired: false, soon: totalMins < 30 };
}

export default function RegisteredTeams({ isArabic, teams, sosCalls, dispatchLoading, refreshing = false, lastUpdated = null, showInactive = false, onToggleInactive, onDispatch, onTargetMember, onTeamsChanged, onSessionExpired, notify }: RegisteredTeamsProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameAr, setNewNameAr] = useState("");
  const [newType, setNewType] = useState<"protection_civile" | "volunteers">("protection_civile");
  const [joinCodes, setJoinCodes] = useState<Record<string, JoinCodeIssued>>({});
  const [mintingFor, setMintingFor] = useState<string | null>(null);
  const [dispatchSos, setDispatchSos] = useState<Record<string, string>>({});
  const [dispatchNotes, setDispatchNotes] = useState<Record<string, string>>({});
  const [dispatchingTeam, setDispatchingTeam] = useState<string | null>(null);
  const [teamSearch, setTeamSearch] = useState("");
  // B3 levers: one in-flight lever per team at a time.
  const [leverBusy, setLeverBusy] = useState<string | null>(null);
  // ARC pattern (TeamsTable): result chips self-expire instead of sticking.
  const [resultChip, setResultChip] = useState<Record<string, { ok: boolean; text: string }>>({});
  const resultTimers = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const t of Object.values(resultTimers.current)) window.clearTimeout(t);
    };
  }, []);

  const setChipWithTtl = (teamId: string, value: { ok: boolean; text: string }) => {
    window.clearTimeout(resultTimers.current[teamId]);
    setResultChip((prev) => ({ ...prev, [teamId]: value }));
    resultTimers.current[teamId] = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setResultChip((prev) => {
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
    }, 5000);
  };

  const filtered = teams.filter((t) => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.nameAr.includes(teamSearch.trim()) || t.teamId.toLowerCase().includes(q);
  });

  const onlineMembers = teams.flatMap((t) => t.members).filter((m) => m.online).length;

  const handleCreateTeam = async () => {
    if (creating || !newName.trim() || !newNameAr.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch("/api/teams", "POST", { name: newName.trim(), nameAr: newNameAr.trim(), type: newType });
      if (res.status === 201) {
        setNewName("");
        setNewNameAr("");
        setShowCreate(false);
        notify(isArabic ? "تم تسجيل الفريق" : "Équipe enregistrée", "success");
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "فشل تسجيل الفريق" : "Échec de l'enregistrement", "error");
      }
    } catch {
      notify(isArabic ? "فشل تسجيل الفريق" : "Échec de l'enregistrement", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleMintCode = async (teamId: string) => {
    if (mintingFor) return;
    setMintingFor(teamId);
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/join-code`, "POST", {});
      if (res.status === 201) {
        const data = (await res.json()) as JoinCodeIssued;
        setJoinCodes((prev) => ({ ...prev, [teamId]: data }));
        notify(isArabic ? "تم توليد رمز انضمام جديد — الأكواد السابقة أُلغيت" : "Nouveau code généré — anciens codes révoqués", "success");
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "تعذر توليد الرمز" : "Échec de génération du code", "error");
      }
    } catch {
      notify(isArabic ? "تعذر توليد الرمز" : "Échec de génération du code", "error");
    } finally {
      setMintingFor(null);
    }
  };

  const handleCopyCode = async (teamId: string) => {
    const issued = joinCodes[teamId];
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      notify(isArabic ? "تم نسخ الرمز" : "Code copié", "success");
    } catch {
      // Clipboard can be blocked (non-secure origin); the code stays visible.
    }
  };

  const handleDispatch = async (team: RegisteredTeam) => {
    if (dispatchingTeam) return;
    // ARC-W3: the silent auto-pick probe ("oldest unassigned") actually
    // selected the NEWEST unassigned SOS under the desc ordering, kept the
    // selector empty, and never named the target in the success chip — a team
    // could be sent to the wrong casualty with two active SOS. Dispatch now
    // REQUIRES an explicit operator selection.
    const sosId = dispatchSos[team.teamId] || "";
    if (!sosId) {
      setChipWithTtl(team.teamId, { ok: false, text: isArabic ? "اختر بلاغ الاستغاثة أولًا" : "Sélectionnez d'abord un SOS" });
      return;
    }
    setDispatchingTeam(team.teamId);
    const ok = await onDispatch(team.teamId, sosId, dispatchNotes[team.teamId] || "");
    setDispatchingTeam(null);
    if (ok) {
      setDispatchSos((prev) => ({ ...prev, [team.teamId]: "" }));
      setDispatchNotes((prev) => ({ ...prev, [team.teamId]: "" }));
    }
    const target = sosCalls.find((s) => s.id === sosId);
    const targetLabel = target?.name || sosId;
    setChipWithTtl(team.teamId, ok
      ? { ok: true, text: isArabic ? `✓ تم توجيه الفريق إلى ${targetLabel}` : `✓ Équipe dépêchée vers ${targetLabel}` }
      : { ok: false, text: isArabic ? "فشل التوجيه — قد يكون الفريق مشغولًا" : "Échec — équipe peut-être occupée" });
  };

  const handleRemoveMember = async (teamId: string, memberId: string, name: string) => {
    if (!window.confirm(isArabic ? `إزالة العضو «${name}» من الفريق؟` : `Retirer le membre « ${name} » ?`)) return;
    // B1/B2: removal revokes the device's token (server-side). Offer the
    // lost-device blocklist step explicitly — a blocked device cannot come
    // back via a join code either.
    const block = window.confirm(
      isArabic
        ? "هل تريد أيضًا حجب هذا الجهاز من إعادة الانضمام؟ (لجهاز مفقود أو مُسحوب)"
        : "Bloquer aussi cet appareil de toute réadhésion ? (appareil perdu/réassigné)"
    );
    try {
      const res = await apiFetch(
        `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
        "DELETE",
        block ? { blockPrincipal: true } : undefined
      );
      if (res.ok) {
        notify(
          block
            ? (isArabic ? `تمت إزالة ${name} وحجب جهازه` : `${name} retiré et appareil bloqué`)
            : (isArabic ? `تمت إزالة ${name}` : `${name} retiré`),
          "success"
        );
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "تعذرت إزالة العضو" : "Échec du retrait du membre", "error");
      }
    } catch {
      notify(isArabic ? "تعذرت إزالة العضو" : "Échec du retrait du membre", "error");
    }
  };

  /** B3: force-clear a wedged mission — the lever that did not exist. */
  const handleClearMission = async (teamId: string) => {
    if (leverBusy) return;
    if (!window.confirm(isArabic ? "إلغاء المهمة الجارية لهذا الفريق وتحريره؟" : "Annuler la mission en cours et libérer l'équipe ?")) return;
    setLeverBusy(teamId);
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/mission`, "DELETE");
      if (res.ok) {
        notify(isArabic ? "تم إلغاء المهمة وتحرير الفريق" : "Mission annulée, équipe libérée", "success");
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "لا توجد مهمة نشطة لإلغائها" : "Aucune mission active à annuler", "warning");
      }
    } catch {
      notify(isArabic ? "تعذر إلغاء المهمة" : "Échec de l'annulation", "error");
    } finally {
      setLeverBusy(null);
    }
  };

  /** B3: activate/deactivate a team (deactivation was previously dead code). */
  const handleSetTeamActive = async (teamId: string, active: boolean) => {
    if (leverBusy) return;
    if (!active && !window.confirm(isArabic ? "تعطيل هذا الفريق؟ لن يستقبل توجيهات ولن تنطلق نبضات أعضائه." : "Désactiver cette équipe ? Plus de dépêches ni de GPS.")) return;
    setLeverBusy(teamId);
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}`, "PATCH", { active });
      if (res.ok) {
        notify(active ? (isArabic ? "تم تفعيل الفريق" : "Équipe activée") : (isArabic ? "تم تعطيل الفريق" : "Équipe désactivée"), "success");
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "تعذر تحديث حالة الفريق" : "Échec de la mise à jour", "error");
      }
    } catch {
      notify(isArabic ? "تعذر تحديث حالة الفريق" : "Échec de la mise à jour", "error");
    } finally {
      setLeverBusy(null);
    }
  };

  /** B3: rename — names used to be immutable after registration. */
  const handleRenameTeam = async (team: RegisteredTeam) => {
    if (leverBusy) return;
    const field = isArabic ? "nameAr" : "name";
    const current = isArabic ? team.nameAr : team.name;
    const next = window.prompt(isArabic ? "الاسم الجديد للفريق:" : "Nouveau nom de l'équipe :", current);
    if (next === null || next.trim() === "" || next.trim() === current) return;
    setLeverBusy(team.teamId);
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(team.teamId)}`, "PATCH", { [field]: next.trim() });
      if (res.ok) {
        notify(isArabic ? "تم تحديث الاسم" : "Nom mis à jour", "success");
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "تعذر تحديث الاسم" : "Échec du renommage", "error");
      }
    } catch {
      notify(isArabic ? "تعذر تحديث الاسم" : "Échec du renommage", "error");
    } finally {
      setLeverBusy(null);
    }
  };

  /** B2: unblock a previously blocked device. */
  const handleUnblockPrincipal = async (teamId: string, principal: string) => {
    if (leverBusy) return;
    setLeverBusy(teamId);
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/block-principal`, "POST", { principal, blocked: false });
      if (res.ok) {
        notify(isArabic ? "تم فك الحجب عن الجهاز" : "Appareil débloqué", "success");
        await onTeamsChanged();
      } else if (isSessionExpiry(res)) {
        onSessionExpired();
      } else {
        notify(isArabic ? "تعذر فك الحجب" : "Échec du déblocage", "error");
      }
    } catch {
      notify(isArabic ? "تعذر فك الحجب" : "Échec du déblocage", "error");
    } finally {
      setLeverBusy(null);
    }
  };

  const activeSos = sosCalls.filter((s) => s.status === "active");

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-extrabold text-slate-200">
            {isArabic ? "الفرق الميدانية المسجلة — تتبع GPS حقيقي" : "Équipes de terrain enregistrées — GPS réel"}
          </span>
          <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded-full text-[10px] font-bold">
            {onlineMembers} {isArabic ? "عضو متصل" : "en ligne"}
          </span>
          {/* W4: roster freshness — a spinning indicator while the fetch is in
              flight plus the time the current data landed. */}
          {refreshing && <RefreshCw className="h-3 w-3 animate-spin text-amber-400" data-testid="teams-refreshing" />}
          {lastUpdated !== null && !refreshing && (
            <span className="text-[9px] text-gray-500" title={isArabic ? "آخر تحديث للقائمة" : "Dernière mise à jour"}>
              {isArabic ? "آخر تحديث" : "MAJ"} {new Date(lastUpdated).toLocaleTimeString(isArabic ? "ar" : "fr", { hour12: false })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
            <input
              type="text"
              value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)}
              placeholder={isArabic ? "ابحث عن فريق..." : "Rechercher..."}
              className="w-40 bg-zinc-950 border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none focus:border-amber-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => onToggleInactive?.()}
            aria-pressed={showInactive}
            className={`flex items-center gap-1 px-2 py-1.5 border text-[10px] font-bold rounded-lg transition-all cursor-pointer ${
              showInactive ? "bg-amber-600/20 border-amber-500/50 text-amber-300" : "bg-zinc-900 border-white/10 text-gray-400 hover:text-slate-200"
            }`}
            title={isArabic ? "عرض الفرق المعطلة" : "Afficher les équipes désactivées"}
          >
            <Power className="h-3 w-3" />
            {isArabic ? "المعطلة" : "Désactivées"}
          </button>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-black text-[11px] font-extrabold rounded-lg transition-all cursor-pointer border border-amber-500"
          >
            {showCreate ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {isArabic ? "تسجيل فريق" : "Nouvelle équipe"}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="px-4 py-3 border-b border-white/5 bg-zinc-950/60 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={isArabic ? "الاسم بالفرنسية (Unité Béjaïa)" : "Nom (Unité Béjaïa)"}
            className="flex-1 min-w-[160px] bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-amber-500/40"
          />
          <input
            type="text"
            value={newNameAr}
            onChange={(e) => setNewNameAr(e.target.value)}
            placeholder={isArabic ? "الاسم بالعربية" : "Nom en arabe"}
            className="flex-1 min-w-[160px] bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-amber-500/40"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value === "volunteers" ? "volunteers" : "protection_civile")}
            className="bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none"
          >
            <option value="protection_civile">{isArabic ? "حماية مدنية" : "Protection Civile"}</option>
            <option value="volunteers">{isArabic ? "متطوعون" : "Volontaires"}</option>
          </select>
          <button
            type="button"
            disabled={creating || !newName.trim() || !newNameAr.trim()}
            onClick={handleCreateTeam}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-gray-500 text-black text-[11px] font-extrabold rounded transition-all cursor-pointer"
          >
            {creating ? (isArabic ? "جارٍ التسجيل..." : "...") : isArabic ? "تسجيل" : "Créer"}
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <Users className="h-8 w-8 mx-auto text-gray-600 mb-2" />
          <p className="text-xs text-gray-400 max-w-md mx-auto leading-relaxed">
            {isArabic
              ? "لا توجد فرق مسجلة بعد. سجّل فريقًا، ثم ولّد رمز انضمام وأدخله في جهاز الفريق الميداني — سيظهر موقعه هنا مباشرة عبر GPS."
              : "Aucune équipe enregistrée. Créez une équipe, générez un code d'adhésion et saisissez-le sur l'appareil de terrain — sa position GPS apparaîtra ici."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {filtered.map((team) => {
            const isPC = team.type === "protection_civile";
            const issued = joinCodes[team.teamId];
            const chip = resultChip[team.teamId];
            const selectedSosId = dispatchSos[team.teamId] || "";
            const busy = !!team.activeMission;
            const countdown = issued ? expiryCountdown(issued.expiresAt, isArabic) : null;
            return (
              <div key={team.teamId} className={`px-4 py-3 ${team.active === false ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{isPC ? "🚒" : "💚"}</span>
                    <div>
                      <p className="font-extrabold text-slate-100 text-xs">{isArabic ? team.nameAr : team.name}</p>
                      <p className="text-[10px] text-gray-500 font-mono">{team.teamId}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      isPC ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }`}>
                      {isPC ? <Shield className="h-2.5 w-2.5" /> : <HeartHandshake className="h-2.5 w-2.5" />}
                      {isPC ? (isArabic ? "حماية مدنية" : "Protection Civile") : (isArabic ? "متطوعون" : "Volontaires")}
                    </span>
                    {team.active === false && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-zinc-700/40 text-gray-300 border-white/15">
                        <Ban className="h-2.5 w-2.5" />
                        {isArabic ? "معطّل" : "Désactivée"}
                      </span>
                    )}
                    {/* B3 levers: rename / deactivate / re-activate. */}
                    <button
                      type="button"
                      disabled={leverBusy !== null}
                      onClick={() => handleRenameTeam(team)}
                      className="text-gray-500 hover:text-amber-300 cursor-pointer disabled:opacity-40"
                      title={isArabic ? "إعادة تسمية الفريق" : "Renommer l'équipe"}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={leverBusy !== null}
                      onClick={() => handleSetTeamActive(team.teamId, team.active === false)}
                      className={`cursor-pointer disabled:opacity-40 ${team.active === false ? "text-emerald-400 hover:text-emerald-300" : "text-gray-500 hover:text-red-400"}`}
                      title={team.active === false ? (isArabic ? "تفعيل الفريق" : "Activer l'équipe") : (isArabic ? "تعطيل الفريق" : "Désactiver l'équipe")}
                    >
                      <Power className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Join code management */}
                  <div className="flex items-center gap-2">
                    {issued && (
                      <div className={`flex items-center gap-1.5 border rounded px-2 py-1 ${countdown?.expired ? "bg-red-950/40 border-red-500/40" : countdown?.soon ? "bg-amber-950/30 border-amber-500/40" : "bg-zinc-950 border-amber-500/30"}`}>
                        <KeyRound className={`h-3 w-3 ${countdown?.expired ? "text-red-400" : "text-amber-400"}`} />
                        <span className={`font-mono font-extrabold text-xs tracking-[0.2em] ${countdown?.expired ? "text-red-300 line-through" : "text-amber-300"}`}>{issued.code}</span>
                        <button type="button" onClick={() => handleCopyCode(team.teamId)} className="text-gray-400 hover:text-amber-300 cursor-pointer" title={isArabic ? "نسخ" : "Copier"}>
                          <Copy className="h-3 w-3" />
                        </button>
                        {/* W5: live countdown — expired renders red, <30min amber. */}
                        <span
                          className={`text-[9px] font-bold ${countdown?.expired ? "text-red-400" : countdown?.soon ? "text-amber-300" : "text-gray-500"}`}
                          title={formatExpiry(issued.expiresAt, isArabic)}
                        >
                          {countdown?.text}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={mintingFor !== null}
                      onClick={() => handleMintCode(team.teamId)}
                      className="flex items-center gap-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-[10px] font-bold text-slate-300 rounded transition-all cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${mintingFor === team.teamId ? "animate-spin" : ""}`} />
                      {issued ? (isArabic ? "تجديد الرمز" : "Régénérer") : (isArabic ? "رمز انضمام" : "Code d'adhésion")}
                    </button>
                  </div>
                </div>

                {/* Members */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {team.members.length === 0 && (
                    <span className="text-[10px] text-gray-500">
                      {isArabic ? "لا أعضاء بعد — أدخل رمز الانضمام في جهاز الفريق" : "Aucun membre — saisissez le code sur l'appareil de terrain"}
                    </span>
                  )}
                  {team.members.map((m) => (
                    <span key={m.memberId} className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full border ${
                      m.online ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" : "bg-zinc-800 text-gray-400 border-white/10"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${m.online ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
                      {m.name}
                      {m.online && m.lat !== null && m.lng !== null && (
                        <button type="button" onClick={() => onTargetMember(team.teamId, m.memberId)} className="text-amber-400 hover:text-amber-300 cursor-pointer" title={isArabic ? "تحديد على الخريطة" : "Localiser"}>
                          <MapPin className="h-2.5 w-2.5" />
                        </button>
                      )}
                      {m.online && m.batteryPct !== null && <span className="text-gray-500">{Math.round(m.batteryPct)}%</span>}
                      <button
                        type="button"
                        onClick={() => handleRemoveMember(team.teamId, m.memberId, m.name)}
                        className="text-gray-500 hover:text-red-400 cursor-pointer"
                        title={isArabic ? "إزالة العضو" : "Retirer le membre"}
                      >
                        <UserMinus className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Mission / dispatch row */}
                {team.active === false ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-gray-400 flex items-center gap-1">
                      <Ban className="h-3 w-3" />
                      {isArabic ? "الفريق معطّل — لن يستقبل توجيهات حتى إعادة تفعيله" : "Équipe désactivée — aucune dépêche tant qu'elle n'est pas réactivée"}
                    </p>
                  </div>
                ) : (
                <div className="mt-2 flex items-center justify-between flex-wrap gap-2">
                  {busy ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[11px] text-amber-400 flex items-center gap-1 font-bold">
                        <Truck className="h-3 w-3" />
                        {isArabic ? "مهمة جارية على بلاغ" : "Mission active sur SOS"} {team.activeMission!.sosId}
                        <span className="text-[10px] text-gray-400 font-normal">
                          ({team.activeMission!.phase === "on_scene" ? (isArabic ? "في الموقع" : "Sur site") : isArabic ? "في الطريق" : "En route"})
                        </span>
                      </p>
                      {/* B3: force-clear a wedged mission (the lever that did
                          not exist — busy-forever teams had no escape). */}
                      <button
                        type="button"
                        disabled={leverBusy !== null}
                        onClick={() => handleClearMission(team.teamId)}
                        className="flex items-center gap-1 px-2 py-1 bg-red-950/40 hover:bg-red-900/50 border border-red-500/40 text-[10px] font-bold text-red-300 rounded transition-all cursor-pointer disabled:opacity-50"
                        title={isArabic ? "إلغاء المهمة قسرًا وتحرير الفريق" : "Forcer l'annulation et libérer l'équipe"}
                      >
                        <Trash2 className="h-3 w-3" />
                        {isArabic ? "إلغاء المهمة" : "Annuler la mission"}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={selectedSosId}
                        onChange={(e) => setDispatchSos((prev) => ({ ...prev, [team.teamId]: e.target.value }))}
                        className="bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 focus:outline-none max-w-[220px]"
                        aria-label={isArabic ? "اختيار بلاغ الاستغاثة" : "Sélection du SOS"}
                      >
                        <option value="">{isArabic ? "اختر بلاغ استغاثة..." : "Sélectionner SOS..."}</option>
                        {activeSos.map((sos) => (
                          <option key={sos.id} value={sos.id}>🚨 {sos.name} ({new Date(sos.timestamp).toLocaleTimeString()})</option>
                        ))}
                      </select>
                      {activeSos.length === 0 && (
                        <span className="text-[10px] text-gray-500">{isArabic ? "لا استغاثات نشطة حاليًا" : "Aucun SOS actif"}</span>
                      )}
                      <input
                        type="text"
                        value={dispatchNotes[team.teamId] || ""}
                        onChange={(e) => setDispatchNotes((prev) => ({ ...prev, [team.teamId]: e.target.value }))}
                        placeholder={isArabic ? "تعليمات (اختياري)..." : "Notes..."}
                        className="w-36 bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={dispatchLoading || dispatchingTeam !== null || !selectedSosId}
                        onClick={() => handleDispatch(team)}
                        className="bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-gray-500 border border-amber-500 text-black font-extrabold rounded px-3 py-1 text-[11px] transition-all cursor-pointer flex items-center gap-1"
                      >
                        <Truck className={`h-3 w-3 ${dispatchingTeam === team.teamId ? "animate-pulse" : ""}`} />
                        {dispatchingTeam === team.teamId ? (isArabic ? "جارٍ التوجيه..." : "Envoi...") : isArabic ? "توجيه" : "Dépêcher"}
                      </button>
                      {chip && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                          chip.ok ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"
                        }`}>{chip.text}</span>
                      )}
                    </div>
                  )}
                </div>
                )}

                {/* B2: blocked devices — with the unblock lever. */}
                {team.blockedPrincipals.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[9px] font-bold text-gray-500 flex items-center gap-1">
                      <Ban className="h-2.5 w-2.5" />
                      {isArabic ? `أجهزة محجوبة (${team.blockedPrincipals.length}):` : `Appareils bloqués (${team.blockedPrincipals.length}) :`}
                    </span>
                    {team.blockedPrincipals.map((principal) => (
                      <span key={principal} className="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded-full border bg-red-500/5 text-red-300/80 border-red-500/25">
                        {principal.slice(0, 14)}…
                        <button
                          type="button"
                          disabled={leverBusy !== null}
                          onClick={() => handleUnblockPrincipal(team.teamId, principal)}
                          className="text-gray-500 hover:text-emerald-300 cursor-pointer disabled:opacity-40"
                          title={isArabic ? "فك الحجب" : "Débloquer"}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
