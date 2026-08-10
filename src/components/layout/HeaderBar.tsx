import { memo, useEffect, useRef, useState } from "react";
import { Flame, Clock, RefreshCw, Bell, X, CheckCircle, AlertTriangle, AlertCircle, Info, Wifi, WifiOff, Phone, Globe } from "lucide-react";
import { EMERGENCY_CONTACTS } from "../../utils/emergency";

interface HeaderBarProps {
  isArabic: boolean;
  lang: string;
  notifications: any[];
  lastRefreshed: number;
  lastFetchFailed: boolean;
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
  lastFetchFailed,
  loading,
  meshStatus,
  meshNodeCount,
  onToggleLang,
  onRefresh,
  onMarkRead,
}: HeaderBarProps) {
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const [showEmergencies, setShowEmergencies] = useState(false);
  const emergenciesRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Publish the actual header height as a CSS variable so sticky siblings
  // (TabBar) can offset themselves below it on every screen size.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty("--header-height", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Re-evaluate freshness every 30s without re-rendering the whole header on
  // a timer — only the badge/last-updated label depends on `nowTick`.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // `lastRefreshed` is a real epoch timestamp (ms) set when any dataset last
  // succeeded. Three honest states: live (fresh + reachable), stale (data too
  // old despite a working backend), offline (last poll actually failed).
  const STALE_AFTER_MS = 3 * 60_000;
  let refreshAgeMs: number | null = null;
  if (lastRefreshed > 0) {
    refreshAgeMs = nowTick - lastRefreshed;
  }
  const neverSynced = lastRefreshed === 0 && !loading;
  const isOffline = lastFetchFailed && (refreshAgeMs === null || refreshAgeMs > STALE_AFTER_MS);
  const isStale = !loading && !isOffline && !neverSynced && refreshAgeMs !== null
    ? refreshAgeMs < -60_000 || refreshAgeMs > STALE_AFTER_MS
    : false;

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

  useEffect(() => {
    if (!showEmergencies) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (emergenciesRef.current && !emergenciesRef.current.contains(e.target as Node)) {
        setShowEmergencies(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showEmergencies]);

  return (
    <header ref={headerRef} className="bg-black/60 backdrop-blur-md border-b border-white/5 sticky top-0 z-[1100] px-4 py-3 md:px-8">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Platform Title */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-gradient-to-tr from-red-600 via-orange-600 to-amber-500 rounded-xl flex items-center justify-center shadow-[0_4px_15px_rgba(220,38,38,0.3)] border border-red-500/20">
            <Flame className="h-6 w-6 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg md:text-xl text-slate-100 tracking-tight leading-none flex items-center gap-2">
              <span>{isArabic ? "المرصد الشمال الإفريقي لحرائق الغابات والكوارث" : "Observatoire Nord-Africain des Feux de Forêt et Catastrophes"}</span>
              <span
                title={neverSynced
                  ? (isArabic ? "بانتظار أول مزامنة مع الخادم" : "En attente de la première synchronisation")
                  : isOffline
                    ? (isArabic ? "تعذر الوصول إلى خادم المرصد في آخر محاولة" : "Serveur de l'observatoire inaccessible lors du dernier essai")
                    : isStale
                      ? (isArabic ? "آخر تحديث تجاوز حد الحداثة (3 دقائق)" : "Dernière actualisation trop ancienne (3 min)")
                      : (isArabic ? "متصلة ومحدثة بخادم المرصد" : "Connecté et à jour avec le serveur")}
                className={`text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${
                  neverSynced
                    ? "bg-zinc-800 text-gray-400 border border-white/10"
                    : isOffline
                      ? "bg-red-500/15 text-red-400 border border-red-500/40"
                      : isStale
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : "bg-red-600 text-white animate-pulse"
                }`}
              >
                {neverSynced
                  ? (isArabic ? "مزامنة..." : "Sync...")
                  : isOffline
                    ? (isArabic ? "غير متصل" : "Hors ligne")
                    : isStale
                      ? (isArabic ? "بيانات قديمة" : "Données anciennes")
                      : (isArabic ? "مباشر" : "Live")}
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
          <div className="flex items-center gap-1.5 text-xs text-gray-400 font-mono">
            <Clock className="h-3.5 w-3.5 text-gray-500" />
            <span>{isArabic ? "آخر تحديث:" : "Dernière mise à jour :"} {lastRefreshed > 0 ? new Date(lastRefreshed).toLocaleTimeString(isArabic ? "ar-DZ" : "fr-DZ") : "--:--:--"}</span>
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1 hover:bg-zinc-850 rounded transition-colors cursor-pointer"
              title={isArabic ? "تحديث البيانات الآن" : "Actualiser les données"}
            >
              <RefreshCw className={`h-3 w-3 text-gray-400 ${loading ? "animate-spin text-red-500" : ""}`} />
            </button>
          </div>

          {/* Notifications Bell */}
          <div className="relative" ref={notificationsRef}>
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors cursor-pointer border border-white/5"
              title={isArabic ? "الإشعارات" : "Notifications"}
              aria-expanded={showNotifications}
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
            title={isArabic
              ? "شبكة المرصد المترابطة (Mesh) — عقد خادم الوكيل عبر WebSocket، اضغط للتحديث"
              : "Réseau Mesh de l'observatoire — nœuds du serveur de relais via WebSocket, cliquer pour actualiser"}
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
              {isArabic ? "Mesh: الخادم" : "Mesh serveur"}
              {meshStatus === "online" && meshNodeCount > 0 ? `: ${meshNodeCount}` : ""}
            </span>
          </button>

          {/* Emergency hotlines: official numbers per country, never a single hidden assumption */}
          <div className="relative" ref={emergenciesRef}>
            <button
              onClick={() => setShowEmergencies(!showEmergencies)}
              aria-expanded={showEmergencies}
              title={isArabic ? "أرقام الطوارئ الرسمية حسب البلد" : "Numéros d'urgence officiels par pays"}
              className="px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 hover:border-red-500/40 text-red-400 rounded-lg text-xs font-black flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Phone className="h-3.5 w-3.5 text-red-500 shrink-0" />
              <span>{isArabic ? "أرقام الطوارئ" : "Urgences"}</span>
            </button>

            {showEmergencies && (
              <div className={`absolute top-full mt-2 w-64 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-[1200] overflow-hidden ${isArabic ? "left-0 md:left-auto md:right-0" : "right-0"}`}>
                <div className="px-4 py-3 border-b border-white/10 bg-zinc-800/50">
                  <h3 className="font-bold text-sm text-slate-100">
                    {isArabic ? "أرقام الطوارئ الرسمية — شمال إفريقيا" : "Numéros d'urgence — Afrique du Nord"}
                  </h3>
                </div>
                <div className="max-h-[300px] overflow-y-auto">
                  {EMERGENCY_CONTACTS.map((c) => (
                    <a
                      key={`${c.countryFr}-${c.phone}`}
                      href={`tel:${c.phone}`}
                      className="flex items-center justify-between p-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
                    >
                      <div>
                        <p className="text-xs font-bold text-slate-100">
                          {isArabic ? c.labelAr : c.labelFr} — {isArabic ? c.countryAr : c.countryFr}
                        </p>
                        <p className="text-[10px] text-gray-400">{isArabic ? c.noteAr : c.noteFr}</p>
                      </div>
                      <span className="text-sm font-black font-mono px-2.5 py-1 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400">{c.phone}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

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