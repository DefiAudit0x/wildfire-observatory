import { useState, useEffect, useCallback } from "react";
import { ScrollText, RefreshCw, Clock, ShieldCheck } from "lucide-react";
import { Language } from "../../types";

interface AuditEntry {
  id: string;
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

interface AuditLogProps {
  lang: Language;
  onAuthError: (res: Response) => boolean;
}

export default function AuditLog({ lang, onAuthError }: AuditLogProps) {
  const isArabic = lang === "ar";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/audit", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setEntries(data);
      } else if (!onAuthError(res)) {
        // silent
      }
    } catch (err) {
      console.error("Failed to load audit log", err);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const actionLabel = (action: string): string => {
    const map: Record<string, string> = {
      "admin.login": isArabic ? "دخول مشرف" : "Connexion admin",
      "report.update-status": isArabic ? "تحديث حالة/خطورة بلاغ" : "MAJ signalement",
      "report.delete": isArabic ? "حذف بلاغ" : "Suppression signalement",
      "volunteer.approve": isArabic ? "اعتماد متطوع" : "Approbation bénévole",
    };
    return map[action] || action;
  };

  return (
    <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-amber-400" />
          {isArabic ? "سجل تدقيق إجراءات المشرفين" : "Journal d'audit des actions admin"}
        </h3>
        <button
          onClick={fetchEntries}
          disabled={loading}
          className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-[11px] font-bold text-slate-300 flex items-center gap-1.5 cursor-pointer transition-all"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          {isArabic ? "تحديث" : "Rafraîchir"}
        </button>
      </div>

      <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
        {entries.length === 0 ? (
          <div className="text-center py-10 text-xs text-gray-500">
            {isArabic ? "لا توجد إجراءات مسجلة بعد." : "Aucune action enregistrée pour l'instant."}
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="bg-black/40 border border-white/5 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="h-3 w-3 text-amber-400 shrink-0" />
                  {actionLabel(e.action)}
                </p>
                {e.details && Object.keys(e.details).length > 0 && (
                  <p className="text-[10px] text-gray-400 font-mono break-all">
                    {JSON.stringify(e.details)}
                  </p>
                )}
              </div>
              <span className="text-[10px] text-gray-500 font-mono shrink-0 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(e.timestamp).toLocaleString(isArabic ? "ar-DZ" : "fr-DZ")}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
