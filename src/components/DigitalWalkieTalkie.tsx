import { useState, useRef, useEffect } from "react";
import { Mic, RadioReceiver, Volume2, ShieldAlert, Users, Activity, Play, Square, Wifi, Settings, SignalHigh } from "lucide-react";

interface WalkieTalkieProps {
  lang: "ar" | "fr";
}

interface AudioMessage {
  id: string;
  sender: string;
  role: "official" | "citizen";
  zone: string;
  timestamp: Date;
  duration: number; // in seconds
  audioUrl?: string; // Mock for now
}

export default function DigitalWalkieTalkie({ lang }: WalkieTalkieProps) {
  const isArabic = lang === "ar";
  const [role, setRole] = useState<"official" | "citizen">("citizen");
  const [isRecording, setIsRecording] = useState(false);
  const [zone, setZone] = useState("تيزي وزو - قطاع أ");
  const [band, setBand] = useState<"VHF" | "UHF">("VHF");
  const [frequency, setFrequency] = useState(144.150);
  const [connectionMode, setConnectionMode] = useState<"websdr" | "mesh">("websdr");
  const [messages, setMessages] = useState<AudioMessage[]>([]);
  const [isPlaying, setIsPlaying] = useState<string | null>(null);
  
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);

  // Simulate receiving emergency broadcasts
  useEffect(() => {
    if (role === "citizen") {
      const interval = setInterval(() => {
        if (Math.random() > 0.7) {
          const newBroadcast: AudioMessage = {
            id: `audio_${Date.now()}`,
            sender: connectionMode === "websdr" 
              ? (isArabic ? `بث SDR بعيد (${frequency.toFixed(3)} MHz)` : `Stream SDR (${frequency.toFixed(3)} MHz)`) 
              : "مركز قيادة الحماية المدنية",
            role: "official",
            zone: zone,
            timestamp: new Date(),
            duration: Math.floor(Math.random() * 8) + 3,
          };
          setMessages((prev) => [newBroadcast, ...prev]);
        }
      }, 12000);
      return () => clearInterval(interval);
    }
  }, [role, zone, frequency, connectionMode]);

  const handleStartRecording = () => {
    setIsRecording(true);
    setRecordingTime(0);
    timerRef.current = setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    
    if (recordingTime > 0) {
      const newMsg: AudioMessage = {
        id: `audio_${Date.now()}`,
        sender: isArabic ? "العون الميداني أحمد" : "Agent Ahmed",
        role: "official",
        zone: zone,
        timestamp: new Date(),
        duration: recordingTime,
      };
      setMessages((prev) => [newMsg, ...prev]);
    }
    setRecordingTime(0);
  };

  const simulatePlayAudio = (id: string, duration: number) => {
    setIsPlaying(id);
    setTimeout(() => {
      setIsPlaying(null);
    }, duration * 1000);
  };

  return (
    <div className="bg-zinc-900/80 border border-slate-700/50 rounded-xl p-5 shadow-2xl font-sans text-slate-200 h-[600px] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-center border-b border-white/5 pb-4 mb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-500/20 text-emerald-400">
            <RadioReceiver className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              {isArabic ? "مستقبل الراديو المُعرّف برمجياً (SDR) & Geo-Radio" : "Récepteur SDR & Geo-Radio"}
              <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded border border-emerald-500/30 font-mono">OpenWebRX</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {isArabic 
                ? "بث صوتي مباشر عبر خوادم WebSDR للترددات المحلية (VHF/UHF) أو شبكة Mesh."
                : "Diffusion audio en direct via WebSDR pour les fréquences locales (VHF/UHF)."}
            </p>
          </div>
        </div>

        {/* Role Selector */}
        <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
          <button
            onClick={() => setRole("citizen")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${
              role === "citizen" ? "bg-slate-700 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Users className="h-4 w-4" />
            {isArabic ? "مواطن (استماع)" : "Citoyen"}
          </button>
          <button
            onClick={() => setRole("official")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${
              role === "official" ? "bg-red-600/80 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ShieldAlert className="h-4 w-4" />
            {isArabic ? "حماية مدنية (بث)" : "Protection Civile"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        
        {/* SDR & Active Zone Info */}
        <div className="lg:col-span-1 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col">
          <h4 className="text-sm font-bold text-slate-300 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-emerald-400" />
              {isArabic ? "إعدادات المستقبِل (Tuner)" : "Réglages du Récepteur"}
            </span>
          </h4>
          
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700 mb-4">
            <label className="text-[10px] uppercase text-slate-400 block mb-2">{isArabic ? "مصدر الإشارة" : "Source du signal"}</label>
            <div className="flex bg-slate-900 rounded-md p-1 mb-3">
              <button 
                onClick={() => setConnectionMode("websdr")}
                className={`flex-1 py-1.5 text-xs font-bold rounded flex items-center justify-center gap-1 transition-colors ${connectionMode === "websdr" ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                <Wifi className="h-3 w-3" /> SDR {isArabic ? "سحابي" : "Cloud"}
              </button>
              <button 
                onClick={() => setConnectionMode("mesh")}
                className={`flex-1 py-1.5 text-xs font-bold rounded flex items-center justify-center gap-1 transition-colors ${connectionMode === "mesh" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                <SignalHigh className="h-3 w-3" /> Local Mesh
              </button>
            </div>

            <label className="text-[10px] uppercase text-slate-400 block mb-2">{isArabic ? "نطاق التردد (Band)" : "Bande de fréquence"}</label>
            <div className="flex gap-2 mb-3">
              <button 
                onClick={() => { setBand("VHF"); setFrequency(144.150); }}
                className={`flex-1 py-1 text-xs font-bold rounded border ${band === "VHF" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : "bg-slate-900 text-slate-500 border-slate-700"}`}
              >
                VHF (136-174 MHz)
              </button>
              <button 
                onClick={() => { setBand("UHF"); setFrequency(433.000); }}
                className={`flex-1 py-1 text-xs font-bold rounded border ${band === "UHF" ? "bg-amber-500/20 text-amber-400 border-amber-500/50" : "bg-slate-900 text-slate-500 border-slate-700"}`}
              >
                UHF (400-470 MHz)
              </button>
            </div>
            
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] uppercase text-slate-400 block">{isArabic ? "التردد (MHz)" : "Fréquence (MHz)"}</label>
              <span className="text-xs font-mono text-emerald-400">{frequency.toFixed(3)} MHz</span>
            </div>
            <input 
              type="range" 
              min={band === "VHF" ? 136 : 400} 
              max={band === "VHF" ? 174 : 470} 
              step="0.005"
              value={frequency}
              onChange={(e) => setFrequency(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 h-1 mb-4"
            />
            
            <label className="text-[10px] uppercase text-slate-400 block mb-1">{isArabic ? "المنطقة (لـ Mesh/Geo):" : "Zone (pour Mesh):"}</label>
            <select 
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded text-xs font-bold text-slate-200 p-2 focus:outline-none"
              dir={isArabic ? "rtl" : "ltr"}
            >
              <option value="تيزي وزو - قطاع أ">تيزي وزو - قطاع أ (5km)</option>
              <option value="بجاية - جبل قورايا">بجاية - جبل قورايا (3km)</option>
              <option value="البليدة - الشريعة">البليدة - الشريعة (5km)</option>
            </select>
          </div>

          <div className="flex-1 rounded-lg border border-white/5 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-800 to-black/80 flex flex-col items-center justify-center p-4 relative overflow-hidden">
            {/* Waterfall effect simulation */}
            <div className="absolute inset-0 opacity-20" style={{
              backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, #10b981 2px, #10b981 4px)',
              backgroundSize: '100% 4px',
              animation: 'scroll-down 2s linear infinite'
            }}></div>
            <style>{`
              @keyframes scroll-down {
                0% { background-position: 0 0; }
                100% { background-position: 0 4px; }
              }
            `}</style>
            
            <div className="relative z-10 text-center bg-black/60 p-4 rounded-xl backdrop-blur-sm border border-white/10 w-full">
              <div className="flex justify-between items-center mb-1 text-[10px] text-emerald-400/50 font-mono">
                <span>{band === "VHF" ? "136" : "400"}</span>
                <span>{band === "VHF" ? "174" : "470"}</span>
              </div>
              
              <div className="h-10 w-full relative mb-3">
                {/* Mock signals */}
                <div className="absolute bottom-0 left-[20%] w-1 h-[40%] bg-emerald-500/30 rounded-t"></div>
                <div className="absolute bottom-0 left-[50%] w-2 h-[80%] bg-emerald-400 rounded-t shadow-[0_0_10px_#34d399]"></div>
                <div className="absolute bottom-0 left-[75%] w-1 h-[60%] bg-emerald-500/50 rounded-t"></div>
                
                {/* Tuner Needle */}
                <div 
                  className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_5px_#ef4444] z-10 transition-all duration-75"
                  style={{ left: `${((frequency - (band === "VHF" ? 136 : 400)) / ((band === "VHF" ? 174 : 470) - (band === "VHF" ? 136 : 400))) * 100}%` }}
                >
                  <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-red-500 rounded-full"></div>
                </div>
              </div>

              <p className="text-xl font-bold text-emerald-400 font-mono drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]">
                {frequency.toFixed(3)} MHz
              </p>
              <div className="flex items-center justify-center gap-2 mt-1">
                <span className="text-[9px] bg-slate-800 text-slate-300 px-1.5 rounded">NFM</span>
                <span className="text-[9px] bg-emerald-900/50 text-emerald-400 px-1.5 rounded flex items-center gap-1"><SignalHigh className="h-2 w-2"/> S9+10dB</span>
              </div>
            </div>
          </div>
        </div>

        {/* Radio Interface */}
        <div className="lg:col-span-2 bg-slate-900 border border-white/5 rounded-xl flex flex-col p-4 relative overflow-hidden">
          
          {/* Messages Log */}
          <div className="flex-1 overflow-y-auto space-y-3 pr-2 mb-6 custom-scrollbar">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-40 text-slate-400">
                <Volume2 className="h-12 w-12 mb-2" />
                <p>{isArabic ? "لا توجد رسائل إذاعية في نطاقك حالياً." : "Aucun message radio."}</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`p-3 rounded-xl border flex items-start gap-3 transition-colors ${
                  isPlaying === msg.id 
                    ? "bg-emerald-900/30 border-emerald-500/50" 
                    : msg.role === "official" 
                      ? "bg-red-950/20 border-red-900/30" 
                      : "bg-slate-800/50 border-slate-700/50"
                }`}>
                  <button 
                    onClick={() => simulatePlayAudio(msg.id, msg.duration)}
                    disabled={isPlaying !== null}
                    className={`h-10 w-10 shrink-0 rounded-full flex items-center justify-center transition-all ${
                      isPlaying === msg.id 
                        ? "bg-emerald-500 text-white animate-pulse" 
                        : "bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-50"
                    }`}
                  >
                    {isPlaying === msg.id ? <Volume2 className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
                  </button>
                  
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <span className={`text-sm font-bold flex items-center gap-1 ${msg.role === "official" ? "text-red-400" : "text-sky-400"}`}>
                        {msg.role === "official" && <ShieldAlert className="h-3 w-3" />}
                        {msg.sender}
                      </span>
                      <span className="text-[10px] text-slate-500">{msg.timestamp.toLocaleTimeString()}</span>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {/* Audio wave visual mock */}
                      <div className="flex-1 flex items-center h-4 gap-0.5 opacity-50">
                        {Array.from({ length: 15 }).map((_, i) => (
                          <div 
                            key={i} 
                            className="w-1 bg-slate-400 rounded-full" 
                            style={{ 
                              height: isPlaying === msg.id ? `${Math.max(20, Math.random() * 100)}%` : '2px',
                              transition: 'height 0.1s ease-in-out'
                            }}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-slate-400 font-mono">{msg.duration}s</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Push to Talk Button (Only for officials) */}
          <div className="mt-auto flex justify-center pt-4 border-t border-white/5">
            {role === "official" ? (
              <div className="text-center w-full max-w-sm">
                <button
                  onMouseDown={handleStartRecording}
                  onMouseUp={handleStopRecording}
                  onMouseLeave={() => isRecording && handleStopRecording()}
                  onTouchStart={handleStartRecording}
                  onTouchEnd={handleStopRecording}
                  className={`w-full py-6 rounded-2xl flex flex-col items-center justify-center gap-2 transition-all select-none shadow-xl ${
                    isRecording 
                      ? "bg-red-600 border-b-0 translate-y-2 shadow-none" 
                      : "bg-red-700 hover:bg-red-600 border-b-[8px] border-red-900"
                  }`}
                >
                  <Mic className={`h-8 w-8 ${isRecording ? "text-white animate-bounce" : "text-red-200"}`} />
                  <span className="font-bold text-white text-lg tracking-wider">
                    {isRecording ? (isArabic ? `جاري البث... 00:0${recordingTime}` : "EN DIRECT...") : (isArabic ? "اضغط باستمرار للتحدث (PTT)" : "MAINTENIR POUR PARLER")}
                  </span>
                </button>
                <p className="text-xs text-slate-400 mt-3 flex items-center justify-center gap-1">
                  <ShieldAlert className="h-3 w-3" />
                  {isArabic ? "سيتم بث صوتك فوراً لجميع المواطنين في النطاق" : "Votre voix sera diffusée à tous les citoyens de la zone"}
                </p>
              </div>
            ) : (
              <div className="text-center bg-slate-800/50 rounded-xl p-4 w-full">
                <Volume2 className="h-8 w-8 text-emerald-400/50 mx-auto mb-2 animate-pulse" />
                <p className="text-sm font-bold text-slate-300">
                  {isArabic ? "وضع الاستماع مفعل" : "Mode écoute activé"}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {isArabic ? "سيعمل مكبر الصوت تلقائياً عند وجود تحذير من الحماية المدنية." : "Le haut-parleur s'activera automatiquement en cas d'alerte."}
                </p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
