import { Users } from "lucide-react";
import { UserLocationData } from "./StatCards";

interface ActiveUsersTableProps {
  isArabic: boolean;
  activeUsers: UserLocationData[];
}

export default function ActiveUsersTable({ isArabic, activeUsers }: ActiveUsersTableProps) {
  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-sky-400" />
        <span className="text-xs font-bold text-slate-300">
          {isArabic ? "المستخدمون النشطون" : "Utilisateurs actifs"}
          <span className="text-gray-500 font-normal ml-1">({activeUsers.length})</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="border-b border-white/5 text-gray-500">
              <th className="text-left px-4 py-2 font-bold">{isArabic ? "الاسم" : "Nom"}</th>
              <th className="text-left px-4 py-2 font-bold">{isArabic ? "الدور" : "Rôle"}</th>
              <th className="text-left px-4 py-2 font-bold">Lat</th>
              <th className="text-left px-4 py-2 font-bold">Lng</th>
              <th className="text-left px-4 py-2 font-bold">{isArabic ? "آخر ظهور" : "Dernière vue"}</th>
            </tr>
          </thead>
          <tbody>
            {activeUsers.map((u) => (
              <tr key={u.deviceId} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-2 text-slate-200 font-bold">{u.name}</td>
                <td className="px-4 py-2">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    u.role === "official" ? "bg-amber-500/10 text-amber-400" :
                    u.role === "volunteer" ? "bg-emerald-500/10 text-emerald-400" :
                    "bg-slate-500/10 text-slate-400"
                  }`}>
                    {u.role === "official" ? (isArabic ? "رسمي" : "Officiel") :
                     u.role === "volunteer" ? (isArabic ? "متطوع" : "Bénévole") :
                     (isArabic ? "مواطن" : "Citoyen")}
                  </span>
                </td>
                <td className="px-4 py-2 text-gray-400">{u.lat.toFixed(4)}</td>
                <td className="px-4 py-2 text-gray-400">{u.lng.toFixed(4)}</td>
                <td className="px-4 py-2 text-gray-400">{new Date(u.lastSeen).toLocaleTimeString()}</td>
              </tr>
            ))}
            {activeUsers.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-xs text-gray-600">
                  {isArabic ? "لا يوجد مستخدمون نشطون حالياً" : "Aucun utilisateur actif pour le moment"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
