import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Sparkles, Loader2, RefreshCw, Send, Shield, PhoneCall } from "lucide-react";

interface AICopilotProps {
  userLocation: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

export default function AICopilot({ userLocation, lang }: AICopilotProps) {
  const [guidance, setGuidance] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [activeWilaya, setActiveWilaya] = useState<string>("");

  const isArabic = lang === "ar";

  const fetchGuidance = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/ai/guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: userLocation?.lat || 36.8,
          lng: userLocation?.lng || 7.5,
          wilaya: activeWilaya || (isArabic ? "الشرق الجزائري" : "Est de l'Algérie"),
          lang: lang,
        }),
      });
      const data = await response.json();
      setGuidance(data.guidance || "");
    } catch (err) {
      console.error(err);
      setGuidance(
        isArabic
          ? "⚠️ عذراً، تعذر الاتصال بمركز الاستجابة الذكي حالياً. يرجى مراجعة شبكة الاتصال الخاصة بك."
          : "⚠️ Échec de connexion avec le serveur d'IA. Veuillez vérifier votre connexion."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGuidance();
  }, [lang, userLocation, activeWilaya]);

  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] flex flex-col h-full" dir={isArabic ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-gradient-to-tr from-orange-600 to-red-600 text-white rounded-lg border border-red-500/20">
            <Sparkles className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-100">
              {isArabic ? "المساعد الذكي لمواجهة الطوارئ" : "Assistant d'Urgence IA"}
            </h3>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {isArabic ? "إرشادات وتوجيهات أمنية مخصصة وفورية بالـ Gemini" : "Briefing et directives de sécurité par Gemini"}
            </p>
          </div>
        </div>

        <button
          onClick={fetchGuidance}
          disabled={loading}
          className="p-1.5 hover:bg-zinc-800 text-gray-400 hover:text-slate-200 rounded transition-colors"
          title={isArabic ? "تحديث التقرير" : "Actualiser"}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-red-500" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {/* Wilaya Filter inside Copilot */}
      <div className="mb-4">
        <label className="block text-[11px] uppercase tracking-widest font-bold text-gray-400 mb-1.5">
          {isArabic ? "تحديد ولاية للاستعلام الفوري:" : "Sélectionner une Wilaya à cibler :"}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[
            { ar: "الطارف", fr: "El Tarf" },
            { ar: "سكيكدة", fr: "Skikda" },
            { ar: "عنابة", fr: "Annaba" },
            { ar: "سوق أهراس", fr: "Souk Ahras" },
            { ar: "جيجل", fr: "Jijel" },
            { ar: "قالمة", fr: "Guelma" },
          ].map((w, idx) => (
            <button
              key={idx}
              onClick={() => setActiveWilaya(isArabic ? w.ar : w.fr)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-all cursor-pointer font-medium ${
                activeWilaya === (isArabic ? w.ar : w.fr)
                  ? "bg-red-600 text-white border-red-650 shadow-[0_0_12px_rgba(220,38,38,0.3)]"
                  : "bg-black/40 text-slate-400 border-white/5 hover:border-white/10"
              }`}
            >
              {isArabic ? w.ar : w.fr}
            </button>
          ))}
          {activeWilaya && (
            <button
              onClick={() => setActiveWilaya("")}
              className="text-xs text-red-400 hover:text-red-300 font-bold px-2 py-1"
            >
              {isArabic ? "إلغاء التحديد" : "Réinitialiser"}
            </button>
          )}
        </div>
      </div>

      {/* Main Guidance Text Container */}
      <div className="flex-1 min-h-[220px] max-h-[360px] overflow-y-auto bg-black/50 rounded-xl p-4 border border-white/5 relative scroll-smooth">
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center space-y-3 bg-black/80 backdrop-blur-sm">
            <Loader2 className="h-8 w-8 animate-spin text-red-500" />
            <p className="text-xs text-gray-400 animate-pulse font-medium text-center px-4">
              {isArabic
                ? "جاري تقييم الحرائق وتوليد تقرير السلامة الخاص بك بالذكاء الاصطناعي..."
                : "Analyse en cours des foyers et génération du guide de sécurité..."}
            </p>
          </div>
        ) : null}

        <div className="markdown-body text-xs text-slate-300 leading-relaxed space-y-4">
          <ReactMarkdown
            components={{
              h3: ({ node, ...props }) => (
                <h3 className="font-extrabold text-slate-100 text-sm flex items-center gap-1 mt-4 mb-2 border-b border-white/5 pb-1" {...props} />
              ),
              p: ({ node, ...props }) => <p className="mb-3 leading-relaxed text-slate-300" {...props} />,
              ul: ({ node, ...props }) => <ul className="list-disc pl-5 pr-5 mb-3 space-y-1.5" {...props} />,
              li: ({ node, ...props }) => <li className="marker:text-red-500 leading-relaxed text-slate-300" {...props} />,
              strong: ({ node, ...props }) => <strong className="text-red-400 font-bold" {...props} />,
            }}
          >
            {guidance}
          </ReactMarkdown>
        </div>
      </div>

      {/* Quick SOS Action footer */}
      <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between gap-3 bg-black/40 p-2.5 rounded-lg border border-white/5">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400 font-medium">
          <Shield className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>
            {isArabic ? "الدليل مصمم لحالات إخلاء الغابات" : "Guide conforme aux alertes forêts"}
          </span>
        </div>
        
        <a
          href="tel:1021"
          className="px-3 py-1.5 bg-red-600 hover:bg-red-750 text-white font-bold text-xs rounded-lg transition-all flex items-center gap-1.5 cursor-pointer shadow-[0_10px_20px_rgba(220,38,38,0.2)] shrink-0"
        >
          <PhoneCall className="h-3.5 w-3.5" />
          <span>{isArabic ? "اتصل بالحماية المدنية (1021)" : "Protection Civile (1021)"}</span>
        </a>
      </div>
    </div>
  );
}
