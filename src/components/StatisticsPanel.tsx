import { useEffect, useMemo, useState } from "react";
import { Download, Flame, ShieldAlert, Users, Radio, Gauge, History } from "lucide-react";
import { Report, SatelliteHotspot, WilayaStatus } from "../types";
import { computeFireRisk, RiskLevel } from "../utils/fireRisk";
import { reportsToCsv, hotspotsToGeoJson } from "../utils/export";

interface HistoryBucket {
  date: string;
  reports: number;
  verified: number;
  sos: number;
  hotspots: number;
}

interface StatisticsPanelProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  wilayas: WilayaStatus[];
  lang: "ar" | "fr";
}

const RISK_STYLES: Record<RiskLevel, { bar: string; text: string; labelAr: string; labelFr: string }> = {
  low: { bar: "bg-emerald-500", text: "text-emerald-400", labelAr: "منخفض", labelFr: "Faible" },
  moderate: { bar: "bg-amber-500", text: "text-amber-400", labelAr: "متوسط", labelFr: "Modéré" },
  high: { bar: "bg-orange-500", text: "text-orange-400", labelAr: "مرتفع", labelFr: "Élevé" },
  extreme: { bar: "bg-red-600", text: "text-red-500", labelAr: "قصوى", labelFr: "Extrême" },
};

