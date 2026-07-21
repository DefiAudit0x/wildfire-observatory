import { useState } from "react";
import { ShieldAlert, BookOpen, HeartPulse, Flame, Home, EyeOff } from "lucide-react";

interface SafetyGuidesProps {
  lang: "ar" | "fr";
}

export default function SafetyGuides({ lang }: SafetyGuidesProps) {
  const [activeTab, setActiveTab] = useState<"before" | "during" | "after" | "firstaid">("during");

  const isArabic = lang === "ar";

  const tabs = [
    { id: "before", labelAr: "قبل الحريق (الوقاية)", labelFr: "Avant (Prévention)", icon: <Home className="h-4 w-4" /> },
    { id: "during", labelAr: "أثناء الحريق (المواجهة)", labelFr: "Pendant (Urgence)", icon: <Flame className="h-4 w-4 text-red-500 animate-pulse" /> },
    { id: "after", labelAr: "بعد الحريق (الحيطة)", labelFr: "Après (Sécurité)", icon: <ShieldAlert className="h-4 w-4" /> },
    { id: "firstaid", labelAr: "الإسعافات الأولية", labelFr: "Premiers Secours", icon: <HeartPulse className="h-4 w-4 text-emerald-500" /> },
  ];

  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)]" dir={isArabic ? "rtl" : "ltr"}>
      {/* Title */}
      <div className="flex items-center gap-2 mb-4 border-b border-white/5 pb-3">
        <div className="p-1.5 bg-red-650/15 text-red-500 rounded border border-red-500/15">
          <BookOpen className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-bold text-base text-slate-100">
            {isArabic ? "دليل الدفاع المدني للوقاية والنجاة" : "Guide Officiel de Survie et Protection"}
          </h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {isArabic ? "حقيبة إرشادات السلامة مخصصة للقاطنين بمحاذاة الغابات بالشرق" : "Checklists et conseils de sécurité en zone forestière"}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4 bg-black/50 p-1 rounded-lg border border-white/5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer flex-1 justify-center min-w-[120px] ${
              activeTab === tab.id
                ? "bg-zinc-800 text-red-400 shadow-sm border border-white/5"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.icon}
            <span>{isArabic ? tab.labelAr : tab.labelFr}</span>
          </button>
        ))}
      </div>

      {/* Content Area */}
      <div className="bg-black/50 rounded-xl p-4 border border-white/5 min-h-[220px]">
        {activeTab === "before" && (
          <div className="space-y-4 text-slate-300 text-xs leading-relaxed">
            <h4 className="font-extrabold text-slate-200 border-b border-white/5 pb-1.5 flex items-center gap-1.5">
              🏡 {isArabic ? "إجراءات وقائية لحماية المنازل المحاذية للغابات" : "Protéger sa maison près des forêts"}
            </h4>
            <ul className="list-decimal pr-5 pl-5 space-y-2">
              <li>
                <strong>{isArabic ? "تنظيف محيط المنزل:" : "Débroussaillage :"}</strong>{" "}
                {isArabic
                  ? "أزل الأعشاب الجافة والأوراق الميتة في شعاع 30 متراً حول البيت تماماً."
                  : "Éliminez les herbes sèches et les feuilles mortes dans un rayon de 30 mètres."}
              </li>
              <li>
                <strong>{isArabic ? "تقليم الأشجار القريبة:" : "Élagage :"}</strong>{" "}
                {isArabic
                  ? "اقطع الأغصان المتدلية والقريبة من الأسطح أو النوافذ لتجنب انتقال ألسنة اللهب."
                  : "Coupez les branches d'arbres qui surplombent ou touchent le toit."}
              </li>
              <li>
                <strong>{isArabic ? "تخزين المواد القابلة للاشتعال:" : "Matériaux inflammables :"}</strong>{" "}
                {isArabic
                  ? "ضع قارورات غاز البوتان ومخزون الحطب في أماكن مغلقة بعيدة عن الغطاء النباتي."
                  : "Stockez le bois et le butane à l'écart des arbres et de la végétation."}
              </li>
              <li>
                <strong>{isArabic ? "تجهيز خراطيم المياه ومعدات الإطفاء:" : "Équipements d'eau :"}</strong>{" "}
                {isArabic
                  ? "تأكد من توفر خراطيم مياه تصل لجميع أطراف المنزل مع توفير دلاء رمل ورغوة إطفاء."
                  : "Préparez des tuyaux d'arrosage assez longs et des seaux de sable."}
              </li>
            </ul>
          </div>
        )}

        {activeTab === "during" && (
          <div className="space-y-4 text-slate-300 text-xs leading-relaxed">
            <h4 className="font-extrabold text-red-400 border-b border-white/5 pb-1.5 flex items-center gap-1.5 animate-pulse">
              🚨 {isArabic ? "بروتوكول الطوارئ في حال اقتراب النيران" : "Protocole d'urgence face aux flammes"}
            </h4>
            <ul className="list-decimal pr-5 pl-5 space-y-2">
              <li>
                <strong>{isArabic ? "إغلاق منافذ التهوية والغاز:" : "Fermer le gaz et l'air :"}</strong>{" "}
                {isArabic
                  ? "اقطع الغاز والكهرباء تماماً، وأغلق النوافذ وفتحات التكييف لمنع دخول الأدخنة والجمر."
                  : "Fermez les bouteilles de gaz, coupez le courant et fermez toutes les aérations."}
              </li>
              <li>
                <strong>{isArabic ? "الترطيب بالمياه:" : "Arrosage :"}</strong>{" "}
                {isArabic
                  ? "قم برش الأسطح، الجدران الخشبية، ومحيط المنزل القريب بالمياه بغزارة إذا أمكن."
                  : "Arrosez copieusement les façades et le toit si vous disposez d'eau."}
              </li>
              <li>
                <strong>{isArabic ? "حماية الجهاز التنفسي:" : "Voies respiratoires :"}</strong>{" "}
                {isArabic
                  ? "ضع قطعة قماش أو كمامة مبللة بالماء على فمك وأنفك لحمايتك من الغازات السامة."
                  : "Appliquez un linge mouillé sur le nez et la bouche pour filtrer les fumées toxiques."}
              </li>
              <li>
                <strong>{isArabic ? "البقاء في الداخل أو الإخلاء الآمن:" : "Rester confiné ou évacuer :"}</strong>{" "}
                {isArabic
                  ? "ابقَ داخل المنزل المبني من الطوب فهو أكثر أماناً من الهروب وسط الدخان، إلا إذا صدرت أوامر إخلاء فورية من الحماية المدنية، عندها اتبع مسار الإخلاء المحدد ولا تتردد."
                  : "Restez dans la maison en briques si le feu entoure la zone. N'évacuez que sur ordre de la Protection Civile via des chemins dégagés."}
              </li>
            </ul>
          </div>
        )}

        {activeTab === "after" && (
          <div className="space-y-4 text-slate-300 text-xs leading-relaxed">
            <h4 className="font-extrabold text-slate-200 border-b border-white/5 pb-1.5 flex items-center gap-1.5">
              ⚠️ {isArabic ? "توجيهات الأمان بعد إخماد الحريق أو زوال الخطر" : "Consignes de sécurité post-incendie"}
            </h4>
            <ul className="list-decimal pr-5 pl-5 space-y-2">
              <li>
                <strong>{isArabic ? "تجنب العودة المتسرعة:" : "Ne pas revenir précipitamment :"}</strong>{" "}
                {isArabic
                  ? "لا تعد إلى منزلك الذي تم إخلاؤه إلا بعد ترخيص رسمي وتأكيد تام من الحماية المدنية."
                  : "N'entrez pas dans les zones brûlées sans l'autorisation des autorités."}
              </li>
              <li>
                <strong>{isArabic ? "الحذر من البؤر الخفية والرياح:" : "Braises cachées :"}</strong>{" "}
                {isArabic
                  ? "قد تعود النيران للاشتعال بفعل الرياح. راقب محيط المنزل بحثاً عن رماد جمر متصاعد أو حرارة خفية."
                  : "Surveillez les points chauds et les braises souterraines qui peuvent reprendre."}
              </li>
              <li>
                <strong>{isArabic ? "فحص التمديدات الكهربائية والغاز:" : "Inspecter les réseaux :"}</strong>{" "}
                {isArabic
                  ? "لا تشغل الكهرباء أو تفتح صمامات الغاز قبل فحصها والتأكد من سلامة التمديدات والعدادات."
                  : "Faites vérifier l'état des lignes électriques et de gaz avant toute reconnexion."}
              </li>
              <li>
                <strong>{isArabic ? "الحذر من السقوط والانهيار:" : "Risque de chute d'arbres :"}</strong>{" "}
                {isArabic
                  ? "انتبه للأشجار المتفحمة والأسلاك الكهربائية المتدلية؛ فهي معرضة للسقوط المفاجئ في أي لحظة."
                  : "Attention aux chutes d'arbres fragilisés par le feu et aux câbles électriques au sol."}
              </li>
            </ul>
          </div>
        )}

        {activeTab === "firstaid" && (
          <div className="space-y-4 text-slate-300 text-xs leading-relaxed">
            <h4 className="font-extrabold text-emerald-400 border-b border-white/5 pb-1.5 flex items-center gap-1.5">
              🩺 {isArabic ? "الإسعافات الأولية لحالات الاختناق والحروق" : "Gestes de premiers secours d'urgence"}
            </h4>
            <div className="space-y-3">
              <div className="bg-black/40 p-2.5 rounded-lg border border-white/5">
                <p className="font-bold text-slate-200 mb-1">💨 {isArabic ? "في حال استنشاق الدخان والاختناق:" : "Inhalation de fumées :"}</p>
                <p>
                  {isArabic
                    ? "انقل المصاب فوراً إلى مكان مفتوح به هواء نقي. ابقِ المصاب في وضعية نصف الجلوس لتسهيل التنفس. فك الأزرار الضيقة حول العنق وصدره. اتصل بالإسعاف فوراً."
                    : "Déplacez la victime à l'air libre. Installez-la en position assise ou demi-assise pour faciliter la respiration. Desserrez les vêtements serrés."}
                </p>
              </div>

              <div className="bg-black/40 p-2.5 rounded-lg border border-white/5">
                <p className="font-bold text-slate-200 mb-1">💧 {isArabic ? "في حال التعرض للحروق الجلدية:" : "Brûlures thermiques :"}</p>
                <p>
                  {isArabic
                    ? "صب ماء بارداً جارياً (وليس مثلجاً) فوق الحرق لمدة 15 دقيقة على الأقل لتبريد الأنسجة. غطِّ الحرق بضمادة معقمة رطبة ونظيفة. لا تفرقع البثور المائية ولا تضع الطحين أو معجون الأسنان نهائياً."
                    : "Arrosez la brûlure immédiatement à l'eau tempérée (15°C) pendant 15 minutes. Ne percez pas les cloques. Ne mettez jamais de dentifrice ou de farine."}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 text-center">
        <p className="text-[10px] text-gray-500 font-medium italic">
          {isArabic
            ? "📁 تم مراجعة هذا الدليل بالرجوع لكتيبات الدفاع الوطني الجزائري والحماية المدنية."
            : "📁 Guide conçu selon les manuels de la Protection Civile Algérienne."}
        </p>
      </div>
    </div>
  );
}
