import { Radio, AlertTriangle, Shield, Users } from "lucide-react";
import { Report, SatelliteHotspot, TrappedSOS } from "../../types";

export interface UserLocationData {
  deviceId: string;
  lat: number;
  lng: number;
  name: string;
  role: string;
  lastSeen: string;
}

interface StatCardsProps {
  isArabic: boolean;
  reports: Report[];
  satellites: SatelliteHotspot[];
  sosCalls: TrappedSOS[];
  activeUsers: UserLocationData[];
}

export default function StatCards({ isArabic, reports, satellites, sosCalls, activeUsers }: StatCardsProps) {
  const totalFires = reports.filter(r => r.status !== "resolved").length;
  const criticalFires = reports.filter(r => r.status === "pending" && r.severity === "critical").length;
  const verifiedReports = reports.filter(r => r.status === "verified").length;
  const totalVolunteers = activeUsers.filter(u => u.role === "volunteer").length;
  const totalOfficials = activeUsers.filter(u => u.role === "official").length;
  const satelliteHotspots = satellites.length;
  const activeSosCount = sosCalls.filter(s => s.status === "active").length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {/* SOS Alerts Card */}
      <div className={`border rounded-xl p-3 md:p-4 transition-all duration-300 ${
        activeSosCount > 0
          ? "bg-red-950/40 border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.25)] animate-pulse col-span-2 md:col-span-1"
          : "bg-zinc-900/60 border-white/5 col-span-2 md:col-span-1"
      }`}>
        <div className="flex items-center gap-2 text-red-500 mb-1">
          <Radio className={`h-4 w-4 ${activeSosCount > 0 ? "text-red-500 animate-spin font-black" : "text-gray-500"}`} />
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-red-400">
            {isArabic ? "استغاثات SOS" : "SOS Actifs"}
          </span>
        </div>
        <p className={`text-2xl font-black ${activeSosCount > 0 ? "text-red-500 font-extrabold" : "text-slate-100"}`}>
          {activeSosCount}
        </p>
        <p className="text-[10px] text-gray-500 mt-1">
          {isArabic ? "نداءات محاصرين جارية" : "Appels citoyens piégés"}
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
        <div className="flex items-center gap-2 text-red-400 mb-1">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {isArabic ? "حرائق نشطة" : "Feux actifs"}
          </span>
        </div>
        <p className="text-2xl font-black text-slate-100">{totalFires}</p>
        <p className="text-[10px] text-red-400/80 mt-1">
          {criticalFires > 0 ? `${criticalFires} ${isArabic ? "حرجة" : "critiques"}` : ""}
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
        <div className="flex items-center gap-2 text-emerald-400 mb-1">
          <Shield className="h-4 w-4" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {isArabic ? "مؤكدة" : "Vérifiés"}
          </span>
        </div>
        <p className="text-2xl font-black text-slate-100">{verifiedReports}</p>
        <p className="text-[10px] text-emerald-400/80 mt-1">
          {reports.length > 0 ? `${((verifiedReports / reports.length) * 100).toFixed(0)}% ${isArabic ? "من المجموع" : "du total"}` : ""}
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
        <div className="flex items-center gap-2 text-amber-400 mb-1">
          <Radio className="h-4 w-4" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {isArabic ? "أقمار صناعية" : "Satellites"}
          </span>
        </div>
        <p className="text-2xl font-black text-slate-100">{satelliteHotspots}</p>
        <p className="text-[10px] text-amber-400/80 mt-1">
          {isArabic ? "بؤرة رصدتها ناسا" : "Hotspots NASA FIRMS"}
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
        <div className="flex items-center gap-2 text-sky-400 mb-1">
          <Users className="h-4 w-4" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {isArabic ? "متصل الآن" : "En ligne"}
          </span>
        </div>
        <p className="text-2xl font-black text-slate-100">{activeUsers.length}</p>
        <p className="text-[10px] text-sky-400/80 mt-1">
          {totalVolunteers > 0 ? `${totalVolunteers} ${isArabic ? "متطوع" : "bénévoles"}` : ""}
          {totalVolunteers > 0 && totalOfficials > 0 ? " | " : ""}
          {totalOfficials > 0 ? `${totalOfficials} ${isArabic ? "رسمي" : "officiels"}` : ""}
        </p>
      </div>
    </div>
  );
}
