export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}

/**
 * Client-side mirror of the server's wilaya determination (server/geo.ts).
 * The server remains the authority (it rejects mismatched wilaya/coords),
 * this copy only powers early suggestions and pre-submit warnings in the UI.
 */
export const OUT_OF_COVERAGE = "خارج التغطية (Hors zone)";

// ARC-L12: the arrays below previously overlapped on purpose-but-silently:
// Skikda∩Annaba (lng 7.4–7.5), Skikda∩Jijel (lng 6.2–6.5) — the FIRST match in
// this array silently won (find()). The lower-priority bounds were narrowed to
// remove every overlap while keeping the RESOLVED wilaya byte-identical for
// any coordinate (Annaba already won 7.4–7.5 because it precedes Skikda;
// Skikda already won 6.2–6.5 because it precedes Jijel). Resolution contract:
// scan order = priority; the server (server/geo.ts) remains the authority.
const WILAYA_BOUNDS: { name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
  { name: "الجزائر - الطارف (Algérie - El Tarf)", minLat: 36.5, maxLat: 37.0, minLng: 8.0, maxLng: 8.6 },
  { name: "الجزائر - عنابة (Algérie - Annaba)", minLat: 36.7, maxLat: 37.0, minLng: 7.4, maxLng: 7.95 },
  { name: "الجزائر - سكيكدة (Algérie - Skikda)", minLat: 36.6, maxLat: 37.0, minLng: 6.2, maxLng: 7.4 },
  { name: "الجزائر - جيجل (Algérie - Jijel)", minLat: 36.5, maxLat: 36.9, minLng: 5.8, maxLng: 6.2 },
  { name: "الجزائر - بجاية (Algérie - Béjaïa)", minLat: 36.5, maxLat: 36.9, minLng: 4.6, maxLng: 5.4 },
  { name: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", minLat: 36.4, maxLat: 36.8, minLng: 3.8, maxLng: 4.55 },
  { name: "الجزائر - سوق أهراس (Algérie - Souk Ahras)", minLat: 36.0, maxLat: 36.5, minLng: 7.5, maxLng: 8.5 },
  { name: "تونس - جندوبة (Tunisie - Jendouba)", minLat: 36.3, maxLat: 36.9, minLng: 8.6, maxLng: 9.2 },
  { name: "تونس - بنزرت (Tunisie - Bizerte)", minLat: 37.0, maxLat: 37.5, minLng: 9.3, maxLng: 10.2 },
  { name: "تونس - تونس العاصمة (Tunisie - Tunis)", minLat: 36.5, maxLat: 37.2, minLng: 9.8, maxLng: 10.5 },
  { name: "تونس - سوسة (Tunisie - Sousse)", minLat: 35.6, maxLat: 36.2, minLng: 10.2, maxLng: 10.9 },
  { name: "تونس - صفاقس (Tunisie - Sfax)", minLat: 34.5, maxLat: 35.6, minLng: 10.3, maxLng: 11.2 },
  { name: "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)", minLat: 35.0, maxLat: 36.0, minLng: -6.0, maxLng: -4.5 },
  { name: "المغرب - الرباط سلا القنيطرة (Maroc - Rabat-Salé)", minLat: 33.5, maxLat: 34.8, minLng: -7.0, maxLng: -5.5 },
  { name: "المغرب - مراكش آسفي (Maroc - Marrakech-Safi)", minLat: 31.0, maxLat: 33.5, minLng: -9.0, maxLng: -7.0 },
  { name: "المغرب - سوس ماسة (Maroc - Souss-Massa)", minLat: 29.5, maxLat: 31.5, minLng: -10.0, maxLng: -8.0 },
  { name: "ليبيا - الجبل الأخضر (Libye - Al Jabal al Akhdar)", minLat: 32.0, maxLat: 33.0, minLng: 21.0, maxLng: 22.5 },
  { name: "ليبيا - بنغازي (Libye - Benghazi)", minLat: 31.5, maxLat: 32.5, minLng: 19.5, maxLng: 21.0 },
  { name: "ليبيا - طرابلس (Libye - Tripoli)", minLat: 32.5, maxLat: 33.5, minLng: 12.5, maxLng: 14.0 },
  { name: "ليبيا - سرت (Libye - Sirte)", minLat: 30.0, maxLat: 32.0, minLng: 16.0, maxLng: 18.5 },
  { name: "ليبيا - سبها (Libye - Sabha)", minLat: 25.0, maxLat: 28.0, minLng: 13.0, maxLng: 16.0 },
  { name: "ليبيا - الكفرة (Libye - Al Kufra)", minLat: 22.0, maxLat: 25.0, minLng: 20.0, maxLng: 24.0 },
];

function pointInBounds(lat: number, lng: number, bounds: (typeof WILAYA_BOUNDS)[0]): boolean {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
}

export function determineWilayaByCoords(lat: number, lng: number): string {
  const matched = WILAYA_BOUNDS.find((b) => pointInBounds(lat, lng, b));
  if (matched) return matched.name;

  if (lng < -1.0 && lat > 27.0 && lat < 36.5) return "المغرب - منطقة أخرى (Maroc - Autre)";
  // ARC-M25 fix: this mirror accepted lat > 18.0 while BOTH the report form
  // gate and the server geofence require lat >= 19 — a GPS fix in [18,19) was
  // told "covered" then rejected on submit. The envelope is aligned to the
  // server bounds (19..38 / -18..25) so no layer promises what another rejects.
  if (lng >= -1.0 && lng <= 8.5 && lat >= 19.0 && lat < 37.5) return "الجزائر - منطقة أخرى (Algérie - Autre)";
  if (lng > 8.5 && lng < 11.5 && lat > 30.0 && lat < 37.5) return "تونس - منطقة أخرى (Tunisie - Autre)";
  if (lng >= 11.5 && lat > 20.0 && lat < 33.5) return "ليبيا - منطقة أخرى (Libye - Autre)";

  return OUT_OF_COVERAGE;
}
