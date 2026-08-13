import { memo } from "react";
import { ShieldAlert, Layers, Compass, AlertCircle, BadgeCheck, Sparkles, BookOpen, Navigation, Crown, Shield, ClipboardList } from "lucide-react";
import { TabId } from "../../types";

interface TabBarProps {
  isArabic: boolean;
  activeTab: TabId;
  privilegedTabVisible: boolean;
  rosterVisible: boolean;
  onSelectTab: (tab: TabId) => void;
}

function TabBar({ isArabic, activeTab, privilegedTabVisible, rosterVisible, onSelectTab }: TabBarProps) {
  const tabs = [
    { id: "home" as TabId, labelAr: "بوابة الطوارئ السريعة", labelFr: "Accueil d'Urgence", icon: <ShieldAlert className="h-4 w-4 text-red-500 animate-pulse" /> },
    { id: "map" as TabId, labelAr: "المرصد والخريطة", labelFr: "Observatoire & Carte", icon: <Layers className="h-4 w-4" /> },
    { id: "radar" as TabId, labelAr: "رادار الإخلاء والرياح", labelFr: "Radar d'Évacuation", icon: <Compass className="h-4 w-4 text-emerald-400" /> },
    { id: "report" as TabId, labelAr: "إرسال بلاغ حريق", labelFr: "Signaler un incendie", icon: <AlertCircle className="h-4 w-4 text-red-400" /> },
    { id: "volunteer" as TabId, labelAr: "تسجيل متطوع", labelFr: "Devenir Volontaire", icon: <BadgeCheck className="h-4 w-4 text-emerald-400" /> },
    { id: "copilot" as TabId, labelAr: "مساعد الذكاء الاصطناعي", labelFr: "Assistant Gemini IA", icon: <Sparkles className="h-4 w-4 text-purple-400" /> },
    { id: "guides" as TabId, labelAr: "دليل النجاة والوقاية", labelFr: "Guides de Survie", icon: <BookOpen className="h-4 w-4 text-sky-400" /> },
    { id: "evac" as TabId, labelAr: "مسارات الإخلاء", labelFr: "Évacuation", icon: <Navigation className="h-4 w-4 text-sky-400" /> },
    ...(privilegedTabVisible
      ? [
          { id: "command" as TabId, labelAr: "قيادة مركزية", labelFr: "Commandement Central", icon: <Crown className="h-4 w-4 text-amber-400 animate-pulse" /> },
          { id: "admin" as TabId, labelAr: "لوحة تحكم المشرف", labelFr: "Espace Admin", icon: <Shield className="h-4 w-4 text-emerald-400 animate-pulse" /> },
        ]
      : []),
    ...(rosterVisible
      ? [
          { id: "roster" as TabId, labelAr: "جدول المناوبة", labelFr: "Tableau de Garde", icon: <ClipboardList className="h-4 w-4 text-sky-400" /> },
        ]
      : []),
  ];

  return (
    <div className="px-4 py-2 flex gap-1.5 bg-black/80 border-b border-white/5 overflow-x-auto sticky z-[1000] justify-start md:justify-center" style={{ top: "var(--header-height, 65px)" }} dir={isArabic ? "rtl" : "ltr"}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelectTab(tab.id)}
          className={`flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-xs font-black transition-all whitespace-nowrap cursor-pointer ${
            activeTab === tab.id
              ? "bg-red-650 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)] scale-[1.02]"
              : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
          }`}
        >
          {tab.icon}
          <span>{isArabic ? tab.labelAr : tab.labelFr}</span>
        </button>
      ))}
      {!privilegedTabVisible && (
        <button
          onClick={() => onSelectTab("admin")}
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-black whitespace-nowrap cursor-pointer text-slate-500 hover:text-slate-300 hover:bg-white/5"
          title={isArabic ? "تسجيل دخول المشرفين" : "Connexion administrateur"}
        >
          <Shield className="h-4 w-4" />
          <span>{isArabic ? "دخول المشرف" : "Admin login"}</span>
        </button>
      )}
    </div>
  );
}

export default memo(TabBar);