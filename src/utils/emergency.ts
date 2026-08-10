export interface EmergencyContact {
  countryAr: string;
  countryFr: string;
  labelAr: string;
  labelFr: string;
  phone: string;
  noteAr: string;
  noteFr: string;
}

// Official public emergency numbers per North-African country. The platform is
// pan-Maghreb, so no single-number claim is made: users pick the line matching
// their country (works offline, printed cards, and tel: dialers).
export const EMERGENCY_CONTACTS: EmergencyContact[] = [
  { countryAr: "الجزائر", countryFr: "Algérie", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "1021", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies" },
  { countryAr: "الجزائر", countryFr: "Algérie", labelAr: "الرقم الأخضر للغابات", labelFr: "Garde Forestière", phone: "1070", noteAr: "لحوادث وزحف النيران", noteFr: "Feux de végétation" },
  { countryAr: "المغرب", countryFr: "Maroc", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "150", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies" },
  { countryAr: "تونس", countryFr: "Tunisie", labelAr: "الحماية المدنية", labelFr: "Protection Civile", phone: "198", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies" },
  { countryAr: "ليبيا", countryFr: "Libye", labelAr: "الدفاع المدني", labelFr: "Défense Civile", phone: "141", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies" },
  { countryAr: "موريتانيا", countryFr: "Mauritanie", labelAr: "الدفاع المدني", labelFr: "Défense Civile", phone: "101", noteAr: "للطوارئ والحرائق", noteFr: "Urgences et incendies" },
];

// Keeps "0 km" claims out of the UI: any sub-kilometre distance reads "< 1".
export function formatDistanceKm(km: number | null | undefined, isArabic: boolean): string {
  const unit = isArabic ? "كم" : "km";
  if (km === null || km === undefined || !Number.isFinite(km) || km < 0) return `— ${unit}`;
  if (km < 1) return `< 1 ${unit}`;
  return `${Math.round(km)} ${unit}`;
}