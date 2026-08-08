import { useState } from "react";
import { Shield, HeartHandshake, MapPin, Truck, Search } from "lucide-react";
import { TrappedSOS } from "../../types";
import { TeamStatus, getTeamStatusBadge } from "./teams";

interface TeamsTableProps {
  isArabic: boolean;
  teams: TeamStatus[];
  sosCalls: TrappedSOS[];
  dispatchLoading: boolean;
  onDirectDispatch: (teamId: string, sosId: string, notes: string) => Promise<boolean>;
  onTargetTeam: (team: TeamStatus) => void;
}

export default function TeamsTable({ isArabic, teams, sosCalls, dispatchLoading, onDirectDispatch, onTargetTeam }: TeamsTableProps) {
  const [tableDispatchSosId, setTableDispatchSosId] = useState<Record<string, string>>({});
  const [tableDispatchNotes, setTableDispatchNotes] = useState<Record<string, string>>({});
  const [dispatchResult, setDispatchResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [dispatchingTeamId, setDispatchingTeamId] = useState<string | null>(null);
  const [teamSearch, setTeamSearch] = useState("");

  const filteredTeams = teams.filter((t) => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      t.id.toLowerCase().includes(q) ||
      t.teamNameAr.toLowerCase().includes(q) ||
      t.teamNameFr.toLowerCase().includes(q)
    );
  });

  const activeSos = sosCalls
    .filter((s) => s.status === "active")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const availableCount = teams.filter((t) => t.status === "available").length;
  const enRouteCount = teams.filter((t) => t.status === "en_route").length;
  const onSiteCount = teams.filter((t) => t.status === "on_site").length;

  const handleDispatchClick = async (team: TeamStatus) => {
    if (dispatchingTeamId) return;
    let sosId = tableDispatchSosId[team.id] || "";
    if (!sosId) {
      const oldestUnassigned = activeSos.find((s) => !s.dispatchedTeams || s.dispatchedTeams.length === 0);
      if (oldestUnassigned) {
        sosId = oldestUnassigned.id;
        setTableDispatchSosId((prev) => ({ ...prev, [team.id]: sosId }));
      } else if (activeSos.length > 0) {
        sosId = activeSos[0].id;
        setTableDispatchSosId((prev) => ({ ...prev, [team.id]: sosId }));
      } else {
        setDispatchResult((prev) => ({
          ...prev,
          [team.id]: { ok: false, text: isArabic ? "لا توجد استغاثات نشطة للتوجيه" : "Aucun SOS actif" },
        }));
        return;
      }
    }

    setDispatchingTeamId(team.id);
    setDispatchResult((prev) => {
      const next = { ...prev };
      delete next[team.id];
      return next;
    });
    const ok = await onDirectDispatch(team.id, sosId, tableDispatchNotes[team.id] || "");
    setDispatchingTeamId(null);
    if (ok) {
      setTableDispatchSosId((prev) => ({ ...prev, [team.id]: "" }));
      setTableDispatchNotes((prev) => ({ ...prev, [team.id]: "" }));
    }
    setDispatchResult((prev) => ({
      ...prev,
      [team.id]: ok
        ? { ok: true, text: isArabic ? "✓ تم توجيه الفريق" : "✓ Équipe dépêchée" }
        : { ok: false, text: isArabic ? "فشل التوجيه — تحقق من الاتصال" : "Échec du dispatch" },
    }));
  };

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-extrabold text-slate-200">
            {isArabic ? "جدول توجيه وإدارة فرق الإنقاذ" : "Tableau de Dispatch & Gestion des Équipes"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded-full font-bold">
            {availableCount} {isArabic ? "متاحة" : "Dispo"}
          </span>
          <span className="bg-amber-500/10 text-amber-400 border border-amber-500/25 px-2 py-0.5 rounded-full font-bold">
            {enRouteCount} {isArabic ? "في الطريق" : "En route"}
          </span>
          <span className="bg-red-500/10 text-red-400 border border-red-500/25 px-2 py-0.5 rounded-full font-bold">
            {onSiteCount} {isArabic ? "في الموقع" : "Sur site"}
          </span>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-white/5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
          <input
            type="text"
            value={teamSearch}
            onChange={(e) => setTeamSearch(e.target.value)}
            placeholder={isArabic ? "ابحث عن فرقة بالاسم أو ID..." : "Rechercher une équipe..."}
            className="w-full bg-zinc-950 border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none focus:border-amber-500/40"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs text-start">
          <thead>
            <tr className="border-b border-white/5 text-gray-500 text-[11px] uppercase tracking-wider font-semibold">
              <th className="px-4 py-3 text-start">{isArabic ? "الفرقة" : "Équipe"}</th>
              <th className="px-4 py-3 text-start">{isArabic ? "النوع" : "Type"}</th>
              <th className="px-4 py-3 text-start">{isArabic ? "الموقع الحالي" : "Localisation"}</th>
              <th className="px-4 py-3 text-start">{isArabic ? "الحالة" : "Statut"}</th>
              <th className="px-4 py-3 text-start min-w-[280px]">{isArabic ? "عملية التوجيه السريع" : "Dispatch Rapide"}</th>
            </tr>
          </thead>
          <tbody>
            {filteredTeams.map((team) => {
              const teamName = isArabic ? team.teamNameAr : team.teamNameFr;
              const isPC = team.type === "protection_civile";
              const selectedSosIdForTeam = tableDispatchSosId[team.id] || "";
              const notesForTeam = tableDispatchNotes[team.id] || "";
              const badge = getTeamStatusBadge(team, isArabic);

              return (
                <tr key={team.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  {/* Team Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-lg">{team.emoji}</span>
                      <div>
                        <p className="font-extrabold text-slate-100">{teamName}</p>
                        <p className="text-[10px] text-gray-500 font-mono">ID: {team.id}</p>
                      </div>
                    </div>
                  </td>

                  {/* Team Type */}
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      isPC
                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }`}>
                      {isPC ? <Shield className="h-2.5 w-2.5" /> : <HeartHandshake className="h-2.5 w-2.5" />}
                      {isPC ? (isArabic ? "حماية مدنية" : "Protection Civile") : (isArabic ? "متطوعون" : "Volontaires")}
                    </span>
                  </td>

                  {/* Coordinates & Target Button */}
                  <td className="px-4 py-3 font-mono text-[11px] text-gray-400">
                    <div className="flex items-center gap-2">
                      <span>{team.currentLat.toFixed(4)}, {team.currentLng.toFixed(4)}</span>
                      <button
                        type="button"
                        onClick={() => onTargetTeam(team)}
                        className="p-1 bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-amber-400 rounded transition-all cursor-pointer"
                        title={isArabic ? "تحديد الموقع على الخريطة" : "Localiser sur la carte"}
                      >
                        <MapPin className="h-3 w-3" />
                      </button>
                    </div>
                  </td>

                  {/* Live Status */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${badge.indicator}`} />
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-extrabold tracking-wide uppercase border ${badge.badge}`}>
                        {team.status === "available" ? (isArabic ? "متاح" : "DISPO") : team.status === "en_route" ? (isArabic ? "في الطريق" : "EN ROUTE") : (isArabic ? "في الموقع" : "SUR SITE")}
                      </span>
                    </div>
                  </td>

                  {/* Direct Dispatch Dropdown Form & Active Mission status */}
                  <td className="px-4 py-3">
                    {team.status === "available" ? (
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 max-w-sm">
                        <div className="flex-1 min-w-[140px]">
                          <select
                            value={selectedSosIdForTeam}
                            onChange={(e) => setTableDispatchSosId(prev => ({ ...prev, [team.id]: e.target.value }))}
                            className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 focus:outline-none"
                          >
                            <option value="">{isArabic ? "اختر بلاغ استغاثة..." : "Sélectionner SOS..."}</option>
                            {activeSos.map((sos) => (
                              <option key={sos.id} value={sos.id}>
                                🚨 {sos.name} ({new Date(sos.timestamp).toLocaleTimeString()})
                              </option>
                            ))}
                            {activeSos.length === 0 && (
                              <option value="" disabled>{isArabic ? "لا توجد استغاثات نشطة" : "Aucun SOS actif"}</option>
                            )}
                          </select>
                        </div>

                        <div className="flex-1">
                          <input
                            type="text"
                            value={notesForTeam}
                            onChange={(e) => setTableDispatchNotes(prev => ({ ...prev, [team.id]: e.target.value }))}
                            placeholder={isArabic ? "تعليمات التوجيه (اختياري)..." : "Notes d'opération..."}
                            className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none"
                          />
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={dispatchLoading || dispatchingTeamId !== null}
                            onClick={() => handleDispatchClick(team)}
                            className="bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-gray-500 disabled:border-zinc-800 border border-amber-500 text-black font-extrabold rounded px-3 py-1 text-[11px] transition-all cursor-pointer shrink-0 flex items-center gap-1"
                          >
                            <Truck className={`h-3 w-3 ${dispatchingTeamId === team.id ? "animate-pulse" : ""}`} />
                            <span>
                              {dispatchingTeamId === team.id
                                ? (isArabic ? "جارٍ التوجيه..." : "Envoi...")
                                : (isArabic ? "توجيه الفريق" : "Dépêcher")}
                            </span>
                          </button>
                          {dispatchResult[team.id] && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                              dispatchResult[team.id].ok
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                : "bg-red-500/10 text-red-400 border-red-500/30"
                            }`}>
                              {dispatchResult[team.id].text}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-300">
                        <p className="flex items-center gap-1 text-amber-400">
                          <Truck className="h-3 w-3" />
                          <span className="font-bold">{isArabic ? "مهمة جارية:" : "Mission active:"}</span>
                          <span className="text-slate-100 font-extrabold">{team.assistedPerson}</span>
                        </p>
                        {team.notes && (
                          <p className="text-[10px] text-gray-400 mt-1 italic max-w-xs truncate" title={team.notes}>
                            "{team.notes}"
                          </p>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
