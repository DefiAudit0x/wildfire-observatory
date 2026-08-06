import { useMemo, useState } from "react";
import { FileText, Filter, Check, X, CheckCircle2, ShieldAlert } from "lucide-react";
import { Report } from "../../types";

interface ReportsTableProps {
  isArabic: boolean;
  reports: Report[];
  token: string;
  onChanged: () => void;
}

const STATUS_META: Record<string, { labelAr: string; labelFr: string; cls: string }> = {
  pending: { labelAr: "قيد المراجعة", labelFr: "En attente", cls: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
  verified: { labelAr: "مؤكد", labelFr: "Vérifié", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  rejected: { labelAr: "مرفوض", labelFr: "Rejeté", cls: "bg-red-500/10 text-red-400 border-red-500/20" },
  resolved: { labelAr: "تم الإخماد", labelFr: "Résolu", cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
};

const SEVERITY_META: Record<string, { labelAr: string; labelFr: string; cls: string }> = {
  low: { labelAr: "منخفض", labelFr: "Faible", cls: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  medium: { labelAr: "متوسط", labelFr: "Moyen", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  high: { labelAr: "مرتفع", labelFr: "Haut", cls: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  critical: { labelAr: "حرج", labelFr: "Critique", cls: "bg-red-600/20 text-red-400 border-red-500/30 animate-pulse" },
};

export default function ReportsTable({ isArabic, reports, token, onChanged }: ReportsTableProps) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: reports.length };
    for (const r of reports) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [reports]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.locationName?.toLowerCase().includes(q) ||
        r.wilaya?.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q) ||
        (r.reporterName || "").toLowerCase().includes(q)
      );
    });
  }, [reports, statusFilter, search]);

  const updateStatus = async (id: string, body: Record<string, string>) => {
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) onChanged();
    } catch (err) {
      console.error("Status update failed:", err);
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-xs font-bold text-slate-300">
            {isArabic ? "سجل البلاغات الكامل" : "Registre complet des signalements"}
          </span>
          <span className="text-[10px] text-gray-500">({reports.length})</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="h-3 w-3 text-gray-500" />
          {[
            ["all", isArabic ? "الكل" : "Tous"],
            ["pending", STATUS_META.pending.labelAr],
            ["verified", STATUS_META.verified.labelAr],
            ["rejected", STATUS_META.rejected.labelAr],
            ["resolved", STATUS_META.resolved.labelAr],
          ].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setStatusFilter(val)}
              className={`px-2 py-0.5 rounded-full text-[9px] font-bold border transition-all cursor-pointer ${
                statusFilter === val
                  ? "bg-amber-500/20 text-amber-400 border-amber-500/40"
                  : "bg-black/30 text-gray-400 border-white/5 hover:text-slate-300"
              }`}
            >
              {label} ({counts[val] || 0})
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-2 border-b border-white/5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isArabic ? "بحث بالموقع، الولاية، الوصف..." : "Rechercher lieu, wilaya, description..."}
          className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none focus:border-amber-500/40"
        />
      </div>

      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-zinc-950 z-10">
            <tr className="text-[9px] uppercase tracking-wider text-gray-500 border-b border-white/5">
              <th className="text-start px-3 py-2">{isArabic ? "الموقع" : "Lieu"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "الولاية" : "Wilaya"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "الشدة" : "Sévérité"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "الحالة" : "Statut"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "المُبلّغ" : "Auteur"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "الوقت" : "Heure"}</th>
              <th className="text-start px-2 py-2">{isArabic ? "إجراء" : "Action"}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((rep) => {
              const sMeta = STATUS_META[rep.status] || STATUS_META.pending;
              const sevMeta = SEVERITY_META[rep.severity] || SEVERITY_META.low;
              return (
                <tr key={rep.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                  <td className="px-3 py-2 font-bold text-slate-200 max-w-[180px] truncate">
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                      {rep.locationName || rep.id}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-gray-400">{rep.wilaya}</td>
                  <td className="px-2 py-2">
                    <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${sevMeta.cls}`}>
                      {isArabic ? sevMeta.labelAr : sevMeta.labelFr}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${sMeta.cls}`}>
                      {isArabic ? sMeta.labelAr : sMeta.labelFr}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-gray-400">
                    {rep.reporterType === "official" ? "🛡️" : rep.reporterType === "volunteer" ? "💚" : "👤"} {rep.reporterName || "-"}
                  </td>
                  <td className="px-2 py-2 text-gray-500 font-mono text-[9px]">
                    {new Date(rep.timestamp).toLocaleDateString()} {new Date(rep.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-2 py-2">
                    {rep.status === "pending" && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateStatus(rep.id, { status: "verified" })}
                          disabled={updatingId === rep.id}
                          title={isArabic ? "تأكيد" : "Vérifier"}
                          className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded p-1 cursor-pointer"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => updateStatus(rep.id, { status: "rejected" })}
                          disabled={updatingId === rep.id}
                          title={isArabic ? "رفض" : "Rejeter"}
                          className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded p-1 cursor-pointer"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    {rep.status === "verified" && (
                      <button
                        onClick={() => updateStatus(rep.id, { status: "resolved" })}
                        disabled={updatingId === rep.id}
                        title={isArabic ? "تم الإخماد" : "Marquer résolu"}
                        className="bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 rounded p-1 cursor-pointer flex items-center gap-0.5"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        <span className="text-[8px] font-bold">{isArabic ? "إخماد" : "Résoudre"}</span>
                      </button>
                    )}
                    {rep.status === "rejected" && <span className="text-gray-600 text-[9px]">-</span>}
                    {rep.status === "resolved" && <ShieldAlert className="h-3 w-3 text-blue-500/50" />}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-xs text-gray-600">
                  {isArabic ? "لا توجد بلاغات مطابقة" : "Aucun signalement"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
