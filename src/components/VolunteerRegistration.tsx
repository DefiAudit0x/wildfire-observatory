import { useState } from "react";
import { Shield, User, Phone, Mail, MapPin, Send, CheckCircle, Loader2, BadgeCheck, AlertTriangle } from "lucide-react";
import { Language } from "../types";

interface VolunteerRegistrationProps {
  lang: Language;
}

const WILAYAS_LIST = [
  { nameAr: "الجزائر - الجزائر العاصمة", nameFr: "Algérie - Alger" },
  { nameAr: "الجزائر - وهران", nameFr: "Algérie - Oran" },
  { nameAr: "الجزائر - قسنطينة", nameFr: "Algérie - Constantine" },
  { nameAr: "الجزائر - عنابة", nameFr: "Algérie - Annaba" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf" },
  { nameAr: "الجزائر - سكيكدة", nameFr: "Algérie - Skikda" },
  { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou" },
  { nameAr: "الجزائر - بجاية", nameFr: "Algérie - Béjaïa" },
  { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel" },
  { nameAr: "تونس - تونس العاصمة", nameFr: "Tunisie - Tunis" },
  { nameAr: "تونس - جندوبة", nameFr: "Tunisie - Jendouba" },
  { nameAr: "تونس - بنزرت", nameFr: "Tunisie - Bizerte" },
  { nameAr: "تونس - سوسة", nameFr: "Tunisie - Sousse" },
  { nameAr: "تونس - صفاقس", nameFr: "Tunisie - Sfax" },
  { nameAr: "المغرب - طنجة تطوان الحسيمة", nameFr: "Maroc - Tanger-Tétouan" },
  { nameAr: "المغرب - الرباط سلا القنيطرة", nameFr: "Maroc - Rabat-Salé" },
  { nameAr: "المغرب - الدار البيضاء سطات", nameFr: "Maroc - Casablanca-Settat" },
  { nameAr: "المغرب - مراكش آسفي", nameFr: "Maroc - Marrakech-Safi" },
  { nameAr: "ليبيا - طرابلس", nameFr: "Libye - Tripoli" },
  { nameAr: "ليبيا - بنغازي", nameFr: "Libye - Benghazi" },
  { nameAr: "ليبيا - الجبل الأخضر", nameFr: "Libye - Al Jabal al Akhdar" },
  { nameAr: "ليبيا - درنة", nameFr: "Libye - Derna" },
  { nameAr: "ليبيا - مصراتة", nameFr: "Libye - Misrata" },
];

export default function VolunteerRegistration({ lang }: VolunteerRegistrationProps) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [wilaya, setWilaya] = useState("");
  const [type, setType] = useState<"volunteer" | "official">("volunteer");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const isArabic = lang === "ar";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !phone || !wilaya) {
      setErrorMsg(isArabic ? "يرجى ملء الحقول الإلزامية" : "Veuillez remplir les champs obligatoires");
      return;
    }
    setIsSubmitting(true);
    setErrorMsg("");

    try {
      const res = await fetch("/api/volunteer/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, phone, email: email || undefined, wilaya, type }),
      });
      if (res.ok) {
        setSuccess(true);
        setFullName(""); setPhone(""); setEmail(""); setWilaya(""); setType("volunteer");
      } else {
        setErrorMsg(isArabic ? "فشل التسجيل، حاول مجدداً" : "Échec de l'inscription, réessayez");
      }
    } catch (err) {
      setErrorMsg(isArabic ? "خطأ في الاتصال بالخادم" : "Erreur de connexion");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="bg-zinc-900/50 border border-emerald-500/20 rounded-xl p-6 text-center space-y-4 shadow-lg" dir={isArabic ? "rtl" : "ltr"}>
        <div className="inline-flex p-3 bg-emerald-500/20 text-emerald-400 rounded-full">
          <CheckCircle className="h-10 w-10" />
        </div>
        <div className="inline-flex items-center gap-1 bg-emerald-950/30 border border-emerald-500/20 px-3 py-1 rounded-full text-emerald-400 text-[10px] font-bold">
          <BadgeCheck className="h-3.5 w-3.5" />
          {isArabic ? "قيد المراجعة" : "En cours d'examen"}
        </div>
        <h3 className="font-extrabold text-lg text-slate-100">
          {isArabic ? "تم استلام طلب التسجيل!" : "Demande reçue avec succès !"}
        </h3>
        <p className="text-sm text-slate-300 leading-relaxed max-w-sm mx-auto">
          {isArabic
            ? "سيقوم فريق الإدارة بمراجعة طلبك وإصدار رمز اعتماد خاص بك خلال 24 ساعة. سيتم إرسال الرمز عبر رسالة نصية أو اتصال هاتفي."
            : "L'équipe d'administration examinera votre demande et vous attribuera un code d'accréditation sous 24h. Vous serez notifié par SMS ou appel."}
        </p>
        <button onClick={() => setSuccess(false)}
          className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer">
          {isArabic ? "تسجيل متطوع آخر" : "Inscrire un autre volontaire"}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-lg space-y-4" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex items-center gap-2.5">
        <div className="p-2 bg-emerald-600/10 border border-emerald-500/20 rounded-lg text-emerald-400">
          <BadgeCheck className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-extrabold text-base text-slate-100">
            {isArabic ? "التسجيل كمتطوع ميداني" : "Devenir volontaire terrain"}
          </h3>
          <p className="text-[10px] text-gray-400">
            {isArabic
              ? "احصل على رمز اعتماد خاص بك لتوثيق بلاغاتك فورياً وجعلها موثوقة رسمياً"
              : "Obtenez votre code d'accréditation pour certifier vos signalements instantanément"}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input value={fullName} onChange={e => setFullName(e.target.value)} required
            placeholder={isArabic ? "الاسم الكامل *" : "Nom complet *"}
            className="w-full bg-black/50 border border-white/5 rounded-lg py-2.5 pl-10 pr-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 placeholder:text-gray-600" />
        </div>

        <div className="relative">
          <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input value={phone} onChange={e => setPhone(e.target.value)} required dir="ltr"
            placeholder={isArabic ? "رقم الهاتف * (مثال: 0550123456)" : "Téléphone * (ex: 0550123456)"}
            className="w-full bg-black/50 border border-white/5 rounded-lg py-2.5 pl-10 pr-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 placeholder:text-gray-600" />
        </div>

        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" dir="ltr"
            placeholder={isArabic ? "البريد الإلكتروني (اختياري)" : "Email (optionnel)"}
            className="w-full bg-black/50 border border-white/5 rounded-lg py-2.5 pl-10 pr-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 placeholder:text-gray-600" />
        </div>

        <div className="relative">
          <Shield className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <select value={type} onChange={e => setType(e.target.value as any)} required
            className="w-full bg-black/50 border border-white/5 rounded-lg py-2.5 pl-10 pr-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 appearance-none cursor-pointer">
            <option value="volunteer">{isArabic ? "نوع العضوية: متطوع ميداني" : "Type : Bénévole de terrain"}</option>
            <option value="official">{isArabic ? "نوع العضوية: جهة رسمية / هيئة وطنية" : "Type : Organisme officiel"}</option>
          </select>
        </div>

        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <select value={wilaya} onChange={e => setWilaya(e.target.value)} required
            className="w-full bg-black/50 border border-white/5 rounded-lg py-2.5 pl-10 pr-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 appearance-none cursor-pointer">
            <option value="">{isArabic ? "-- اختر ولاية *" : "-- Choisir Wilaya *"}</option>
            {WILAYAS_LIST.map((w, idx) => (
              <option key={idx} value={`${w.nameAr} (${w.nameFr})`}>{isArabic ? w.nameAr : w.nameFr}</option>
            ))}
          </select>
        </div>

        {errorMsg && (
          <p className="text-xs font-bold text-red-500 flex items-center gap-1.5 bg-red-500/5 py-2 px-3 rounded-lg border border-red-500/10">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{errorMsg}</span>
          </p>
        )}

        <button type="submit" disabled={isSubmitting}
          className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black tracking-wider uppercase shadow-lg shadow-emerald-600/10 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span>{isArabic ? "إرسال طلب التسجيل" : "Soumettre la demande"}</span>
        </button>

        <p className="text-[9px] text-gray-500 italic text-center leading-relaxed">
          {isArabic
            ? "بعد المراجعة، سيتم تخصيص رمز اعتماد خاص بك يمكنك استخدامه فوراً لتوثيق كل بلاغاتك الميدانية مستقبلاً."
            : "Après examen, un code d'accréditation personnel vous sera attribué pour certifier tous vos futurs signalements."}
        </p>
      </form>
    </div>
  );
}
