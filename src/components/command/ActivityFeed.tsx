import { Activity } from "lucide-react";
import { Report } from "../../types";

interface ActivityFeedProps {
  isArabic: boolean;
  reports: Report[];
}

export default function ActivityFeed({ isArabic, reports }: ActivityFeedProps) {
  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-xs font-bold text-slate-300">
          {isArabic ? "النشاط الميداني" : "Flux d'activité mieldien"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto max-h-[220px] p-3 space-y-2">
        {reports.slice(0, 30).map((rep) => (
          <div key={rep.id} className="bg-black/40 rounded-lg p-2.5 border border-white/5 text-[11px] space-y-1 text-start">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-200 truncate max-w-[140px]">{rep.locationName}</span>
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                rep.status === "pending" ? "bg-yellow-500/10 text-yellow-400" :
                rep.status === "verified" ? "bg-emerald-500/10 text-emerald-400" :
                rep.status === "resolved" ? "bg-blue-500/10 text-blue-400" :
                "bg-red-500/10 text-red-400"
              }`}>
                {rep.status}
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px] text-gray-500">
              <span>{rep.wilaya}</span>
              <span>{new Date(rep.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {rep.reporterType === "official" && <span className="text-[8px] text-amber-400">🛡️</span>}
              {rep.reporterType === "volunteer" && <span className="text-[8px] text-emerald-400">💚</span>}
              <span className="text-[9px] text-gray-500">
                {isArabic ? "تأكيد" : "Conf"}: {rep.consensusCount}
              </span>
              {rep.aiVerification && (
                <span className="text-[8px] bg-emerald-950 text-emerald-400 px-1 rounded">AI</span>
              )}
            </div>
          </div>
        ))}
        {reports.length === 0 && (
          <div className="text-center py-8 text-xs text-gray-600">
            {isArabic ? "لا توجد بلاغات حديثة" : "Aucun signalement récent"}
          </div>
        )}
      </div>
    </div>
  );
}