export default function StatisticsPanel({ reports, satellites, wilayas, lang }: StatisticsPanelProps) {
  const isArabic = lang === "ar";

  // One denominator for the card: the active subset (pending + verified).
  // The "of which critical" note must be a subset of the value shown above
  // it — counting critical across resolved/rejected too produced ratios
  // that were mathematically impossible (ARC-M24).
  const activeReports = reports.filter((r) => r.status === "pending" || r.status === "verified");
  const totalReports = activeReports.length;
  const verifiedReports = reports.filter((r) => r.status === "verified").length;
  const criticalReports = activeReports.filter((r) => r.severity === "critical").length;
  const totalSatellites = satellites.length;

  // Shared, honest rate: verified over every report the system received,
  // not only the currently active subset — otherwise it reads inflated.
  const verificationRate = reports.length > 0 ? Math.round((verifiedReports / reports.length) * 100) : 0;

  const risk = useMemo(() => computeFireRisk(reports, satellites, wilayas), [reports, satellites, wilayas]);

  const [history, setHistory] = useState<HistoryBucket[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/history?days=30")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.buckets) setHistory(data.buckets);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const historyMax = Math.max(1, ...(history?.map((b) => b.reports + b.sos + b.hotspots) || [1]));

  // Most threatened wilayas, computed live from the wilaya status API
  const mostThreatenedWilayas = useMemo(() => {
    if (!wilayas || wilayas.length === 0) return [];
    const severityPriority: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return [...wilayas]
      .filter((w) => w.severity !== "safe")
      .sort((a, b) => {
        if (a.evacuationRecommended !== b.evacuationRecommended) return b.evacuationRecommended ? 1 : -1;
        const sev = severityPriority[b.severity] - severityPriority[a.severity];
        if (sev !== 0) return sev;
        const fires = b.activeFires - a.activeFires;
        if (fires !== 0) return fires;
        return b.satelliteHotspots - a.satelliteHotspots;
      })
      .slice(0, 2);
  }, [wilayas]);

  const cleanName = (name: string) => name.split(" - ").pop() || name;
  const threatenedWilayasText =
    mostThreatenedWilayas.length > 0
      ? mostThreatenedWilayas.map((w) => (isArabic ? cleanName(w.nameAr) : cleanName(w.nameFr))).join(" / ")
      : isArabic
        ? "لا توجد ولايات مهددة"
        : "Aucune wilaya menacée";
  const threatenedWilayasDesc =
    mostThreatenedWilayas.length > 0
      ? mostThreatenedWilayas.some((w) => w.evacuationRecommended)
        ? (isArabic ? "إجراءات إخلاء نشطة في هذه المناطق" : "Évacuations en cours dans ces zones")
        : (isArabic ? "مراقبة مكثفة وفرق تدخل جاهزة" : "Surveillance intensive, équipes en alerte")
      : (isArabic ? "جميع المناطق تحت السيطرة" : "Toutes les zones sous contrôle");

  const stats = [
    {
      id: "stat-1",
      titleAr: "بؤر الحرائق النشطة (أقمار)",
      titleFr: "Foyers Thermiques Satellites",
      value: totalSatellites,
      descAr: "رصد فوري عبر قمر ناسا VIIRS/MODIS",
      descFr: "Détections NASA FIRMS",
      icon: <Radio className="h-5 w-5 text-red-500 animate-pulse" />,
      glowColor: "text-red-500",
      bg: "bg-red-950/10 border-red-500/20",
    },
    {
      id: "stat-2",
      titleAr: "بلاغات المواطنين الميدانية",
      titleFr: "Signalements Citoyens Actifs",
      value: totalReports,
      descAr: `منها ${criticalReports} بلاغات بمستوى خطر كارثي`,
      descFr: `Dont ${criticalReports} alertes critiques`,
      icon: <Users className="h-5 w-5 text-orange-500" />,
      glowColor: "text-orange-400",
      bg: "bg-orange-950/10 border-orange-500/20",
    },
    {
      id: "stat-3",
      titleAr: "معدل المصادقة الفورية للذكاء الاصطناعي",
      titleFr: "Taux de Validation par l'IA",
      value: `${verificationRate}%`,
      descAr: "من إجمالي بلاغات النظام (النشطة والمحلولة)",
      descFr: "Sur tous les signalements (actifs et traités)",
      icon: <Flame className="h-5 w-5 text-emerald-500" />,
      glowColor: "text-emerald-400",
      bg: "bg-emerald-950/10 border-emerald-500/20",
    },
    {
      id: "stat-4",
      titleAr: "الولايات الأكثر تهديداً",
      titleFr: "Wilayas les Plus Menacées",
      value: threatenedWilayasText,
      descAr: threatenedWilayasDesc,
      descFr: threatenedWilayasDesc,
      icon: <ShieldAlert className="h-5 w-5 text-amber-500" />,
      glowColor: "text-amber-400",
      bg: mostThreatenedWilayas.length > 0
        ? "bg-zinc-900/40 border-amber-500/20"
        : "bg-emerald-950/10 border-emerald-500/20",
    },
  ];

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob(["\ufeff" + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const riskStyle = RISK_STYLES[risk.level];
  const topWilaya = risk.topWilayaNameAr ? cleanName(risk.topWilayaNameAr) : null;
  const topWilayaFr = risk.topWilayaNameFr ? cleanName(risk.topWilayaNameFr) : null;

  return (
    <div className="space-y-4">
      {/* Mobile-first columns: a forced 2-track grid on a 360dp phone squeezed
          each card to ~124px, wrapping Arabic titles one word per line (the
          "vertical strip" field report). Base 1 column, up from sm. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" dir={isArabic ? "rtl" : "ltr"}>
        {stats.map((st) => (
          <div
            key={st.id}
            className={`${st.bg} rounded-xl p-4 border shadow-[0_4px_20px_rgba(0,0,0,0.3)] transition-all hover:border-red-500/30 relative overflow-hidden group`}
          >
            <div className="absolute top-0 right-0 w-12 h-12 bg-red-500/2 opacity-[0.02] group-hover:opacity-[0.08] transition-opacity rounded-bl-full"></div>

            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-gray-400 text-[10px] uppercase tracking-widest font-bold leading-tight">
                  {isArabic ? st.titleAr : st.titleFr}
                </p>
                <h4 className={`text-xl md:text-2xl font-light font-mono leading-none mt-1.5 ${st.glowColor}`}>
                  {st.value}
                </h4>
              </div>
              <div className="shrink-0 p-2 bg-black/40 rounded-lg border border-white/5 flex items-center justify-center">
                {st.icon}
              </div>
            </div>
            <p className="text-[10px] text-gray-500 mt-3 font-light italic leading-relaxed">
              {isArabic ? st.descAr : st.descFr}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" dir={isArabic ? "rtl" : "ltr"}>
        <div className="rounded-xl p-4 border bg-zinc-900/40 border-red-500/20 shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-[10px] uppercase tracking-widest font-bold">
              {isArabic ? "مؤشر الخطر الحالي" : "Indice de Risque Actuel"}
            </p>
            <Gauge className="h-4 w-4 text-red-500" />
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className={`text-3xl font-light font-mono ${riskStyle.text}`}>{risk.score}</span>
            <span className="text-xs text-gray-400 pb-1">/ 100</span>
            <span className={`ml-auto text-xs font-bold px-2 py-1 rounded-md ${riskStyle.bar} bg-opacity-20 border border-white/10 ${riskStyle.text}`}>
              {isArabic ? riskStyle.labelAr : riskStyle.labelFr}
            </span>
          </div>
          <div className="mt-2 h-2 w-full rounded-full bg-black/50 overflow-hidden">
            <div
              className={`h-full rounded-full ${riskStyle.bar} transition-all duration-700`}
              style={{ width: `${risk.score}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 mt-2 font-light">
            {isArabic
              ? `${risk.activeFires} حريق نشط · ${risk.liveHotspots} بقعة حرارية مباشرة` +
                (topWilaya ? ` · أشد ولاية: ${topWilaya}` : "")
              : `${risk.activeFires} foyers actifs · ${risk.liveHotspots} détections directes` +
                (topWilayaFr ? ` · Risque max: ${topWilayaFr}` : "")}
          </p>
        </div>

        <div className="md:col-span-2 rounded-xl p-4 border bg-zinc-900/40 border-amber-500/20 shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
          <div className="flex items-center justify-between mb-3">
            <p className="text-gray-400 text-[10px] uppercase tracking-widest font-bold flex items-center gap-2">
              <History className="h-4 w-4 text-amber-500" />
              {isArabic ? "نشاط آخر 30 يوماً (بلاغات + نداءات + أقمار)" : "Activité 30 derniers jours"}
            </p>
            <span className="text-[10px] text-gray-500">{isArabic ? "اليوم في أقصى اليسار" : "Aujourd'hui à gauche"}</span>
          </div>
          <div className="flex items-end gap-[3px] h-16" dir="ltr">
            {(history || []).map((bucket) => {
              const total = bucket.reports + bucket.sos + bucket.hotspots;
              const height = Math.max(2, Math.round((total / historyMax) * 100));
              return (
                <div
                  key={bucket.date}
                  title={`${bucket.date} — بلاغات: ${bucket.reports} · نداءات: ${bucket.sos} · أقمار: ${bucket.hotspots}`}
                  className="flex-1 rounded-t bg-red-500/50 hover:bg-red-500 transition-colors"
                  style={{ height: `${height}%` }}
                />
              );
            })}
          </div>
          <p className="text-[10px] text-gray-500 mt-2 font-light">
            {isArabic
              ? "حسب تواريخ البلاغات والنداءات والبقع الحرارية المستقبلة من المزودين."
              : "Selon les dates des signalements, SOS et détections reçues."}
          </p>
        </div>
      </div>

      {/* flex-wrap: without it the two export buttons shrank to min-content
          width on narrow screens and wrapped word-per-line. */}
      <div className="flex flex-wrap items-center gap-3" dir={isArabic ? "rtl" : "ltr"}>
        <button
          type="button"
          onClick={() => downloadFile(reportsToCsv(reports), `reports_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8")}
          disabled={reports.length === 0}
          className="inline-flex items-center gap-2 text-xs font-bold px-3 py-2 rounded-lg border border-white/10 bg-black/40 hover:border-emerald-500/40 text-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          {isArabic ? "تصدير CSV (البلاغات)" : "Exporter CSV"}
        </button>
        <button
          type="button"
          onClick={() => downloadFile(hotspotsToGeoJson(reports, satellites), `hotspots_${new Date().toISOString().slice(0, 10)}.geojson`, "application/geo+json")}
          disabled={reports.length === 0 && satellites.length === 0}
          className="inline-flex items-center gap-2 text-xs font-bold px-3 py-2 rounded-lg border border-white/10 bg-black/40 hover:border-sky-500/40 text-sky-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          {isArabic ? "تصدير GeoJSON (خرائط GIS)" : "Exporter GeoJSON"}
        </button>
        <span className="hidden sm:inline text-[10px] text-gray-500 font-light">
          {isArabic ? "بيانات حية كما تعرضها المنصة — متاحة للجميع" : "Données en direct, ouvertes à tous"}
        </span>
      </div>
    </div>
  );
}