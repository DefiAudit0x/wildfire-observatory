import { useState } from "react";
import { Users, Search } from "lucide-react";
import { UserLocationData } from "./StatCards";

interface ActiveUsersTableProps {
  isArabic: boolean;
  activeUsers: UserLocationData[];
}

export default function ActiveUsersTable({ isArabic, activeUsers }: ActiveUsersTableProps) {
  const [search, setSearch] = useState("");

  const filtered = activeUsers.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      u.name.toLowerCase().includes(q) ||
      u.role.toLowerCase().includes(q) ||
      u.deviceId.toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-sky-400" />
        <span className="text-xs font-bold text-slate-300">
          {isArabic ? "المستخدمون النشطون" : "Utilisateurs actifs"}
          <span className="text-gray-500 font-normal ml-1">({activeUsers.length})</span>
        </span>
      </div>
      <div className="px-4 py-2 border-b border-white/5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isArabic ? "ابحث بالاسم، الدور، أو ID..." : "Rechercher par nom, rôle, ID..."}
            className="w-full bg-zinc-950 border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none focus:border-sky-500/40"
          />
        </div>
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
            {filtered.map((u) => (
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
            {filtered.length === 0 && activeUsers.length > 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-xs text-gray-600">
                  {isArabic ? "لا نتائج مطابقة للبحث" : "Aucun résultat pour cette recherche"}
                </td>
              </tr>
            )}
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
