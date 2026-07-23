import { useState } from "react";
import { 
  ShieldAlert, 
  Flame, 
  MapPin, 
  Radio, 
  Compass, 
  BookOpen, 
  Phone, 
  HeartHandshake, 
  AlertTriangle,
  Navigation,
  Sparkles,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  WifiOff,
  Crown,
  Layers,
  Shield
} from "lucide-react";
import { Language } from "../types";

interface HomeHubProps {
  onNavigate: (tab: "home" | "map" | "report" | "copilot" | "guides" | "radar" | "ops" | "admin" | "volunteer" | "command" | "mesh" | "radio" | "evac") => void;
  onTriggerSOS: () => void;
  lang: Language;
  reportsCount: number;
  sosCount: number;
}

export default function HomeHub({ onNavigate, onTriggerSOS, lang, reportsCount, sosCount }: HomeHubProps) {
  const isArabic = lang === "ar";
  const [showAllServices, setShowAllServices] = useState(false);

  const secondaryServices = [
    {
      id: "map" as const,
      titleAr: "المرصد والخريطة التفاعلية المباشرة",
      titleFr: "Carte Interactive & Observatoire",
      descAr: "تصفح بؤر الحرائق النشطة والأقمار الصناعية والبلاغات الميدانية الحية",
      descFr: "Visualisez les foyers actifs, données satellites et rapports en direct",
      color: "border-sky-500/20 hover:border-sky-500/40 text-sky-400 bg-sky-950/20",
      icon: <MapPin className="h-6 w-6 text-sky-400" />
    },
    {
      id: "evac" as const,
      titleAr: "مسارات الإخلاء الآمنة الطرقات",
      titleFr: "Itinéraires d'Évacuation Sûrs",
      descAr: "اعرف الطرق والمسارات الآمنة المفتوحة البعيدة عن محاصرة النيران",
      descFr: "Découvrez les routes de secours ouvertes et zones sécurisées",
      color: "border-amber-500/20 hover:border-amber-500/40 text-amber-400 bg-amber-950/20",
      icon: <Navigation className="h-6 w-6 text-amber-500" />
    },
    {
      id: "radio" as const,
      titleAr: "الراديو والجهاز اللاسلكي الرقمي",
      titleFr: "Radio & Talkie-Walkie Mobile",
      descAr: "تواصل صوتياً عبر موجات الطوارئ الافتراضية الميدانية",
      descFr: "Communiquez vocalement via les ondes d'urgence virtuelles",
      color: "border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 bg-emerald-950/20",
      icon: <Radio className="h-6 w-6 text-emerald-500 animate-pulse" />
    },
    {
      id: "volunteer" as const,
      titleAr: "التسجيل كممتوع وإعانة المتضررين",
      titleFr: "Devenir Volontaire & Solidarité",
      descAr: "تسجيل المتطوعين وتقديم المساعدات والأدوية والمؤن للجمعيات",
      descFr: "S'inscrire pour prêter main forte et faire des dons de matériel",
      color: "border-teal-500/20 hover:border-teal-500/40 text-teal-400 bg-teal-950/20",
      icon: <HeartHandshake className="h-6 w-6 text-teal-400" />
    },
    {
      id: "guides" as const,
      titleAr: "دليل الإسعافات وتوجيهات النجاة",
      titleFr: "Guides de Survie & Secourisme",
      descAr: "كيف تتصرف إذا حاصرتك النيران أو واجهت دخاناً كثيفاً؟",
      descFr: "Que faire en cas d'encerclement par le feu ou fumées ?",
      color: "border-purple-500/20 hover:border-purple-500/40 text-purple-400 bg-purple-950/20",
      icon: <BookOpen className="h-6 w-6 text-purple-400" />
    },
    {
      id: "copilot" as const,
      titleAr: "مساعد الطوارئ بالذكاء الاصطناعي",
      titleFr: "Assistant Gemini IA Urgence",
      descAr: "توجيهات ذكية فورية مخصصة لحالتك الجغرافية ومحيطك",
      descFr: "Conseils immédiats basés sur votre position géographique",
      color: "border-fuchsia-500/20 hover:border-fuchsia-500/40 text-fuchsia-400 bg-fuchsia-950/20",
      icon: <Sparkles className="h-6 w-6 text-fuchsia-400" />
    },
    {
      id: "command" as const,
      titleAr: "غرفة القيادة المركزية وتتبع الفرق",
      titleFr: "Commandement Central & Suivi",
      descAr: "رصد وتتبع الفرق الميدانية وتنسيق عمليات الإجلاء الوطنية",
      descFr: "Suivi des équipes de terrain et coordination des secours",
      color: "border-amber-500/20 hover:border-amber-500/40 text-amber-300 bg-amber-950/20",
      icon: <Crown className="h-6 w-6 text-amber-400 animate-pulse" />
    },
    {
      id: "admin" as const,
      titleAr: "لوحة تحكم المشرف والأرشيف",
      titleFr: "Espace Admin & Archives",
      descAr: "إدارة البلاغات ومراجعة أجهزة الاستغاثة وأرشيف الحوادث",
      descFr: "Gestion des signalements, SOS et registre d'archives",
      color: "border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 bg-emerald-950/20",
      icon: <Shield className="h-6 w-6 text-emerald-400" />
    }
  ];

  return (
    <div className="w-full space-y-6 animate-fadeIn max-w-4xl mx-auto px-2" dir={isArabic ? "rtl" : "ltr"}>
      
      {/* Reassurance Header */}
      <div className="relative overflow-hidden bg-zinc-900/60 border border-white/5 rounded-2xl p-5 md:p-6 text-center space-y-3 shadow-xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 h-32 w-32 bg-red-600/10 rounded-full blur-3xl"></div>
        
        <h2 className="text-xl md:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-slate-100 via-slate-200 to-gray-400 tracking-tight leading-normal">
          {isArabic 
            ? "بوابة الطوارئ والاستجابة السريعة للكوارث" 
            : "Portail d'Urgence et de Secours Rapide"}
        </h2>
        <p className="text-xs md:text-sm text-gray-400 max-w-xl mx-auto leading-relaxed">
          {isArabic
            ? "اختر الخيار المناسب لحالتك مباشرة: تبليغ، استغاثة طارئة، شبكة بدون إنترنت، أو تصفح خدمات المنصة."
            : "Sélectionnez directement votre option : Signalement, SOS Urgence, Réseau sans Internet ou Autres Services."}
        </p>

        {/* Live Counters */}
        <div className="flex items-center justify-center gap-3 flex-wrap pt-1">
          <div className="bg-red-500/10 border border-red-500/20 px-3 py-1 rounded-full flex items-center gap-2 text-xs text-red-400 font-bold">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
            </span>
            <span>{isArabic ? `${sosCount} استغاثة نشطة` : `${sosCount} SOS Actif(s)`}</span>
          </div>
          <div className="bg-orange-500/10 border border-orange-500/20 px-3 py-1 rounded-full flex items-center gap-2 text-xs text-orange-400 font-bold">
            <span>🔥</span>
            <span>{isArabic ? `${reportsCount} بلاغ ميداني` : `${reportsCount} Signalements`}</span>
          </div>
        </div>
      </div>

      {/* THE 4 PRIMARY BUTTONS IN EXACT ORDER REQUESTED */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        {/* BUTTON 1: REPORT AN INCIDENT (تبليغ عن خطر أو حريق) */}
        <button
          type="button"
          onClick={() => onNavigate("report")}
          className="relative group p-6 bg-gradient-to-br from-orange-950/80 via-amber-900/40 to-zinc-950 border-2 border-orange-500/50 hover:border-orange-400 rounded-2xl shadow-[0_10px_30px_rgba(249,115,22,0.2)] hover:shadow-[0_15px_40px_rgba(249,115,22,0.35)] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] text-start flex flex-col justify-between space-y-4 cursor-pointer"
        >
          <div className="flex items-start justify-between">
            <div className="p-3 bg-orange-500/20 rounded-xl border border-orange-500/40">
              <Flame className="h-8 w-8 text-orange-400 animate-pulse" />
            </div>
            <span className="text-[10px] font-black tracking-widest text-orange-400 bg-orange-500/10 px-2.5 py-1 rounded-full uppercase border border-orange-500/20">
              {isArabic ? "1. تبليغ ميداني" : "1. SIGNALEMENT"}
            </span>
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-black text-slate-100 group-hover:text-orange-400 transition-colors">
              {isArabic ? "1. التبليغ عن حريق أو خطر" : "1. Signaler un Incendie / Danger"}
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              {isArabic 
                ? "إرسال بلاغ عاجل بصورة وإحداثيات الموقع مباشرة لغرفة العمليات والحماية المدنية."
                : "Envoyez un rapport d'incendie avec photo et coordonnées GPS au centre de secours."}
            </p>
          </div>
          <div className="pt-2 flex items-center justify-between text-xs font-bold text-orange-400 border-t border-orange-500/20">
            <span>{isArabic ? "اضغط لتقديم بلاغ الآن 🔥" : "Cliquer pour signaler 🔥"}</span>
            <Flame className="h-4 w-4" />
          </div>
        </button>

        {/* BUTTON 2: SOS EMERGENCY CALL (النجدة أو استغاثة) */}
        <button
          type="button"
          onClick={onTriggerSOS}
          className="relative group p-6 bg-gradient-to-br from-red-950/90 via-red-900/50 to-zinc-950 border-2 border-red-500/60 hover:border-red-400 rounded-2xl shadow-[0_10px_30px_rgba(239,68,68,0.25)] hover:shadow-[0_15px_40px_rgba(239,68,68,0.4)] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] text-start flex flex-col justify-between space-y-4 cursor-pointer"
        >
          <div className="flex items-start justify-between">
            <div className="p-3 bg-red-600/20 rounded-xl border border-red-500/40">
              <ShieldAlert className="h-8 w-8 text-red-400 animate-bounce" />
            </div>
            <span className="text-[10px] font-black tracking-widest text-red-400 bg-red-500/10 px-2.5 py-1 rounded-full uppercase border border-red-500/20">
              {isArabic ? "2. طارئ جداً SOS" : "2. URGENT SOS"}
            </span>
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-black text-slate-100 group-hover:text-red-400 transition-colors">
              {isArabic ? "2. النجدة أو استغاثة طارئة" : "2. Appel au Secours / SOS"}
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              {isArabic 
                ? "أنا محاصر بالنيران أو الدخان! طلب النجدة الفوري بموقعك الجغرافي لفرق الإنقاذ."
                : "Demandez une aide d'urgence immédiate avec localisation pour les équipes de secours."}
            </p>
          </div>
          <div className="pt-2 flex items-center justify-between text-xs font-bold text-red-400 border-t border-red-500/20">
            <span>{isArabic ? "طلب النجدة والإغاثة الفورية 🚨" : "Demander du secours immédiat 🚨"}</span>
            <AlertTriangle className="h-4 w-4" />
          </div>
        </button>

        {/* BUTTON 3: MESH NETWORK WHEN OFFLINE (في حالة انقطاع النت والشبكة) */}
        <button
          type="button"
          onClick={() => onNavigate("mesh")}
          className="relative group p-6 bg-gradient-to-br from-indigo-950/80 via-purple-900/40 to-zinc-950 border-2 border-indigo-500/50 hover:border-indigo-400 rounded-2xl shadow-[0_10px_30px_rgba(99,102,241,0.2)] hover:shadow-[0_15px_40px_rgba(99,102,241,0.35)] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] text-start flex flex-col justify-between space-y-4 cursor-pointer"
        >
          <div className="flex items-start justify-between">
            <div className="p-3 bg-indigo-500/20 rounded-xl border border-indigo-500/40">
              <WifiOff className="h-8 w-8 text-indigo-400 animate-pulse" />
            </div>
            <span className="text-[10px] font-black tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-full uppercase border border-indigo-500/20">
              {isArabic ? "3. بدون إنترنت" : "3. HORS LIGNE"}
            </span>
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-black text-slate-100 group-hover:text-indigo-400 transition-colors">
              {isArabic ? "3. شبكة طوارئ Mesh (دون إنترنت)" : "3. Réseau Mesh (Sans Internet)"}
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              {isArabic 
                ? "في حالة انقطاع النت والشبكة الهاتفية: تمرير نداءات الاستغاثة عبر الهواتف القريبة دون اتصال."
                : "En cas de coupure Internet/Réseau : relayez vos appels SOS d'appareil à appareil."}
            </p>
          </div>
          <div className="pt-2 flex items-center justify-between text-xs font-bold text-indigo-400 border-t border-indigo-500/20">
            <span>{isArabic ? "فتح شبكة Mesh للطوارئ 📶" : "Ouvrir le Réseau Mesh 📶"}</span>
            <Compass className="h-4 w-4" />
          </div>
        </button>

        {/* BUTTON 4: ALL OTHER PLATFORM SERVICES (باقي الأشياء والخدمات) */}
        <button
          type="button"
          onClick={() => {
            setShowAllServices(true);
            const el = document.getElementById("all-services-section");
            if (el) el.scrollIntoView({ behavior: "smooth" });
          }}
          className="relative group p-6 bg-gradient-to-br from-sky-950/80 via-blue-900/40 to-zinc-950 border-2 border-sky-500/50 hover:border-sky-400 rounded-2xl shadow-[0_10px_30px_rgba(14,165,233,0.2)] hover:shadow-[0_15px_40px_rgba(14,165,233,0.35)] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] text-start flex flex-col justify-between space-y-4 cursor-pointer"
        >
          <div className="flex items-start justify-between">
            <div className="p-3 bg-sky-500/20 rounded-xl border border-sky-500/40">
              <LayoutGrid className="h-8 w-8 text-sky-400" />
            </div>
            <span className="text-[10px] font-black tracking-widest text-sky-400 bg-sky-500/10 px-2.5 py-1 rounded-full uppercase border border-sky-500/20">
              {isArabic ? "4. باقي الخدمات" : "4. AUTRES SERVICES"}
            </span>
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-black text-slate-100 group-hover:text-sky-400 transition-colors">
              {isArabic ? "4. باقي الأشياء والخدمات" : "4. Tous les Autres Services"}
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              {isArabic 
                ? "تصفح الخريطة التفاعلية، مسارات الإخلاء، الراديو الرقمي، دليل النجاة، التطوع ومساعد IA."
                : "Consultez la carte, les routes d'évacuation, la radio, le guide de survie et l'IA."}
            </p>
          </div>
          <div className="pt-2 flex items-center justify-between text-xs font-bold text-sky-400 border-t border-sky-500/20">
            <span>{isArabic ? "عرض كافة أدوات وخدمات المنصة 🌐" : "Voir tous les outils 🌐"}</span>
            <ChevronDown className="h-4 w-4 animate-bounce" />
          </div>
        </button>

      </div>

      {/* QUICK DIRECT DIAL CARD */}
      <div className="bg-zinc-900/80 border border-white/5 rounded-2xl p-4 md:p-5 shadow-lg">
        <h4 className="font-extrabold text-xs md:text-sm text-slate-200 text-center mb-3 flex items-center justify-center gap-2">
          <Phone className="h-4 w-4 text-red-500 animate-pulse" />
          <span>{isArabic ? "الاتصال المباشر والمجاني بأرقام النجدة الرسمية" : "Numéros D'Urgence Directs & Gratuits"}</span>
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto">
          <a
            href="tel:1021"
            className="flex items-center justify-between p-3 bg-black/50 hover:bg-zinc-950 transition-all rounded-xl border border-red-500/30 text-red-400"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🚒</span>
              <div className="text-start">
                <p className="text-xs font-bold text-slate-100">{isArabic ? "الحماية المدنية الجزائرية" : "Protection Civile"}</p>
                <p className="text-[10px] text-gray-400">{isArabic ? "للطوارئ والحرائق الحادة" : "Urgences et incendies"}</p>
              </div>
            </div>
            <span className="text-base font-black font-mono px-3 py-1 bg-red-500/20 rounded-lg border border-red-500/30">1021</span>
          </a>

          <a
            href="tel:1070"
            className="flex items-center justify-between p-3 bg-black/50 hover:bg-zinc-950 transition-all rounded-xl border border-amber-500/30 text-amber-500"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🌲</span>
              <div className="text-start">
                <p className="text-xs font-bold text-slate-100">{isArabic ? "الرقم الأخضر للغابات" : "Garde Forestière"}</p>
                <p className="text-[10px] text-gray-400">{isArabic ? "لحوادث وزحف النيران" : "Feux de végétation"}</p>
              </div>
            </div>
            <span className="text-base font-black font-mono px-3 py-1 bg-amber-500/20 rounded-lg border border-amber-500/30">1070</span>
          </a>
        </div>
      </div>

      {/* SECTION 4 EXPANDABLE LIST: ALL PLATFORM SERVICES */}
      <div id="all-services-section" className="pt-2 text-center space-y-4">
        <button
          type="button"
          onClick={() => setShowAllServices(!showAllServices)}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-xl text-xs font-bold text-gray-200 transition-all cursor-pointer shadow-md"
        >
          <LayoutGrid className="h-4 w-4 text-sky-400" />
          <span>
            {showAllServices
              ? (isArabic ? "إخفاء القائمة التفصيلية للخدمات" : "Masquer la liste des services")
              : (isArabic ? "عرض تفاصيل باقي خدمات المنصة (الخريطة، الراديو، الإخلاء، الذكاء الاصطناعي...)" : "Afficher tous les outils et services de la plateforme")}
          </span>
          {showAllServices ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showAllServices && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-start animate-fadeIn pt-2">
            {secondaryServices.map((act) => (
              <button
                key={act.id}
                onClick={() => onNavigate(act.id)}
                className={`flex items-start p-3.5 rounded-xl border transition-all hover:-translate-y-0.5 shadow cursor-pointer ${act.color}`}
              >
                <div className="p-2.5 bg-zinc-950/70 rounded-lg shrink-0">
                  {act.icon}
                </div>
                <div className="mx-3 space-y-0.5">
                  <h4 className="text-xs font-extrabold text-slate-100 flex items-center gap-1 leading-tight">
                    <span>{isArabic ? act.titleAr : act.titleFr}</span>
                  </h4>
                  <p className="text-[10px] text-gray-400 leading-normal">
                    {isArabic ? act.descAr : act.descFr}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Solidarity Message Footer */}
      <div className="text-center text-[10px] text-gray-500 py-2 max-w-md mx-auto leading-normal">
        <p className="italic">
          {isArabic
            ? "«إنقاذ الأرواح يبدأ بوعيك وتبليغك السريع. أنت لست وحدك، جميعاً متضامنون لحماية أهالينا.»"
            : "« Sauver des vies commence par votre réactivité. Ensemble, solidaires pour nos familles. »"}
        </p>
      </div>

    </div>
  );
}


