import { useState } from "react";
import { Radio, Phone, MapPin, Check, Volume2, AlertTriangle, Clock } from "lucide-react";
import { TrappedSOS } from "../../types";
import { getTeamStatusText } from "./teams";

interface SosPanelProps {
  isArabic: boolean;
  sosCalls: TrappedSOS[];
  dispatchLoading: boolean;
  onDispatch: (sosId: string, type: "protection_civile" | "volunteers", teamId: string, notes: string) => Promise<boolean>;
  onResolve: (sos: TrappedSOS) => void;
  onFocusSos: (sos: TrappedSOS) => void;
  onAudioError?: () => void;
}

export default function SosPanel({ isArabic, sosCalls, dispatchLoading, onDispatch, onResolve, onFocusSos, onAudioError }: SosPanelProps) {
  const [dispatchingSosId, setDispatchingSosId] = useState<string | null>(null);
  const [dispatchType, setDispatchType] = useState<'protection_civile' | 'volunteers'>('protection_civile');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [dispatchNotes, setDispatchNotes] = useState('');
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);

  const handleDispatchSubmit = async (sosId: string) => {
    if (!selectedTeam) return;
    const ok = await onDispatch(sosId, dispatchType, selectedTeam, dispatchNotes);
    if (ok) {
      setDispatchingSosId(null);
      setSelectedTeam('');
      setDispatchNotes('');
    }
  };

  const fetchAudio = async (sos: TrappedSOS) => {
    if (audioUrls[sos.id] || loadingAudio === sos.id) return;
    setLoadingAudio(sos.id);
    try {
      const res = await fetch(`/api/sos/${sos.id}`, { credentials: "same-origin" });
      if (res.ok) {
        const full = await res.json();
        if (full.audioUrl) {
          setAudioUrls((prev) => ({ ...prev, [sos.id]: full.audioUrl }));
        }
      }
    } catch (err) {
      console.error("Failed to load SOS audio:", err);
      onAudioError?.();
    } finally {
      setLoadingAudio(null);
    }
  };

  const activeSos = sosCalls
    .filter((s) => s.status === "active")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const waitingCount = activeSos.filter((s) => !s.dispatchedTeams || s.dispatchedTeams.length === 0).length;

  return (
    <div className="bg-zinc-900/60 border border-red-500/10 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden">
      <div className="px-4 py-2.5 bg-red-950/20 border-b border-red-500/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-red-500 animate-pulse" />
          <span className="text-xs font-black text-red-400">
            {isArabic ? "استغاثات SOS النشطة" : "Urgences SOS Actives"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {waitingCount > 0 && (
            <span className="bg-amber-500/20 text-amber-400 text-[9px] font-black px-1.5 py-0.5 rounded-full border border-amber-500/30">
              {isArabic ? `${waitingCount} بانتظار التوجيه` : `${waitingCount} sans dispatch`}
            </span>
          )}
          <span className="bg-red-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full animate-pulse">
            {activeSos.length}
          </span>
        </div>
      </div>

      <div className="p-3 space-y-2 overflow-y-auto max-h-[300px]">
        {activeSos.length === 0 ? (
          <div className="text-center py-6 text-xs text-gray-500 font-bold">
            🎉 {isArabic ? "لا توجد استغاثات نشطة حالياً" : "Aucun SOS actif"}
          </div>
        ) : (
          activeSos.map((sos) => {
            const hasDispatch = sos.dispatchedTeams && sos.dispatchedTeams.length > 0;
            const ageMin = Math.floor((Date.now() - new Date(sos.timestamp).getTime()) / 60000);
            return (
              <div key={sos.id} className={`rounded-lg p-2.5 text-[11px] space-y-2 text-start relative overflow-hidden border ${
                hasDispatch ? "bg-emerald-950/20 border-emerald-500/30" : "bg-red-950/10 border-red-500/20"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-black text-slate-100 flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full animate-ping inline-block ${hasDispatch ? "bg-emerald-500" : "bg-red-500"}`} />
                    <span>{sos.name}</span>
                    {hasDispatch ? (
                      <span className="text-[8px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 py-0.5 rounded font-bold">🚒 {isArabic ? "فريق موجّه" : "Dispatché"}</span>
                    ) : (
                      <span className="text-[8px] bg-red-500/20 text-red-400 border border-red-500/30 px-1 py-0.5 rounded font-bold animate-pulse">⚠️ {isArabic ? "بانتظار التوجيه" : "En attente"}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1 text-[9px] text-red-400/80 font-mono">
                    {ageMin < 60 ? (
                      <span className="flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />{ageMin} {isArabic ? "د" : "m"}</span>
                    ) : (
                      new Date(sos.timestamp).toLocaleTimeString()
                    )}
                  </span>
                </div>

                {sos.phone && (
                  <div className="flex items-center gap-1 text-[10px] text-gray-400">
                    <Phone className="h-3 w-3 text-red-400" />
                    <a href={`tel:${sos.phone}`} className="font-bold font-mono hover:underline text-slate-200">
                      {sos.phone}
                    </a>
                  </div>
                )}

                {/* SOS Audio Recording Player */}
                {sos.audioUrl || audioUrls[sos.id] ? (
                  <div className="bg-red-950/60 border border-red-500/30 rounded-lg p-2 space-y-1">
                    <div className="flex items-center justify-between text-[9px] font-bold text-red-300">
                      <span>{isArabic ? "🔊 الاستغاثة الصوتية المسجلة" : "🔊 Message vocal SOS"}</span>
                      {sos.audioDuration && (
                        <span className="font-mono text-gray-400">{sos.audioDuration}s</span>
                      )}
                    </div>
                    <audio controls src={sos.audioUrl || audioUrls[sos.id]} className="w-full h-8 rounded" />
                  </div>
                ) : sos.hasAudio ? (
                  <button
                    type="button"
                    onClick={() => fetchAudio(sos)}
                    disabled={loadingAudio === sos.id}
                    className="w-full flex items-center justify-center gap-1 bg-red-950/60 border border-red-500/30 text-red-300 rounded-lg p-1.5 text-[9px] font-bold cursor-pointer hover:bg-red-950"
                  >
                    <Volume2 className="h-3 w-3" />
                    {loadingAudio === sos.id
                      ? (isArabic ? "جاري التحميل..." : "Chargement...")
                      : (isArabic ? "استماع للتسجيل الصوتي" : "Écouter le vocal")}
                  </button>
                ) : (
                  <div className="text-[9px] text-gray-500 italic">
                    {isArabic ? "بدون تسجيل صوتي" : "Pas de vocal"}
                  </div>
                )}

                {/* Dispatched Teams List */}
                {hasDispatch && (
                  <div className="space-y-1 text-start pt-1 border-t border-white/5">
                    <span className="text-[9px] font-extrabold uppercase text-emerald-400 block">
                      {isArabic ? "الفرق الموجهة:" : "Dépêchés:"}
                    </span>
                    {sos.dispatchedTeams!.map((team, idx) => {
                      const status = getTeamStatusText(team.dispatchedAt, isArabic);
                      return (
                        <div key={idx} className="bg-black/30 border border-white/5 rounded p-1 text-[10px] flex items-center justify-between gap-1">
                          <span className="font-bold text-slate-300 truncate max-w-[130px]">
                            {team.type === "protection_civile" ? "🚒 " : "💚 "}
                            {isArabic ? team.teamNameAr : team.teamNameFr}
                          </span>
                          <span className={`text-[8px] font-extrabold border px-1 py-0.5 rounded shrink-0 ${
                            status.arrived
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          }`}>
                            {status.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Dispatch trigger & form */}
                <div className="pt-1 border-t border-white/5">
                  {dispatchingSosId === sos.id ? (
                    <div className="bg-black/40 border border-red-500/10 rounded p-1.5 space-y-1.5 text-start mt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-bold text-red-400">{isArabic ? "توجيه سريع" : "Dispatch"}</span>
                        <button
                          type="button"
                          onClick={() => setDispatchingSosId(null)}
                          className="text-gray-500 hover:text-slate-300 text-[9px] cursor-pointer"
                        >
                          {isArabic ? "إلغاء" : "Annuler"}
                        </button>
                      </div>

                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => { setDispatchType('protection_civile'); setSelectedTeam(''); }}
                          className={`flex-1 py-0.5 px-1 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                            dispatchType === 'protection_civile' ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-black/20 border-white/5 text-gray-500"
                          }`}
                        >
                          🚒 {isArabic ? "حماية" : "PC"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setDispatchType('volunteers'); setSelectedTeam(''); }}
                          className={`flex-1 py-0.5 px-1 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                            dispatchType === 'volunteers' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-black/20 border-white/5 text-gray-500"
                          }`}
                        >
                          💚 {isArabic ? "متطوع" : "VOL"}
                        </button>
                      </div>

                      <select
                        value={selectedTeam}
                        onChange={(e) => setSelectedTeam(e.target.value)}
                        className="w-full bg-zinc-950 border border-white/10 rounded p-1 text-[10px] text-slate-300 focus:outline-none"
                      >
                        <option value="">{isArabic ? "اختر فرقة" : "Sélectionner"}</option>
                        {dispatchType === 'protection_civile' ? (
                          <>
                            <option value="unit_1">🚒 {isArabic ? "وحدة التدخل السريع 1" : "RAPIDE 1"}</option>
                            <option value="unit_2">🚒 {isArabic ? "وحدة الدعم والإسناد" : "SOUTIEN"}</option>
                            <option value="unit_3">🚒 {isArabic ? "وحدة الإنقاذ الجبلية" : "MONTAGNE"}</option>
                          </>
                        ) : (
                          <>
                            <option value="vol_1">💚 {isArabic ? "الهلال الأحمر الجزائري" : "CRA"}</option>
                            <option value="vol_2">💚 {isArabic ? "رابطة المتطوعين" : "Assoc"}</option>
                            <option value="vol_3">💚 {isArabic ? "فرقة الدراجات النارية" : "MOTO"}</option>
                          </>
                        )}
                      </select>

                      <input
                        type="text"
                        value={dispatchNotes}
                        onChange={(e) => setDispatchNotes(e.target.value)}
                        placeholder={isArabic ? "تعليمات (اختياري)..." : "Notes (optionnel)..."}
                        className="w-full bg-zinc-950 border border-white/10 rounded p-1 text-[10px] text-slate-300 placeholder:text-gray-600 focus:outline-none"
                      />

                      <button
                        type="button"
                        disabled={dispatchLoading || !selectedTeam}
                        onClick={() => handleDispatchSubmit(sos.id)}
                        className="w-full bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold rounded py-1 text-[9px] cursor-pointer"
                      >
                        {isArabic ? "إرسال الفرقة" : "Envoyer"}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDispatchingSosId(sos.id);
                        setDispatchType('protection_civile');
                        setSelectedTeam('');
                        setDispatchNotes('');
                      }}
                      className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-1"
                    >
                      <Radio className="h-3 w-3 text-red-500 animate-pulse" />
                      <span>{isArabic ? "توجيه نجدة للمحاصر" : "Dépêcher secours"}</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 pt-1 border-t border-white/5">
                  <button
                    onClick={() => onFocusSos(sos)}
                    className="flex-1 bg-black/40 hover:bg-zinc-800 text-slate-300 font-bold border border-white/10 rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-0.5"
                  >
                    <MapPin className="h-2.5 w-2.5 text-red-500" />
                    <span>{isArabic ? "تحديد" : "Cibler"}</span>
                  </button>

                  <button
                    onClick={() => onResolve(sos)}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-600 text-white font-bold rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-0.5"
                  >
                    <Check className="h-3 w-3" />
                    <span>{isArabic ? "تم الإنقاذ" : "Sauvé"}</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
