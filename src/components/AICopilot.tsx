import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { Sparkles, Loader2, RefreshCw, Send, Shield, PhoneCall } from "lucide-react";

interface AICopilotProps {
  mapClickedCoords: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

export default function AICopilot({ mapClickedCoords, lang }: AICopilotProps) {
  const [guidance, setGuidance] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [activeWilaya, setActiveWilaya] = useState<string>("");

  const isArabic = lang === "ar";
  const hasLocation = mapClickedCoords !== null;
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const MIN_REQUEST_INTERVAL_MS = 5000;
  const lastRequestRef = useRef(0);
  const latestRequestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const getCacheKey = () => {
    // No silent default coordinates: without a map click the key says "unknown
    // location", so a general answer is never cached as if it were local.
    const locationKey = hasLocation
      ? `${mapClickedCoords.lat.toFixed(4)}_${mapClickedCoords.lng.toFixed(4)}`
      : "loc:unknown";
    const hourBucket = Math.floor(Date.now() / CACHE_TTL_MS);
    return `ai_guidance_${lang}_${locationKey}_${activeWilaya}_${hourBucket}`;
  };

  const fetchGuidance = async (force = false, attempt = 0) => {
    const requestId = ++latestRequestRef.current;
    const cacheKey = getCacheKey();

    if (!force) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed.guidance && Date.now() - parsed.timestamp < CACHE_TTL_MS) {
            setGuidance(parsed.guidance);
            return;
          }
        }
      } catch {
        // ignore corrupted cache
      }
    }

    const now = Date.now();
    if (now - lastRequestRef.current < MIN_REQUEST_INTERVAL_MS && attempt === 0) {
      return;
    }
    lastRequestRef.current = now;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    let status = 0;
    try {
      const response = await fetch("/api/ai/guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Coordinates and wilaya are sent ONLY when actually known. The
          // server falls back to its own generic context and the UI shows an
          // explicit "location unknown" notice — no silent regional default.
          lat: mapClickedCoords?.lat,
          lng: mapClickedCoords?.lng,
          wilaya: activeWilaya || undefined,
          lang: lang,
        }),
        signal: controller.signal,
      });
      status = response.status;
      if (!response.ok) throw new Error(`HTTP ${status}`);
      const data = await response.json();
      if (requestId !== latestRequestRef.current || controller.signal.aborted) return;
      const text = data.guidance || "";
      setGuidance(text);
      if (text) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ guidance: text, timestamp: Date.now() }));
        } catch {
          // storage full — cache skipped
        }
      }
    } catch (err) {
      console.error(err);
      if ((controller.signal.aborted || (err instanceof Error && err.name === "AbortError"))) return;
      if (attempt < 2 && status === 0) {
        setTimeout(() => void fetchGuidance(true, attempt + 1), 2000);
        return;
      }
      const code = String(status || (err && typeof err === "object" && "message" in err ? (err as Error).message : ""));
      let message: string;
      if (code.includes("429")) {
        message = isArabic
          ? "⚠️ تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة بعد قليل."
          : "⚠️ Trop de requêtes, réessayez dans quelques instants.";
      } else if (code.includes("503")) {
        message = isArabic
          ? "⚠️ خدمة الذكاء الاصطناعي غير متاحة مؤقتاً."
          : "⚠️ Service d'IA temporairement indisponible.";
      } else {
        message = isArabic
          ? "⚠️ عذراً، تعذر الاتصال بمركز الاستجابة الذكي حالياً. يرجى مراجعة شبكة الاتصال الخاصة بك."
          : "⚠️ Échec de connexion avec le serveur d'IA. Veuillez vérifier votre connexion.";
      }
      if (requestId !== latestRequestRef.current || controller.signal.aborted) return;
      setGuidance(message);
    } finally {
      if (requestId === latestRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGuidance();
    return () => {
      abortRef.current?.abort();
    };
  }, [lang, mapClickedCoords, activeWilaya]);

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
          onClick={() => fetchGuidance(true)}
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

      {/* No-coordinate transparency: without a map click the answer is general
          and must never read as if it were about the user's whereabouts. */}
      {!hasLocation && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300 font-medium">
          {isArabic
            ? "⚠️ الموقع غير محدد — الإجابة عامة ولا تعكس موقعك الحالي. اضغط على الخريطة في تبويب «المرصد والخريطة» للحصول على إرشادات محلية."
            : "⚠️ Position inconnue — réponse générale sans votre contexte local. Cliquez sur la carte (onglet Observatoire) pour des consignes localisées."}
        </div>
      )}

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
          title={isArabic
            ? "رقم الحماية المدنية الجزائرية — أرقام باقي الدول في قائمة أرقام الطوارئ أعلى الصفحة"
            : "Protection Civile algérienne — les numéros des autres pays sont dans la liste « Urgences » en haut de page"}
        >
          <PhoneCall className="h-3.5 w-3.5" />
          <span>{isArabic ? "الحماية المدنية الجزائرية (1021)" : "Protection Civile Algérie (1021)"}</span>
        </a>
      </div>
    </div>
  );
}
