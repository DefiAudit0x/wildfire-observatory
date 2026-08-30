import { Activity, MapPin, ShieldCheck, Sparkles } from "lucide-react";
import { Report } from "../../types";
import { useNowTick } from "../../hooks/useNowTick";

interface ActivityFeedProps {
  isArabic: boolean;
  reports: Report[];
}

const SEV_CLS: Record<string, string> = {
  low: "border-sky-500/20 bg-sky-500/5",
  medium: "border-amber-500/20 bg-amber-500/5",
  high: "border-orange-500/20 bg-orange-500/5",
  critical: "border-red-500/30 bg-red-500/10",
};

const SEV_DOT: Record<string, string> = {
  low: "bg-sky-400",
  medium: "bg-amber-400",
  high: "bg-orange-400",
  critical: "bg-red-500",
};

function timeAgo(ts: string, isArabic: boolean, now: number): string {
  const diff = now - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return isArabic ? "الآن" : "à l'instant";
  if (min < 60) return isArabic ? `قبل ${min} د` : `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return isArabic ? `قبل ${h} س` : `il y a ${h} h`;
  return new Date(ts).toLocaleDateString();
}

// ARC-L22: the status chip previously rendered `{isArabic ? rep.status : rep.status}`
// — a dead ternary that showed English machine values in the Arabic UI.
const STATUS_META: Record<string, { ar: string; fr: string; cls: string }> = {
  pending: { ar: "بانتظار التحقق", fr: "En attente", cls: "bg-yellow-500/10 text-yellow-400" },
  verified: { ar: "مُوثّق", fr: "Vérifié", cls: "bg-emerald-500/10 text-emerald-400" },
  resolved: { ar: "معالَج", fr: "Résolu", cls: "bg-blue-500/10 text-blue-400" },
  rejected: { ar: "مرفوض", fr: "Rejeté", cls: "bg-red-500/10 text-red-400" },
};

export default function ActivityFeed({ isArabic, reports }: ActivityFeedProps) {
  // ARC-L22: shared age tick so "قبل N د" advances between data polls.
  const now = useNowTick(30_000);
  const sorted = [...reports]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 30);

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-xs font-bold text-slate-300">
          {isArabic ? "النشاط الميداني" : "Flux d'activité terrain"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto max-h-[260px] p-3 space-y-2">
        {sorted.map((rep) => {
          const sevCls = SEV_CLS[rep.severity] || SEV_CLS.low;
          const dot = SEV_DOT[rep.severity] || SEV_DOT.low;
          return (
            <div key={rep.id} className={`rounded-lg p-2.5 border text-[11px] space-y-1 text-start ${sevCls}`}>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-200 truncate max-w-[150px] flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${dot} shrink-0 ${rep.severity === "critical" ? "animate-ping" : ""}`} />
                  {rep.locationName}
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                  (STATUS_META[rep.status] || STATUS_META.pending).cls
                }`}>
                  {isArabic
                    ? (STATUS_META[rep.status] || STATUS_META.pending).ar
                    : (STATUS_META[rep.status] || STATUS_META.pending).fr}
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px] text-gray-500">
                <span className="flex items-center gap-0.5">
                  <MapPin className="h-2.5 w-2.5" />
                  {rep.wilaya}
                </span>
                <span>{timeAgo(rep.timestamp, isArabic, now)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {rep.reporterType === "official" && <span className="text-[8px] text-amber-400">🛡️</span>}
                {rep.reporterType === "volunteer" && <span className="text-[8px] text-emerald-400">💚</span>}
                <span className="text-[9px] text-gray-500">
                  {isArabic ? "تأكيد" : "Conf"}: {rep.consensusCount}
                </span>
                {rep.aiVerification && (
                  <span className="text-[8px] bg-emerald-950 text-emerald-400 px-1 rounded flex items-center gap-0.5">
                    <Sparkles className="h-2 w-2" />
                    {rep.aiVerification.isVerified ? "AI" : "AI?"}
                  </span>
                )}
                {rep.reporterType === "official" && (
                  <span className="text-[8px] text-amber-400/80 flex items-center gap-0.5">
                    <ShieldCheck className="h-2 w-2" />
                    {isArabic ? "رسمي" : "Officiel"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="text-center py-8 text-xs text-gray-600">
            {isArabic ? "لا توجد بلاغات حديثة" : "Aucun signalement récent"}
          </div>
        )}
      </div>
    </div>
  );
}
