import { useEffect, useRef, useState } from "react";
import { Shield, HeartHandshake, KeyRound, MapPin, Plus, Radio, Search, Truck, Users, Copy, RefreshCw, UserMinus, X } from "lucide-react";
import { TrappedSOS } from "../../types";
import { apiFetch, isSessionExpiry } from "../../utils/adminApi";
import { RegisteredTeam, JoinCodeIssued } from "./registeredTeams";

/**
 * Team Mode (Phase 1) — registered field teams and their live GPS members.
 * This panel is the real replacement for the simulated dispatch table below
 * it (TeamsTable keeps rendering the legacy simulated rows until every
 * operation migrates). Dispatch here sends teamId; the server resolves the
 * team entity inside the dispatch transaction.
 */

interface RegisteredTeamsProps {
  isArabic: boolean;
  teams: RegisteredTeam[];
  sosCalls: TrappedSOS[];
  dispatchLoading: boolean;
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

export default function RegisteredTeams({ isArabic, teams, sosCalls, dispatchLoading, onDispatch, onTargetMember, onTeamsChanged, onSessionExpired, notify }: RegisteredTeamsProps) {
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
    try {
      const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`, "DELETE");
      if (res.ok) {
        notify(isArabic ? `تمت إزالة ${name}` : `${name} retiré`, "success");
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
            return (
              <div key={team.teamId} className="px-4 py-3">
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
                  </div>

                  {/* Join code management */}
                  <div className="flex items-center gap-2">
                    {issued && (
                      <div className="flex items-center gap-1.5 bg-zinc-950 border border-amber-500/30 rounded px-2 py-1">
                        <KeyRound className="h-3 w-3 text-amber-400" />
                        <span className="font-mono font-extrabold text-amber-300 text-xs tracking-[0.2em]">{issued.code}</span>
                        <button type="button" onClick={() => handleCopyCode(team.teamId)} className="text-gray-400 hover:text-amber-300 cursor-pointer" title={isArabic ? "نسخ" : "Copier"}>
                          <Copy className="h-3 w-3" />
                        </button>
                        <span className="text-[9px] text-gray-500">{formatExpiry(issued.expiresAt, isArabic)}</span>
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
                <div className="mt-2 flex items-center justify-between flex-wrap gap-2">
                  {busy ? (
                    <p className="text-[11px] text-amber-400 flex items-center gap-1 font-bold">
                      <Truck className="h-3 w-3" />
                      {isArabic ? "مهمة جارية على بلاغ" : "Mission active sur SOS"} {team.activeMission!.sosId}
                      <span className="text-[10px] text-gray-400 font-normal">
                        ({team.activeMission!.phase === "on_scene" ? (isArabic ? "في الموقع" : "Sur site") : isArabic ? "في الطريق" : "En route"})
                      </span>
                    </p>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
