import { useState } from "react";
import { Phone, ShieldAlert, CheckCircle, AlertTriangle, Info, Search } from "lucide-react";
import { WilayaStatus } from "../types";

interface WilayaListProps {
  wilayas: WilayaStatus[];
  lang: "ar" | "fr";
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, safe: 0 };

export default function WilayaList({ wilayas, lang }: WilayaListProps) {
  const isArabic = lang === "ar";
  const [searchQuery, setSearchQuery] = useState("");

  const sortedWilayas = [...wilayas]
    .filter((w) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return w.nameAr.toLowerCase().includes(q) || w.nameFr.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (sev !== 0) return sev;
      const impact = b.activeFires + b.satelliteHotspots - (a.activeFires + a.satelliteHotspots);
      if (impact !== 0) return impact;
      return isArabic ? a.nameAr.localeCompare(b.nameAr, "ar") : a.nameFr.localeCompare(b.nameFr, "fr");
    });

  const getSeverityBadge = (sev: string) => {
    switch (sev) {
      case "critical":
        return {
          bg: "bg-red-500/10 border-red-500/30 text-red-500",
          textAr: "كارثي",
          textFr: "Critique",
        };
      case "high":
        return {
          bg: "bg-orange-500/10 border-orange-500/30 text-orange-400",
          textAr: "مرتفع",
          textFr: "Élevé",
        };
      case "medium":
        return {
          bg: "bg-amber-500/10 border-amber-500/30 text-amber-500",
          textAr: "متوسط",
          textFr: "Moyen",
        };
      default:
        return {
          bg: "bg-emerald-500/10 border-emerald-500/30 text-emerald-500",
          textAr: "مستقر آمن",
          textFr: "Stable / Sûr",
        };
    }
  };

  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)]" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-red-600/20 text-red-500 rounded border border-red-500/20">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-100">
              {isArabic ? "حالة الولايات والمناطق في شمال إفريقيا" : "Statut des Wilayas et Régions (Afrique du Nord)"}
            </h3>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {isArabic ? "مستوى التأثر الفعلي وإجراءات الحماية الميدانية" : "Niveaux de menace et mesures d'urgence régionales"}
            </p>
          </div>
        </div>
      </div>

      <div className="px-1 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isArabic ? "ابحث عن ولاية أو منطقة..." : "Rechercher une wilaya ou région..."}
            className="w-full bg-zinc-950 border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none focus:border-amber-500/40"
          />
        </div>
      </div>

      <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
        {sortedWilayas.map((w) => {
          const badge = getSeverityBadge(w.severity);
          return (
            <div
              key={w.nameAr}
              className="bg-black/40 rounded-lg p-3.5 border border-white/5 hover:border-white/10 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-bold text-sm text-slate-100">
                    {isArabic ? w.nameAr : w.nameFr}
                  </h4>
                  <span className={`px-2 py-0.5 text-[10px] rounded-full border font-bold ${badge.bg}`}>
                    {isArabic ? badge.textAr : badge.textFr}
                  </span>
                </div>
                
                {/* Metric detail */}
                <div className="flex items-center gap-4 text-[11px] text-gray-400 font-medium">
                  <span className="flex items-center gap-1">
                    🔥 {isArabic ? "بلاغات:" : "Signalements :"} <strong className="text-slate-200 font-mono">{w.activeFires}</strong>
                  </span>
                  <span className="flex items-center gap-1">
                    🛰️ {isArabic ? "أقمار:" : "Satellites :"} <strong className="text-slate-200 font-mono">{w.satelliteHotspots}</strong>
                  </span>
                </div>
              </div>

              {/* Status Action area */}
              <div className="flex items-center gap-3 self-start md:self-auto">
                {w.evacuationRecommended ? (
                  <div className="bg-red-500/10 text-red-500 text-[10px] py-1 px-2.5 rounded font-bold border border-red-500/20 animate-pulse flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    <span>{isArabic ? "توجيهات إخلاء نشطة" : "Évacuation Recommandée"}</span>
                  </div>
                ) : (
                  <div className="bg-black/50 text-gray-400 text-[10px] py-1 px-2.5 rounded font-semibold border border-white/5 flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-emerald-500" />
                    <span>{isArabic ? "لا توجد أوامر إخلاء" : "Pas d'alerte d'évacuation"}</span>
                  </div>
                )}

                {/* Emergency Phone call action */}
                <a
                  href={`tel:${w.emergencyPhone}`}
                  title={isArabic ? "اتصال بخلية أزمة الولاية" : "Contacter la cellule de crise"}
                  className="p-2 bg-black/50 hover:bg-black/80 text-slate-300 hover:text-red-400 rounded-lg border border-white/5 hover:border-red-500/30 transition-all flex items-center justify-center gap-1 text-xs cursor-pointer"
                >
                  <Phone className="h-3.5 w-3.5" />
                  <span className="text-[10px] font-mono font-semibold">{w.emergencyPhone}</span>
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 bg-black/40 p-3 rounded-lg border border-white/5 flex items-start gap-2">
        <Info className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
        <p className="text-[10px] text-gray-500 leading-relaxed italic">
          {isArabic
            ? "⚠️ تنبيه: يتم تجميع بيانات ومؤشرات الأزمة بالتنسيق مع خلايا الرصد والحماية المدنية في دول شمال إفريقيا. في الحالات الطارئة اتصل فوراً بأرقام الإغاثة المحلية أو أرقام الطوارئ المعتمدة."
            : "⚠️ Info: Les données d'analyse sont consolidées en collaboration avec les centres de veille et la protection civile en Afrique du Nord. En cas d'urgence, contactez immédiatement les secours locaux."}
        </p>
      </div>
    </div>
  );
}
