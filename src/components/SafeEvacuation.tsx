import { useState, useEffect } from "react";
import { Map as MapIcon, Navigation2, ShieldCheck, AlertTriangle, ArrowRight, Car, Compass, MapPin, Activity } from "lucide-react";

interface SafeEvacuationProps {
  lang: "ar" | "fr";
  userLocation: { lat: number; lng: number } | null;
}

interface SafeZone {
  id: string;
  nameAr: string;
  nameFr: string;
  capacity: number;
  currentOccupancy: number;
  distance: string;
  hasMedical: boolean;
}

export default function SafeEvacuation({ lang, userLocation }: SafeEvacuationProps) {
  const isArabic = lang === "ar";
  const [isCalculating, setIsCalculating] = useState(false);
  const [activeRoute, setActiveRoute] = useState<SafeZone | null>(null);

  const safeZones: SafeZone[] = [
    { id: "z1", nameAr: "ملعب مصطفى تشاكر - البليدة", nameFr: "Stade Mustapha Tchaker - Blida", capacity: 5000, currentOccupancy: 1200, distance: "4.2 km", hasMedical: true },
    { id: "z2", nameAr: "القطب الجامعي - تيزي وزو", nameFr: "Pôle Universitaire - Tizi Ouzou", capacity: 8000, currentOccupancy: 3500, distance: "12.5 km", hasMedical: true },
    { id: "z3", nameAr: "ساحة التضامن - بجاية", nameFr: "Place de la Solidarité - Béjaïa", capacity: 2000, currentOccupancy: 1800, distance: "7.1 km", hasMedical: false },
  ];

  const handleCalculateRoute = (zone: SafeZone) => {
    setIsCalculating(true);
    setActiveRoute(null);
    
    // Simulate AI calculating safe route avoiding fires
    setTimeout(() => {
      setIsCalculating(false);
      setActiveRoute(zone);
    }, 2500);
  };

  return (
    <div className="bg-zinc-900/80 border border-slate-700/50 rounded-xl p-5 shadow-2xl font-sans text-slate-200 h-[600px] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-center border-b border-white/5 pb-4 mb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-sky-500/20 text-sky-400">
            <Compass className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              {isArabic ? "مسارات الإخلاء الذكية (AI Routing)" : "Itinéraires d'Évacuation (IA)"}
              <span className="bg-sky-500/20 text-sky-300 text-[10px] px-2 py-0.5 rounded border border-sky-500/30">BETA</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {isArabic 
                ? "توجيه ديناميكي للمناطق الآمنة مع تجنب بؤر النيران النشطة واتجاه الرياح."
                : "Guidage dynamique vers les zones sûres en évitant les feux actifs."}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        
        {/* Safe Zones List */}
        <div className="lg:col-span-1 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col overflow-hidden">
          <h4 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isArabic ? "المراكز الآمنة المتاحة" : "Centres d'accueil disponibles"}
          </h4>
          
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            {safeZones.map((zone) => {
              const occupancyRate = (zone.currentOccupancy / zone.capacity) * 100;
              const isFull = occupancyRate > 90;

              return (
                <div key={zone.id} className={`p-3 rounded-xl border transition-all ${
                  activeRoute?.id === zone.id 
                    ? "bg-sky-900/30 border-sky-500/50" 
                    : "bg-slate-800/50 border-slate-700/50 hover:bg-slate-700/50"
                }`}>
                  <div className="flex justify-between items-start mb-2">
                    <h5 className="text-sm font-bold text-slate-200">{isArabic ? zone.nameAr : zone.nameFr}</h5>
                    <span className="text-xs font-mono text-sky-400 bg-sky-950 px-1.5 py-0.5 rounded">{zone.distance}</span>
                  </div>
                  
                  <div className="flex items-center gap-4 text-[10px] text-slate-400 mb-3">
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" />
                      {zone.currentOccupancy} / {zone.capacity} {isArabic ? "شخص" : "pers"}
                    </span>
                    {zone.hasMedical && (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <ShieldCheck className="h-3 w-3" />
                        {isArabic ? "نقطة طبية" : "Point Médical"}
                      </span>
                    )}
                  </div>

                  {/* Capacity Bar */}
                  <div className="w-full bg-slate-900 rounded-full h-1.5 mb-3">
                    <div 
                      className={`h-1.5 rounded-full ${isFull ? 'bg-red-500' : occupancyRate > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`} 
                      style={{ width: `${occupancyRate}%` }}
                    ></div>
                  </div>

                  <button
                    onClick={() => handleCalculateRoute(zone)}
                    disabled={isCalculating || isFull}
                    className={`w-full py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                      activeRoute?.id === zone.id
                        ? "bg-sky-600 text-white"
                        : isFull 
                          ? "bg-slate-800 text-slate-500 cursor-not-allowed" 
                          : "bg-indigo-600 hover:bg-indigo-500 text-white"
                    }`}
                  >
                    {isCalculating && activeRoute?.id !== zone.id ? (
                      <span className="animate-pulse">{isArabic ? "جاري التخطيط..." : "Calcul en cours..."}</span>
                    ) : activeRoute?.id === zone.id ? (
                      <>
                        <Navigation2 className="h-3 w-3" />
                        {isArabic ? "المسار نشط" : "Itinéraire actif"}
                      </>
                    ) : (
                      <>
                        <MapIcon className="h-3 w-3" />
                        {isArabic ? "ارسم مسار النجاة" : "Tracer l'itinéraire"}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Navigation & Map Panel */}
        <div className="lg:col-span-2 bg-slate-900 border border-white/5 rounded-xl flex flex-col p-4 relative overflow-hidden">
          
          {isCalculating ? (
            <div className="h-full flex flex-col items-center justify-center opacity-80 text-sky-400 gap-4">
              <div className="relative">
                <div className="h-16 w-16 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
                <Compass className="h-6 w-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-sky-300" />
              </div>
              <p className="text-sm font-bold animate-pulse">
                {isArabic ? "نظام الذكاء الاصطناعي يقوم بتحليل بؤر النيران وحركة الرياح..." : "L'IA analyse les feux et les vents..."}
              </p>
            </div>
          ) : !activeRoute ? (
            <div className="h-full flex flex-col items-center justify-center opacity-40 text-slate-400 gap-3">
              <MapIcon className="h-12 w-12" />
              <p className="text-sm text-center max-w-xs">
                {isArabic 
                  ? "اختر منطقة آمنة لرسم مسار إخلاء يضمن عدم تقاطعك مع مناطق الخطر." 
                  : "Sélectionnez une zone sûre pour générer un itinéraire évitant les dangers."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full animate-fadeIn">
              {/* Route Summary */}
              <div className="bg-sky-950/30 border border-sky-900/50 rounded-xl p-4 mb-4 flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-sky-100 flex items-center gap-2">
                    <Navigation2 className="h-4 w-4 text-sky-400" />
                    {isArabic ? "مسار الإخلاء آمن" : "Itinéraire Sécurisé"}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                    <Car className="h-3 w-3" /> {activeRoute.distance} • ~14 {isArabic ? "دقيقة" : "min"}
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-block px-2 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] rounded font-bold">
                    {isArabic ? "خالٍ من النيران" : "Voie Libre"}
                  </span>
                </div>
              </div>

              {/* Turn by turn mock */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                
                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
                      <MapPin className="h-3 w-3" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">{isArabic ? "موقعك الحالي" : "Votre position"}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{isArabic ? "اتجه شمالاً نحو الطريق الوطني 12" : "Prenez le nord vers RN12"}</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700">
                      <ArrowRight className="h-3 w-3 rtl:rotate-180" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">{isArabic ? "انعطاف يمين" : "Tournez à droite"}</p>
                    <p className="text-xs text-emerald-400 mt-0.5 flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" /> {isArabic ? "هذا المسار يتجنب حريق غابة بوعنداس (تم تغيير المسار)" : "Évite le feu de Bouandas (Déviation active)"}
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700">
                      <Navigation2 className="h-3 w-3" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">{isArabic ? "استمر لمسافة 3 كم" : "Continuez sur 3 km"}</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                      <ShieldCheck className="h-3 w-3" />
                    </div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-emerald-400">{isArabic ? activeRoute.nameAr : activeRoute.nameFr}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{isArabic ? "الوصول إلى المنطقة الآمنة" : "Arrivée à la zone sécurisée"}</p>
                  </div>
                </div>

              </div>

              {/* Action */}
              <div className="mt-4 pt-4 border-t border-white/5">
                <button className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-all">
                  <Navigation2 className="h-5 w-5" />
                  {isArabic ? "ابدأ الملاحة الصوتية (بدون إنترنت)" : "Démarrer la navigation (Hors-ligne)"}
                </button>
                <p className="text-xs text-center text-slate-400 mt-2 flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-400" />
                  {isArabic ? "تم تحميل الخرائط مسبقاً للعمل عند انقطاع الشبكة." : "Cartes préchargées pour le mode hors-ligne."}
                </p>
              </div>

            </div>
          )}
        </div>

      </div>
    </div>
  );
}
