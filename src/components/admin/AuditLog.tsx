import { useState, useEffect, useCallback, useRef } from "react";
import { ScrollText, RefreshCw, Clock, ShieldCheck, ChevronLeft, ChevronRight } from "lucide-react";
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

const ITEMS_PER_PAGE = 20;

function renderDetails(details: Record<string, unknown>) {
  if (!details || Object.keys(details).length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {Object.entries(details).map(([key, value]) => (
        <div key={key} className="flex flex-wrap gap-x-2 text-[10px]">
          <span className="text-gray-500 font-bold shrink-0">{key}:</span>
          <span className="text-gray-400 break-all">
            {typeof value === "object" ? JSON.stringify(value) : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AuditLog({ lang, onAuthError }: AuditLogProps) {
  const isArabic = lang === "ar";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  // ARC-M27 fix: onAuthError is an inline prop recreated on every parent
  // render, so its identity in this dependency array re-fetched the whole log
  // on EVERY keystroke typed anywhere in the admin panel. The latest callback
  // lives in a ref; the effect fires on mount only.
  const onAuthErrorRef = useRef(onAuthError);
  useEffect(() => {
    onAuthErrorRef.current = onAuthError;
  });

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/audit", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setEntries(data);
          setPage(1);
        }
      } else if (!onAuthErrorRef.current(res)) {
        // silent
      }
    } catch (err) {
      console.error("Failed to load audit log", err);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const totalPages = Math.max(1, Math.ceil(entries.length / ITEMS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginated = entries.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

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
          paginated.map((e) => (
            <div key={e.id} className="bg-black/40 border border-white/5 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="h-3 w-3 text-amber-400 shrink-0" />
                  {actionLabel(e.action)}
                </p>
                {renderDetails(e.details)}
              </div>
              <span className="text-[10px] text-gray-500 font-mono shrink-0 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(e.timestamp).toLocaleString(isArabic ? "ar-DZ" : "fr-DZ")}
              </span>
            </div>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="p-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-slate-300 flex items-center gap-1 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
          >
            {isArabic ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            {isArabic ? "السابق" : "Précédent"}
          </button>
          <span className="text-xs text-gray-400 font-mono">{safePage} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="flex px-2 py-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-zinc-300 flex items-center gap-1 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
          >
            {isArabic ? "التالي" : "Suivant"}
            {isArabic ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}