import { Flame, ShieldAlert, Users, Radio } from "lucide-react";
import { Report, SatelliteHotspot } from "../types";

interface StatisticsPanelProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  lang: "ar" | "fr";
}

export default function StatisticsPanel({ reports, satellites, lang }: StatisticsPanelProps) {
  const isArabic = lang === "ar";

  const totalReports = reports.length;
  const verifiedReports = reports.filter((r) => r.status === "verified").length;
  const criticalReports = reports.filter((r) => r.severity === "critical").length;
  const totalSatellites = satellites.length;

  const verificationRate = totalReports > 0 ? Math.round((verifiedReports / totalReports) * 100) : 100;

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
      descAr: "مطابقة الصور والإحداثيات آلياً بالـ Gemini",
      descFr: "Rapports photo vérifiés par Gemini",
      icon: <Flame className="h-5 w-5 text-emerald-500" />,
      glowColor: "text-emerald-400",
      bg: "bg-emerald-950/10 border-emerald-500/20",
    },
    {
      id: "stat-4",
      titleAr: "ولايات الشرق الأكثر تهديداً",
      titleFr: "Wilayas de l'Est Menacées",
      value: isArabic ? "الطارف / سكيكدة" : "El Tarf / Skikda",
      descAr: "الحماية المدنية والجيش يجليان الأهالي",
      descFr: "Secours et évacuations en cours",
      icon: <ShieldAlert className="h-5 w-5 text-amber-500" />,
      glowColor: "text-amber-400",
      bg: "bg-zinc-900/40 border-white/5",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" dir={isArabic ? "rtl" : "ltr"}>
      {stats.map((st) => (
        <div
          key={st.id}
          className={`${st.bg} rounded-xl p-4 border shadow-[0_4px_20px_rgba(0,0,0,0.3)] transition-all hover:border-red-500/30 relative overflow-hidden group`}
        >
          {/* subtle decorative pulse on corner */}
          <div className="absolute top-0 right-0 w-12 h-12 bg-red-500/2 opacity-[0.02] group-hover:opacity-[0.08] transition-opacity rounded-bl-full"></div>

          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-gray-400 text-[10px] uppercase tracking-widest font-bold leading-tight">
                {isArabic ? st.titleAr : st.titleFr}
              </p>
              <h4 className={`text-xl md:text-2xl font-light font-mono leading-none mt-1.5 ${st.glowColor}`}>
                {st.value}
              </h4>
            </div>
            <div className="p-2 bg-black/40 rounded-lg border border-white/5 flex items-center justify-center">
              {st.icon}
            </div>
          </div>
          <p className="text-[10px] text-gray-500 mt-3 font-light italic leading-relaxed">
            {isArabic ? st.descAr : st.descFr}
          </p>
        </div>
      ))}
    </div>
  );
}
