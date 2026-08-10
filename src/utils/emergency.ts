export interface EmergencyContact {
  countryAr: string;
  countryFr: string;
  labelAr: string;
  labelFr: string;
  phone: string;
  noteAr: string;
  noteFr: string;
  /** Provenance of the number, shown verbatim in the UI — the platform scope
   *  is the 5 Maghreb countries (explicit in the header panel subtitle). */
  sourceAr: string;
  sourceFr: string;
  /** Last point in time this list was checked against official publications. */
  verifiedAt: string;
}

// Official public emergency numbers per North-African country. The platform is
// pan-Maghreb (Algeria, Morocco, Tunisia, Libya, Mauritania), so no
// single-number claim is made: users pick the line matching their country
// (works offline, printed cards, and tel: dialers).
export const EMERGENCY_CONTACTS: EmergencyContact[] = [
  { countryAr: "الجزائر", countryFr: "Algérie", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "1021", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies", sourceAr: "الحماية المدنية الجزائرية", sourceFr: "Protection Civile algérienne", verifiedAt: "2024" },
  { countryAr: "الجزائر", countryFr: "Algérie", labelAr: "الرقم الأخضر للغابات", labelFr: "Garde Forestière", phone: "1070", noteAr: "لحوادث وزحف النيران", noteFr: "Feux de végétation", sourceAr: "الحماية المدنية الجزائرية", sourceFr: "Protection Civile algérienne", verifiedAt: "2024" },
  { countryAr: "المغرب", countryFr: "Maroc", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "150", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies", sourceAr: "الحماية المدنية المغربية", sourceFr: "Protection Civile marocaine", verifiedAt: "2024" },
  { countryAr: "تونس", countryFr: "Tunisie", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "198", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies", sourceAr: "الحماية المدنية التونسية", sourceFr: "Protection Civile tunisienne", verifiedAt: "2024" },
  { countryAr: "ليبيا", countryFr: "Libye", labelAr: "الطوارئ الموحدة (الدفاع المدني)", labelFr: "Urgences unifiées (Défense Civile)", phone: "1415", noteAr: "الرقم الموحد — يوجّه الإسعاف والشرطة والمطافئ", noteFr: "Numéro unifié — ambulance, police, pompiers", sourceAr: "وزارة الداخلية الليبية / مركز الاتصال المحلي 1415", sourceFr: "Ministère de l'Intérieur libyen / centre d'appel 1415", verifiedAt: "2025" },
  { countryAr: "موريتانيا", countryFr: "Mauritanie", labelAr: "الدفاع المدني", labelFr: "Défense Civile", phone: "101", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies", sourceAr: "الدفاع المدني الموريتاني", sourceFr: "Défense Civile mauritanienne", verifiedAt: "2024" },
];

// Keeps "0 km" claims out of the UI, and keeps emergency-scale precision:
// sub-kilometre reads "< 1 km", under 10 km keeps one decimal (3.4 km),
// larger distances round to the nearest km.
export function formatDistanceKm(km: number | null | undefined, isArabic: boolean): string {
  const unit = isArabic ? "كم" : "km";
  if (km === null || km === undefined || !Number.isFinite(km) || km < 0) return `— ${unit}`;
  if (km < 1) return `< 1 ${unit}`;
  if (km < 10) return `${km.toFixed(1)} ${unit}`;
  return `${Math.round(km)} ${unit}`;
}