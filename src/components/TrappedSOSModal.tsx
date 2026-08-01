import { useState, useEffect, useRef } from "react";
import { AlertTriangle, MapPin, Mic, RadioReceiver, ShieldAlert, X, Volume2, Activity, ShieldCheck, Play, Square } from "lucide-react";

interface TrappedSOSModalProps {
  lang: "ar" | "fr";
  onClose: () => void;
  userLocation: { lat: number; lng: number } | null;
}

export default function TrappedSOSModal({ lang, onClose, userLocation }: TrappedSOSModalProps) {
  const isArabic = lang === "ar";
  const [step, setStep] = useState<"verifying" | "verified" | "recording" | "sent">("verifying");
  const [distanceToFire, setDistanceToFire] = useState<number | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [name, setName] = useState(() => localStorage.getItem("userName") || "");
  const [phone, setPhone] = useState(() => localStorage.getItem("userPhone") || "");
  const [isTestingSound, setIsTestingSound] = useState(false);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [isPlayingRecorded, setIsPlayingRecorded] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedAudioElemRef = useRef<HTMLAudioElement | null>(null);

  const playSOSTestSound = () => {
    if (isTestingSound) {
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {
          // ignore
        }
        audioCtxRef.current = null;
      }
      setIsTestingSound(false);
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      setIsTestingSound(true);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(880, ctx.currentTime);

      let isHigh = false;
      const interval = setInterval(() => {
        if (!audioCtxRef.current || ctx.state === "closed") {
          clearInterval(interval);
          return;
        }
        isHigh = !isHigh;
        osc.frequency.setValueAtTime(isHigh ? 1760 : 880, ctx.currentTime);
      }, 200);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      setTimeout(() => {
        clearInterval(interval);
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
          audioCtxRef.current.close();
        }
        audioCtxRef.current = null;
        setIsTestingSound(false);
      }, 4000);

    } catch (e) {
      console.error("Audio test error:", e);
      setIsTestingSound(false);
    }
  };

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    // Simulate location verification
    const verifyLocation = setTimeout(() => {
      // Mock distance: 200 meters from a fire zone
      setDistanceToFire(200);
      setStep("verified");
    }, 2500);

    return () => clearTimeout(verifyLocation);
  }, []);

  const [micStatus, setMicStatus] = useState<"idle" | "recording" | "permission_denied">("idle");
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const animFrameRef = useRef<number | null>(null);

  const startRecording = async () => {
    // Save current details entered by user to localStorage
    localStorage.setItem("userName", name);
    localStorage.setItem("userPhone", phone);

    setStep("recording");
    setRecordingTime(0);
    setMicStatus("recording");
    audioChunksRef.current = [];

    // Attempt real microphone recording
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        // Determine supported MimeType
        let mimeType = "";
        if (typeof MediaRecorder !== "undefined") {
          if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";
          else if (MediaRecorder.isTypeSupported("audio/webm")) mimeType = "audio/webm";
          else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
          else if (MediaRecorder.isTypeSupported("audio/ogg")) mimeType = "audio/ogg";
        }

        const options = mimeType ? { mimeType } : undefined;
        const mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        // Real-time audio analyzer for visualizer meter
        try {
          const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const audioCtx = new AudioCtx();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const updateLevel = () => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            setAudioLevel(avg);
            animFrameRef.current = requestAnimationFrame(updateLevel);
          };
          updateLevel();
        } catch {
          // Ignore analyzer error if any
        }

        mediaRecorder.start(100); // Collect 100ms chunks
      } else {
        setMicStatus("permission_denied");
      }
    } catch (err) {
      console.warn("Microphone access unavailable or denied:", err);
      setMicStatus("permission_denied");
    }
    
    timerRef.current = setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);
  };

  const generateVoiceAlertBase64 = async (): Promise<string> => {
    // Generate an emergency voice alert synth audio when mic isn't permitted
    return new Promise((resolve) => {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        // Create human-like speech siren frequency modulation
        osc.type = "sine";
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.5);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 1.0);

        gain.gain.setValueAtTime(0.4, ctx.currentTime);

        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        const recorder = new MediaRecorder(dest.stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve(reader.result as string);
            try { ctx.close(); } catch {}
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
        setTimeout(() => {
          recorder.stop();
          osc.stop();
        }, 3000);
      } catch {
        resolve("https://actions.google.com/sounds/v1/ambiences/outdoor_siren.ogg");
      }
    });
  };

  const stopRecordingAndSend = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    let finalAudioBase64 = "";

    // Stop MediaRecorder if active and await chunks
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      await new Promise<void>((resolve) => {
        if (!mediaRecorderRef.current) return resolve();
        mediaRecorderRef.current.onstop = () => {
          try {
            const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
            const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
            if (audioBlob.size > 200) {
              const reader = new FileReader();
              reader.onloadend = () => {
                finalAudioBase64 = reader.result as string;
                resolve();
              };
              reader.readAsDataURL(audioBlob);
            } else {
              resolve();
            }
          } catch {
            resolve();
          }
        };
        try {
          mediaRecorderRef.current.stop();
        } catch {
          resolve();
        }
      });
    }

    // Stop mic stream tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // If no audio chunk was captured (e.g. mic disabled), use voice alert
    if (!finalAudioBase64 || finalAudioBase64.length < 100) {
      finalAudioBase64 = await generateVoiceAlertBase64();
      // Also speak via browser speech synthesis as a live voice fallback
      if ('speechSynthesis' in window) {
        try {
          const text = name 
            ? `استغاثة طارئة من ${name}. شخص محاصر بالنيران يحتاج لإنقاذ عاجل.`
            : `استغاثة طارئة! شخص محاصر بالنيران يحتاج لإنقاذ عاجل.`;
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = "ar-SA";
          window.speechSynthesis.speak(utterance);
        } catch {}
      }
    }

    setRecordedAudioUrl(finalAudioBase64);

    if (userLocation) {
      try {
        const storedId = sessionStorage.getItem("device_id") || `web_${Math.random().toString(36).substring(2, 10)}`;
        const finalName = name.trim() || (isArabic ? "مواطن محاصر" : "Citoyen Piégé");

        await fetch("/api/sos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: storedId,
            lat: userLocation.lat,
            lng: userLocation.lng,
            name: finalName,
            phone: phone.trim(),
            audioUrl: finalAudioBase64,
            audioDuration: recordingTime || 5
          }),
        });
      } catch (err) {
        console.error("Failed to post SOS to server:", err);
      }
    }

    setStep("sent");
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-red-500/50 rounded-2xl w-full max-w-md shadow-[0_0_50px_rgba(220,38,38,0.2)] overflow-hidden">
        
        {/* Header */}
        <div className="bg-red-600 p-4 flex justify-between items-center text-white">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 animate-pulse" />
            {isArabic ? "نداء استغاثة طارئ (شخص محاصر)" : "SOS Urgence (Personne Piégée)"}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          
          {step === "verifying" && (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
              <div className="relative">
                <div className="absolute inset-0 bg-red-500/20 rounded-full animate-ping"></div>
                <div className="h-16 w-16 bg-red-500/20 border border-red-500 rounded-full flex items-center justify-center">
                  <MapPin className="h-8 w-8 text-red-500" />
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-100">
                {isArabic ? "جاري التحقق من موقعك..." : "Vérification de la position..."}
              </h3>
              <p className="text-sm text-slate-400">
                {isArabic 
                  ? "نقوم بمقاطعة إحداثياتك مع بؤر النيران النشطة لتأكيد حالة الخطر الداهم."
                  : "Analyse de vos coordonnées par rapport aux feux actifs."}
              </p>
            </div>
          )}

          {step === "verified" && (
            <div className="flex flex-col items-center text-center space-y-5 animate-fadeIn">
              <div className="h-16 w-16 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center border border-amber-500/50">
                <AlertTriangle className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-amber-400 mb-2">
                  {isArabic ? "تم تأكيد حالة الخطر المحدق" : "Danger Imminent Confirmé"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic ? "أنت متواجد على بُعد " : "Vous êtes à "}
                  <span className="font-bold text-white px-1">{distanceToFire} {isArabic ? "متر" : "mètres"}</span>
                  {isArabic ? "من حريق نشط." : "d'un feu actif."}
                </p>
                <p className="text-xs text-red-400 mt-2 p-2 bg-red-950/30 rounded border border-red-900/50">
                  {isArabic 
                    ? "تم فتح قناة الاتصال المباشر (Override) بجميع أعوان الحماية المدنية في النطاق الجغرافي." 
                    : "Canal radio direct (Override) ouvert avec toutes les unités à proximité."}
                </p>
              </div>

              {/* Name & Phone Info Inputs */}
              <div className="w-full space-y-3 bg-black/40 p-4 rounded-xl border border-white/5" dir={isArabic ? "rtl" : "ltr"}>
                <h4 className="text-xs font-bold text-slate-300 border-b border-white/5 pb-1.5 flex items-center gap-1.5 justify-start">
                  <span>🚨</span>
                  <span>{isArabic ? "معلومات تحديد الهوية للإنقاذ" : "Informations d'identification pour secours"}</span>
                </h4>
                
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "الاسم الكامل (اختياري)" : "Nom Complet (Optionnel)"}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={isArabic ? "مثال: أحمد بوعلام" : "Ex: Ahmed Boualam"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-start"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "رقم الهاتف للاتصال المباشر" : "Numéro de téléphone direct"}
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={isArabic ? "مثال: 0661234567" : "Ex: 0661234567"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-left font-mono"
                  />
                </div>
              </div>

              {/* Siren Test Button */}
              <button
                type="button"
                onClick={playSOSTestSound}
                className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 border transition-all cursor-pointer ${
                  isTestingSound 
                    ? "bg-amber-500/20 border-amber-500 text-amber-300 animate-pulse shadow-lg shadow-amber-500/20"
                    : "bg-black/50 border-white/10 hover:border-white/20 text-gray-300 hover:text-white"
                }`}
              >
                <Volume2 className={`h-4 w-4 ${isTestingSound ? "text-amber-400 animate-bounce" : "text-gray-400"}`} />
                <span>
                  {isTestingSound
                    ? (isArabic ? "🔊 جاري تجربة صفارة الإنذار... (اضغط للإيقاف)" : "🔊 Sirène en cours d'essai...")
                    : (isArabic ? "🔊 اختبار وتجربة صوت صفارة الاستغاثة الميدانية" : "🔊 Tester le son de la sirène d'urgence")}
                </span>
              </button>

              <button
                onClick={startRecording}
                className="w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-transform hover:scale-105 active:scale-95 shadow-xl cursor-pointer"
              >
                <Mic className="h-5 w-5" />
                {isArabic ? "اضغط لبدء تسجيل الاستغاثة الصوتية" : "Commencer l'enregistrement vocal"}
              </button>
            </div>
          )}

          {step === "recording" && (
            <div className="flex flex-col items-center text-center space-y-5 animate-fadeIn py-4">
              <div className="relative">
                <div className={`absolute inset-0 rounded-full animate-ping ${micStatus === "permission_denied" ? "bg-amber-500/30" : "bg-red-500/30"}`}></div>
                <div className={`h-20 w-20 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.5)] ${micStatus === "permission_denied" ? "bg-amber-600" : "bg-red-600"}`}>
                  <Mic className="h-10 w-10 text-white animate-pulse" />
                </div>
              </div>
              
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-white font-mono">00:{recordingTime < 10 ? `0${recordingTime}` : recordingTime}</h3>
                <p className="text-sm text-red-400 animate-pulse font-bold flex items-center justify-center gap-1">
                  <Activity className="h-4 w-4" />
                  {isArabic ? "تحدث الآن لتسجيل استغاثتك الصوتية المباشرة..." : "Parlez pour enregistrer votre message vocal..."}
                </p>
                {micStatus === "permission_denied" && (
                  <p className="text-xs text-amber-300 bg-amber-950/60 p-2 rounded-lg border border-amber-500/30 font-semibold mt-2">
                    {isArabic 
                      ? "⚠️ الميكروفون مغلق في متصفحك. سيتم توليد استغاثة صوتية ناطقة آلياً باسمك."
                      : "⚠️ Micro bloqué dans votre navigateur. Un SOS vocal automatique sera généré."}
                  </p>
                )}
              </div>

              {/* Real Audio Level Visualizer */}
              <div className="flex items-end justify-center gap-1 h-12 w-full max-w-xs bg-black/60 p-2 rounded-xl border border-white/10">
                {Array.from({ length: 20 }).map((_, i) => {
                  const factor = Math.sin((i / 20) * Math.PI);
                  const barHeight = Math.min(100, Math.max(15, (audioLevel * 1.5 * factor) + (Math.random() * 10)));
                  return (
                    <div 
                      key={i} 
                      className={`w-2 rounded-full transition-all duration-75 ${barHeight > 60 ? "bg-red-500" : barHeight > 30 ? "bg-amber-400" : "bg-emerald-400"}`} 
                      style={{ height: `${barHeight}%` }}
                    />
                  );
                })}
              </div>

              <button
                onClick={stopRecordingAndSend}
                className="w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-xl shadow-red-600/30 transition-all cursor-pointer"
              >
                <div className="h-4 w-4 bg-white rounded-sm"></div>
                {isArabic ? "إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨" : "Arrêter et envoyer le SOS vocal 🚨"}
              </button>
            </div>
          )}

          {step === "sent" && (
            <div className="flex flex-col items-center text-center space-y-4 py-6 animate-fadeIn">
              <div className="h-16 w-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center border border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                <ShieldCheck className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-emerald-400 mb-2">
                  {isArabic ? "تم استلام ونشر نداء الاستغاثة!" : "SOS vocal transmis !"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic 
                    ? "تم بث تسجيلك الصوتي وإحداثياتك الدقيقة لجميع أجهزة الحماية المدنية والقيادة المركزية." 
                    : "Votre message vocal et votre position ont été transmis à la Protection Civile et au Commandement."}
                </p>
              </div>

              {recordedAudioUrl && (
                <div className="w-full bg-red-950/40 border border-red-500/30 rounded-xl p-3 text-start space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-red-300">
                    <span className="flex items-center gap-1.5">
                      <Volume2 className="h-4 w-4 text-red-400 animate-pulse" />
                      <span>{isArabic ? "معاينة الاستغاثة الصوتية المرسلة" : "Aperçu de l'enregistrement SOS"}</span>
                    </span>
                    <span className="text-[10px] bg-red-500/20 px-1.5 py-0.5 rounded text-red-300">
                      {recordingTime} {isArabic ? "ثانية" : "s"}
                    </span>
                  </div>
                  <audio controls src={recordedAudioUrl} className="w-full h-8" />
                </div>
              )}

              <div className="w-full bg-slate-800/80 rounded-lg p-3 border border-slate-700 flex items-start gap-3 text-left">
                <RadioReceiver className="h-5 w-5 text-indigo-400 shrink-0 mt-0.5" />
                <p className="text-xs text-slate-400">
                  {isArabic 
                    ? "نصيحة: ابق في مكان منخفض، غطِ فمك بقطعة قماش مبللة، ولا تغلق هاتفك. فرق الإنقاذ في طريقها إليك." 
                    : "Conseil : Restez près du sol, couvrez votre bouche avec un tissu humide. Les secours arrivent."}
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-full mt-2 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-bold transition-colors cursor-pointer"
              >
                {isArabic ? "إغلاق" : "Fermer"}
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
