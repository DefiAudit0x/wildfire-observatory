import { memo, useEffect, useRef, useState } from "react";
import { Flame, Clock, RefreshCw, Bell, X, CheckCircle, AlertTriangle, AlertCircle, Info, Wifi, WifiOff, Phone, Globe } from "lucide-react";

interface HeaderBarProps {
  isArabic: boolean;
  lang: string;
  notifications: any[];
  lastRefreshed: string;
  loading: boolean;
  meshStatus: "connecting" | "online" | "offline";
  meshNodeCount: number;
  onToggleLang: () => void;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
}

function HeaderBar({
  isArabic,
  lang,
  notifications,
  lastRefreshed,
  loading,
  meshStatus,
  meshNodeCount,
  onToggleLang,
  onRefresh,
  onMarkRead,
}: HeaderBarProps) {
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showNotifications) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showNotifications]);

  return (
    <header className="bg-black/60 backdrop-blur-md border-b border-white/5 sticky top-0 z-[1100] px-4 py-3 md:px-8">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Platform Title */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-gradient-to-tr from-red-600 via-orange-600 to-amber-500 rounded-xl flex items-center justify-center shadow-[0_4px_15px_rgba(220,38,38,0.3)] border border-red-500/20">
            <Flame className="h-6 w-6 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg md:text-xl text-slate-100 tracking-tight leading-none flex items-center gap-2">
              <span>{isArabic ? "المرصد الشمال الإفريقي لحرائق الغابات والكوارث" : "Observatoire Nord-Africain des Feux de Forêt et Catastrophes"}</span>
              <span className="bg-red-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider animate-pulse">
                {isArabic ? "مباشر" : "Live"}
              </span>
            </h1>
            <p className="text-[10px] text-gray-400 mt-1">
              {isArabic
                ? "منصة تضامنية لمتابعة الكوارث والتبليغ الميداني الفوري والتأصيل الجغرافي"
                : "Plateforme citoyenne de suivi cartographique et de signalement d'urgence"}
            </p>
          </div>
        </div>

        {/* Quick info and Bilingual selector */}
        <div className="flex items-center gap-4 flex-wrap justify-center">
          {/* Last refreshed status */}
          <div className="hidden md:flex items-center gap-1.5 text-xs text-gray-400 font-mono">
            <Clock className="h-3.5 w-3.5 text-gray-500" />
            <span>{isArabic ? "آخر تحديث:" : "Tendance :"} {lastRefreshed || "--:--:--"}</span>
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1 hover:bg-zinc-850 rounded transition-colors cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 text-gray-400 ${loading ? "animate-spin text-red-500" : ""}`} />
            </button>
          </div>

          {/* Notifications Bell */}
          <div className="relative" ref={notificationsRef}>
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors cursor-pointer border border-white/5"
              title="Notifications"
            >
              <Bell className="h-4 w-4 text-gray-300" />
              {notifications.some((n) => !n.read) && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 animate-pulse border border-black" />
              )}
            </button>

            {showNotifications && (
              <div className={`absolute top-full mt-2 w-72 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-[1200] overflow-hidden ${isArabic ? "left-0 md:left-auto md:right-0" : "right-0"}`}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-800/50">
                  <h3 className="font-bold text-sm text-slate-100">{isArabic ? "الإشعارات" : "Notifications"}</h3>
                  <button onClick={() => setShowNotifications(false)} className="text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="max-h-[300px] overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="p-6 text-center text-sm text-gray-400">
                      {isArabic ? "لا توجد إشعارات" : "Aucune notification"}
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {notifications.map((n) => (
                        <div
                          key={n.id}
                          onClick={() => !n.read && onMarkRead(n.id)}
                          className={`p-4 border-b border-white/5 last:border-0 cursor-pointer transition-colors ${n.read ? "bg-transparent opacity-60" : "bg-white/5 hover:bg-white/10"}`}
                        >
                          <div className="flex items-start gap-3">
                            <div className="shrink-0 mt-0.5">
                              {n.type === "success" && <CheckCircle className="h-4 w-4 text-emerald-500" />}
                              {n.type === "warning" && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                              {n.type === "error" && <AlertCircle className="h-4 w-4 text-red-500" />}
                              {n.type === "info" && <Info className="h-4 w-4 text-blue-500" />}
                            </div>
                            <div className="flex-1">
                              <h4 className={`text-xs font-bold ${!n.read ? "text-slate-100" : "text-gray-400"}`}>
                                {isArabic ? n.titleAr : n.titleFr}
                              </h4>
                              <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                                {isArabic ? n.bodyAr : n.bodyFr}
                              </p>
                              <div className="text-[9px] text-gray-500 mt-2">
                                {new Date(n.timestamp).toLocaleString(isArabic ? "ar-DZ" : "fr-DZ")}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Mesh network status badge */}
          <button
            onClick={onRefresh}
            title={isArabic ? "شبكة المرصد المترابطة (Mesh) — اضغط للتحديث" : "Réseau Mesh de l'observatoire — cliquer pour actualiser"}
            className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
              meshStatus === "online"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : meshStatus === "connecting"
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                  : "bg-zinc-900 border-white/10 text-gray-500"
            }`}
          >
            {meshStatus === "online" ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            <span>
              {isArabic ? "شبكة Mesh" : "Réseau Mesh"}
              {meshStatus === "online" && meshNodeCount > 0 ? `: ${meshNodeCount}` : ""}
            </span>
          </button>

          {/* Emergency Hotline summary button */}
          <a
            href="tel:1021"
            className="px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 hover:border-red-500/40 text-red-400 rounded-lg text-xs font-black flex items-center gap-1.5 transition-all"
          >
            <Phone className="h-3.5 w-3.5 text-red-500 shrink-0" />
            <span>{isArabic ? "الحماية المدنية: 1021" : "Protection Civile : 1021"}</span>
          </a>

          {/* Language Toggle */}
          <button
            onClick={onToggleLang}
            className="px-3 py-1.5 bg-black/40 hover:bg-zinc-900 text-xs text-slate-200 hover:text-white rounded-lg border border-white/5 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Globe className="h-3.5 w-3.5 text-gray-500" />
            <span className="font-bold">{lang === "ar" ? "Français" : "العربية"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

export default memo(HeaderBar);