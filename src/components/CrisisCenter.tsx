import { useState } from "react";
import { Shield, Radio, Terminal, Send, Eye, Loader2, Sparkles, CheckCircle2, AlertOctagon } from "lucide-react";
import { Report } from "../types";

interface CrisisCenterProps {
  onAddParsedReport: (report: any) => void;
  reports: Report[];
  lang: "ar" | "fr";
}

export default function CrisisCenter({ onAddParsedReport, reports, lang }: CrisisCenterProps) {
  const isArabic = lang === "ar";
  
  // Drone simulator state
  const [isDroneActive, setIsDroneActive] = useState(false);
  const [droneLog, setDroneLog] = useState<string[]>([]);
  const [droneTarget, setDroneTarget] = useState("القالة - الطارف");
  const [droneBattery, setDroneBattery] = useState(100);

  // Cell Broadcast state
  const [selectedWilaya, setSelectedWilaya] = useState("الجزائر - الطارف (Algérie - El Tarf)");
  const [smsMessage, setSmsMessage] = useState(
    isArabic
      ? "تنبيه الحماية المدنية: رصد بؤرة حريق غابي خطيرة تقترب من المنازل. يرجى التزام الهدوء والاستعداد لخطة الإخلاء الآمنة."
      : "Alerte Protection Civile : Un incendie de forêt progresse rapidement. Veuillez rester calme et suivre le plan d'évacuation."
  );
  const [broadcastSent, setBroadcastSent] = useState(false);

  // Rural Mountain SMS Gateway Parser State
  const [incomingSms, setIncomingSms] = useState([
    {
      id: "sms-1",
      sender: "+213 661-89-23-11",
      text: "النيران هائلة وتقترب من قرية الصنوبر في القالة بالطارف، غابات الصنوبر تشتعل بالكامل أرجوكم أرسلوا طائرات الإطفاء الـ Canadair النيران تجاوزت البيوت",
      timestamp: "10 mins ago",
      parsed: false,
    },
    {
      id: "sms-2",
      sender: "+213 770-45-12-09",
      text: "دخان أسود كثيف يتصاعد من أحراش جبل لالة خديجة في البويرة (Bouira)، ألسنة اللهب تلتهم أشجار الزيتون والرياح غربية قوية جداً",
      timestamp: "18 mins ago",
      parsed: false,
    },
    {
      id: "sms-3",
      sender: "+216 98-412-503",
      text: "حريق كبير يلتهم أحراش الصنوبر الحلبي بالقرب من سد جندوبة في عين دراهم، الحرارة مرتفعة والنار تنتشر",
      timestamp: "32 mins ago",
      parsed: false,
    }
  ]);
  const [parsingSmsId, setParsingSmsId] = useState<string | null>(null);

  // Simulated Drone Mission launcher
  const dispatchDrone = () => {
    setIsDroneActive(true);
    setDroneBattery(100);
    setDroneLog([
      `[10:15:00] INIT: Initializing Maghreb UAV Command...`,
      `[10:15:02] GPS LOCK: Locked drone onto target sector [${droneTarget}]`,
      `[10:15:05] FLIGHT: Engines started, thrust 85%... Takeoff successful.`,
      `[10:15:10] TELEMETRY: Altitude 120m, speed 42 km/h, wind resistance: Normal`,
      `[10:15:15] OPTICS: Optical thermal sensors online. Scanning forest canopy...`,
    ]);

    let count = 0;
    const interval = setInterval(() => {
      count++;
      setDroneBattery((b) => Math.max(12, b - 8));
      
      const thermalValue = (Math.random() * 200 + 150).toFixed(1);
      const newLogs = [
        `[10:15:${20 + count * 5}] SENSORS: Thermal contrast reading: ${thermalValue}°C in dense vegetation.`,
        `[10:15:${22 + count * 5}] TELEMETRY: Pitch stabilized. Wind gusts 24 knots. Altitude 150m.`,
        `[10:15:${25 + count * 5}] ANALYSIS: Flame pattern index matches forest wildfire footprint.`,
      ];
      
      setDroneLog((prev) => [...prev, ...newLogs]);

      if (count >= 5) {
        clearInterval(interval);
        setDroneLog((prev) => [
          ...prev,
          `[10:15:55] SUCCESS: Thermal mapping uploaded to central Operations Map.`,
          `[10:16:00] RETURN: UAV Battery low (${40}%), returning to mobile command base...`,
          `[10:16:05] STATUS: Mission completed successfully.`
        ]);
      }
    }, 2000);
  };

  // Simulated NLP Geo-semantic SMS parser
  const parseSms = (sms: typeof incomingSms[0]) => {
    setParsingSmsId(sms.id);
    
    setTimeout(() => {
      // Analyze SMS text content using regex/NLP mock to extract coordinates & details
      let parsedReport: any = {
        id: `parsed-${Date.now()}`,
        status: "verified",
        reporterType: "citizen",
        reporterName: `SMS Citizen (${sms.sender})`,
        timestamp: new Date().toISOString(),
        consensusCount: 8, // Instant consensus booster because Civil Protection verified the SMS
      };

      if (sms.id === "sms-1") {
        parsedReport = {
          ...parsedReport,
          lat: 36.891,
          lng: 8.425,
          locationName: "قرية عين الصنوبر، القالة",
          wilaya: "الجزائر - الطارف (Algérie - El Tarf)",
          description: `📬 [بلاغ عاجل مرمز ومستقبل عبر SMS للجبال]: ${sms.text}`,
          severity: "critical",
          aiVerification: {
            isVerified: true,
            confidence: 94,
            detectedSigns: ["القالة الطارف", "الصنوبر", "Canadair", "تجاوزت البيوت"],
            aiComments: "تم تحليل لغة الرسالة بنجاح عبر بوابة SMS الجبلية العكسية. رصد إشارات استغاثة عالية الخطورة ومطابقة جغرافية لبلدية القالة.",
            suggestedSeverity: "CRITICAL"
          }
        };
      } else if (sms.id === "sms-2") {
        parsedReport = {
          ...parsedReport,
          lat: 36.370,
          lng: 4.145,
          locationName: "أحراش جبل لالة خديجة",
          wilaya: "الجزائر - البويرة (Algérie - Bouira)",
          description: `📬 [بلاغ عاجل مرمز ومستقبل عبر SMS للجبال]: ${sms.text}`,
          severity: "high",
          aiVerification: {
            isVerified: true,
            confidence: 88,
            detectedSigns: ["جبل لالة خديجة", "أشجار الزيتون", "البويرة"],
            aiComments: "تحليل جيو-دلالي ناجح لشبكة جبال لالة خديجة بالبويرة. كشف لهب متسارع عبر الأحراش الكثيفة.",
            suggestedSeverity: "HIGH"
          }
        };
      } else {
        parsedReport = {
          ...parsedReport,
          lat: 36.655,
          lng: 8.785,
          locationName: "بالقرب من سد جندوبة، عين دراهم",
          wilaya: "تونس - جندوبة (Tunisie - Jendouba)",
          description: `📬 [بلاغ عاجل مرمز ومستقبل عبر SMS للجبال]: ${sms.text}`,
          severity: "high",
          aiVerification: {
            isVerified: true,
            confidence: 91,
            detectedSigns: ["سد جندوبة", "عين دراهم", "الصنوبر الحلبي"],
            aiComments: "تم معالجة نص البلاغ التونسي بنظام التثليث النصي لعين دراهم بنجاح. رصد وهج بالقرب من منشأة مائية.",
            suggestedSeverity: "HIGH"
          }
        };
      }

      onAddParsedReport(parsedReport);
      
      // Update SMS parsed state locally
      setIncomingSms((prev) =>
        prev.map((item) => (item.id === sms.id ? { ...item, parsed: true } : item))
      );
      setParsingSmsId(null);
    }, 2000);
  };

  const triggerCellBroadcast = () => {
    setBroadcastSent(true);
    setTimeout(() => {
      setBroadcastSent(false);
    }, 5000);
  };

  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] font-mono text-slate-200 space-y-6">
      
      {/* HEADER SECTION */}
      <div className="flex items-center gap-2 border-b border-white/5 pb-4">
        <div className="p-2 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20">
          <Shield className="h-5 w-5 animate-pulse" />
        </div>
        <div>
          <h3 className="font-bold text-base text-slate-100">
            {isArabic ? "لوحة تحكم قيادة الأزمات والحماية المدنية" : "Centre d'Opérations Tactique de Crise"}
          </h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {isArabic 
              ? "التحكم في الموارد المتطورة: طائرات الاستطلاع (UAV)، البث الخلوي للجغرافيا، وبوابات استقبال SMS للجبال"
              : "Commandement spécialisé : Drones de reconnaissance, alertes SMS géofencing, gateway satellite montagne"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* 1. REMOTE SMS REPORTING PARSER GATEWAY (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-black text-amber-500 flex items-center gap-1.5 uppercase tracking-wider">
              <Radio className="h-4 w-4 animate-pulse text-amber-400" />
              <span>{isArabic ? "بوابة الجبال: استقبال البلاغات عبر SMS (دون إنترنت)" : "Gateway Satellite : Signalements SMS Montagne"}</span>
            </h4>
            <p className="text-[10px] text-gray-400 leading-normal">
              {isArabic 
                ? "خاصية ريادية تتيح للمزارعين وسكان القرى الجبلية المعزولة التبليغ برسائل نصية قصيرة (SMS). يتم تحليل النص فورياً لفرز الكلمات الدلالية، تحديد المواقع وإسقاط النيران تلقائياً على الخريطة!"
                : "Permet aux populations en montagne sans couverture 3G/4G de signaler un feu par SMS gratuit. L'algorithme extrait automatiquement la position GPS, la wilaya et la gravité."}
            </p>

            {/* SMS incoming inbox container */}
            <div className="space-y-2.5 mt-2 max-h-[220px] overflow-y-auto pr-1">
              {incomingSms.map((sms) => (
                <div key={sms.id} className="bg-zinc-950 p-3 rounded-lg border border-white/5 space-y-2 relative">
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-amber-400 font-bold">{sms.sender}</span>
                    <span className="text-gray-500">{sms.timestamp}</span>
                  </div>
                  <p className="text-xs text-slate-300 font-sans italic leading-relaxed" dir={isArabic ? "rtl" : "ltr"}>
                    "{sms.text}"
                  </p>

                  <div className="flex justify-between items-center border-t border-white/5 pt-2 mt-1">
                    <span className="text-[9px] text-gray-500">GSM Network: Satellite Fallback</span>
                    {sms.parsed ? (
                      <span className="text-[9px] font-black text-emerald-400 flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>{isArabic ? "تم التحليل ومطابقتها على الخريطة" : "Parsé & Cartographié"}</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => parseSms(sms)}
                        disabled={parsingSmsId !== null}
                        className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 disabled:bg-zinc-800 text-slate-950 font-black text-[9px] rounded transition-all cursor-pointer flex items-center gap-1 shadow-sm"
                      >
                        {parsingSmsId === sms.id ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>{isArabic ? "جاري المعالجة الـ NLP..." : "Extraction..."}</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-3 w-3" />
                            <span>{isArabic ? "تحليل جيو-دلالي وإسقاط بالخريطة" : "Extraire & Maper"}</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 2. EMERGENCY CELL BROADCAST TRIGGER (Wilaya Warning Alerts) */}
          <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-black text-red-500 flex items-center gap-1.5 uppercase tracking-wider">
              <AlertOctagon className="h-4 w-4 animate-bounce text-red-500" />
              <span>{isArabic ? "بث رسائل التحذير الخلوية (Geofenced Cell Broadcast)" : "Diffusion d'Alerte Cellulaire Géo-ciblée"}</span>
            </h4>
            
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] text-gray-400 mb-1 font-bold">{isArabic ? "المنطقة المستهدفة للبث" : "Zone Cible Géo-référencée"}</label>
                  <select
                    value={selectedWilaya}
                    onChange={(e) => setSelectedWilaya(e.target.value)}
                    className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none"
                  >
                    <option value="الجزائر - الطارف (Algérie - El Tarf)">{isArabic ? "الجزائر - الطارف" : "El Tarf"}</option>
                    <option value="الجزائر - جيجل (Algérie - Jijel)">{isArabic ? "الجزائر - جيجل" : "Jijel"}</option>
                    <option value="الجزائر - بجاية (Algérie - Béjaïa)">{isArabic ? "الجزائر - بجاية" : "Béjaïa"}</option>
                    <option value="تونس - جندوبة (Tunisie - Jendouba)">{isArabic ? "تونس - جندوبة" : "Jendouba (Tunisie)"}</option>
                    <option value="المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)">{isArabic ? "المغرب - طنجة تطوان" : "Tanger (Maroc)"}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] text-gray-400 mb-1 font-bold">{isArabic ? "بروتوكول البث" : "Protocole Réseau"}</label>
                  <input
                    type="text"
                    value="EAS-CELL-BROADCAST (Cell ID Broadcast)"
                    disabled
                    className="w-full bg-zinc-950/60 border border-white/5 text-slate-500 rounded px-2 py-1 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[9px] text-gray-400 mb-1 font-bold">{isArabic ? "صياغة التنبيه الطارئ لجميع الهواتف بالقطاع" : "Message d'Alerte Diffusé"}</label>
                <textarea
                  value={smsMessage}
                  onChange={(e) => setSmsMessage(e.target.value)}
                  rows={2}
                  className="w-full bg-zinc-950 border border-white/10 rounded p-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-red-500/30 font-sans"
                />
              </div>

              <button
                onClick={triggerCellBroadcast}
                className="w-full py-2 bg-red-650 hover:bg-red-700 text-white font-black text-xs rounded transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-md shadow-red-950/20"
              >
                <Send className="h-3.5 w-3.5" />
                <span>{isArabic ? "بث إشارة التنبيه العاجلة للهواتف بالولاية 🚨" : "Diffuser l'Alerte d'Urgence Cellulaire 🚨"}</span>
              </button>

              {broadcastSent && (
                <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-400 text-[10px] rounded animate-pulse font-sans leading-relaxed text-center">
                  <strong>🚨 {isArabic ? "إشارة البث مرسلة الآن!" : "Signal Cell Broadcast actif !"}</strong>
                  <p className="mt-1 text-[9px]">
                    {isArabic 
                      ? "تم بنجاح إجبار جميع الهواتف المحمولة المتصلة بالأبراج الخلوية في المنطقة المختارة على إطلاق صفارة الإنذار وعرض نص التحذير."
                      : "Toutes les cartes SIM actives connectées aux antennes-relais du secteur cible ont reçu l'alerte forcée."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 3. SIMULATED DRONE RECONNAISSANCE LAUNCHER (5 cols) */}
        <div className="lg:col-span-5 flex flex-col justify-between bg-black/40 border border-white/5 rounded-xl p-4 space-y-4">
          <div className="space-y-2">
            <h4 className="text-xs font-black text-amber-500 flex items-center gap-1.5 uppercase tracking-wider">
              <Terminal className="h-4 w-4 text-amber-400 animate-pulse" />
              <span>{isArabic ? "رادار الدرون: استطلاع جوي حراري" : "Terminal Drone Reconnaissance UAV"}</span>
            </h4>
            <p className="text-[10px] text-gray-400 leading-normal">
              {isArabic 
                ? "إرسال طائرات بدون طيار (Drones) استكشافية لفحص بؤر النيران بالجبال وتحديد المساحات الحرارية المحترقة والارتفاعات في الوقت الفعلي."
                : "Envoyez des drones d'observation UAV pour obtenir un retour d'image thermique et des coordonnées validées de manière autonome."}
            </p>
          </div>

          {/* Simulated Drone Status widget */}
          <div className="bg-zinc-950 rounded-lg p-3 space-y-3 border border-white/5">
            <div className="flex items-center justify-between text-xs font-bold border-b border-white/5 pb-2">
              <span className="flex items-center gap-1.5 text-slate-300">
                🛸 {isArabic ? "الحالة الجوية للدرون:" : "État UAV :"}
                <span className={isDroneActive ? "text-emerald-400 animate-pulse" : "text-gray-500"}>
                  {isDroneActive ? (isArabic ? "مهمة نشطة" : "En Vol") : (isArabic ? "بالمستودع" : "Au Sol")}
                </span>
              </span>
              <span className="text-amber-400 font-bold">{isArabic ? "البطارية:" : "Batterie :"} {droneBattery}%</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
              <div>
                <span className="block text-[8px] uppercase">{isArabic ? "القطاع المستهدف" : "Secteur cible"}</span>
                <input
                  type="text"
                  value={droneTarget}
                  onChange={(e) => setDroneTarget(e.target.value)}
                  disabled={isDroneActive}
                  className="w-full bg-black border border-white/5 rounded px-1.5 py-0.5 text-slate-200 text-xs mt-0.5"
                />
              </div>
              <div>
                <span className="block text-[8px] uppercase">{isArabic ? "كاميرا الرصد" : "Caméra thermique"}</span>
                <span className="block font-bold text-red-500 mt-1">FLIR T800 SENSOR</span>
              </div>
            </div>

            {!isDroneActive ? (
              <button
                onClick={dispatchDrone}
                className="w-full py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-black text-xs rounded transition-colors cursor-pointer flex items-center justify-center gap-1"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>{isArabic ? "إطلاق طائرة الاستكشاف الجوي" : "Lancer le drone d'exploration"}</span>
              </button>
            ) : (
              <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden">
                <div className="bg-amber-500 h-full animate-pulse" style={{ width: `${droneBattery}%` }}></div>
              </div>
            )}
          </div>

          {/* Live Flight Log Terminal Display */}
          <div className="bg-black/90 p-3 rounded-lg border border-white/10 h-44 overflow-y-auto text-[10px] text-emerald-400 font-mono space-y-1 scrollbar-thin">
            {droneLog.length === 0 ? (
              <div className="text-slate-600 text-center py-12 italic">
                {isArabic ? "[نظام طائرات الاستطلاع مغلق حالياً. أطلق درون لبدء بث التليمتري الجوي]" : "[Système UAV inactif. Lancez un drone pour l'analyse]"}
              </div>
            ) : (
              droneLog.map((log, idx) => (
                <p key={idx} className="leading-snug">{log}</p>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
