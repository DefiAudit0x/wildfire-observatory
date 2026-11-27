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
 * Shortest distance (km) from a point to a polyline given as [lng, lat]
 * pairs (OSRM GeoJSON order). Every segment is measured, so a fire on the
 * road between two vertices — or exactly at the destination — is never
 * skipped. Empty route → Infinity; single point → point distance;
 * duplicate consecutive vertices → treated as that point.
 *
 * Equirectangular projection into local kilometres around the fire:
 * sub-metre error at these scales, far below the 2.5 km alert threshold
 * the evacuation page compares against.
 */
export function minDistanceToPolylineKm(route: [number, number][], lat: number, lng: number): number {
  if (route.length === 0) return Infinity;
  const R = 6371;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const toX = (lng2: number) => ((lng2 - lng) * Math.PI) / 180 * cosLat * R;
  const toY = (lat2: number) => ((lat2 - lat) * Math.PI) / 180 * R;
  const pointSegKm = (x1: number, y1: number, x2: number, y2: number): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(x1, y1);
    const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lenSq));
    return Math.hypot(x1 + t * dx, y1 + t * dy);
  };
  if (route.length === 1) return Math.hypot(toX(route[0][0]), toY(route[0][1]));
  let min = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const d = pointSegKm(toX(route[i][0]), toY(route[i][1]), toX(route[i + 1][0]), toY(route[i + 1][1]));
    if (d < min) min = d;
  }
  return min;
}

/**
 * Client-side mirror of the server's wilaya determination (server/geo.ts).
 * The server remains the authority (it rejects mismatched wilaya/coords),
 * this copy only powers early suggestions and pre-submit warnings in the UI.
 */

// Fix 36 (GEO-1): this file used to claim to mirror the server while doing
// neither half of what the server does — it narrowed Jijel/Skikda to remove
// overlaps AND resolved by first match, while the server keeps the overlaps
// and resolves by smallest containing rectangle (v2.15.0 audit fix). The two
// resolvers disagreed on real coordinates (e.g. (36.8, 6.3) → Skikda here,
// Jijel on the server). Bounds AND rule are now copied verbatim from
// server/geo.ts; any bounds change must land in both files.
export const OUT_OF_COVERAGE = "خارج التغطية (Hors zone)";

export const WILAYA_BOUNDS: { name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
  { name: "الجزائر - الطارف (Algérie - El Tarf)", minLat: 36.5, maxLat: 37.0, minLng: 8.0, maxLng: 8.6 },
  { name: "الجزائر - عنابة (Algérie - Annaba)", minLat: 36.7, maxLat: 37.0, minLng: 7.4, maxLng: 7.95 },
  { name: "الجزائر - سكيكدة (Algérie - Skikda)", minLat: 36.6, maxLat: 37.0, minLng: 6.2, maxLng: 7.5 },
  { name: "الجزائر - جيجل (Algérie - Jijel)", minLat: 36.5, maxLat: 36.9, minLng: 5.8, maxLng: 6.5 },
  { name: "الجزائر - بجاية (Algérie - Béjaïa)", minLat: 36.5, maxLat: 36.9, minLng: 4.6, maxLng: 5.4 },
  { name: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", minLat: 36.4, maxLat: 36.8, minLng: 3.8, maxLng: 4.55 },
  { name: "الجزائر - سوق أهراس (Algérie - Souk Ahras)", minLat: 36.0, maxLat: 36.5, minLng: 7.5, maxLng: 8.5 },
  { name: "تونس - جندوبة (Tunisie - Jendouba)", minLat: 36.3, maxLat: 36.9, minLng: 8.6, maxLng: 9.2 },
  { name: "تونس - بنزرت (Tunisie - Bizerte)", minLat: 37.0, maxLat: 37.5, minLng: 9.3, maxLng: 10.2 },
  { name: "تونس - تونس العاصمة (Tunisie - Tunis)", minLat: 36.5, maxLat: 37.2, minLng: 9.8, maxLng: 10.5 },
  { name: "تونس - سوسة (Tunisie - Sousse)", minLat: 35.6, maxLat: 36.2, minLng: 10.2, maxLng: 10.9 },
  { name: "تونس - صفاقس (Tunisie - Sfax)", minLat: 34.5, maxLat: 35.6, minLng: 10.3, maxLng: 11.2 },
  { name: "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan-Al Hoceïma)", minLat: 35.0, maxLat: 36.0, minLng: -6.0, maxLng: -4.5 },
  { name: "المغرب - الرباط سلا القنيطرة (Maroc - Rabat-Salé-Kénitra)", minLat: 33.5, maxLat: 34.8, minLng: -7.0, maxLng: -5.5 },
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
  // Fix 36 (GEO-1): smallest containing rectangle wins — copied verbatim
  // from server/geo.ts (strict < keeps the earlier entry on equal area).
  const containing = WILAYA_BOUNDS.filter((b) => pointInBounds(lat, lng, b));
  if (containing.length > 0) {
    const smallest = containing.reduce((best, b) => {
      const area = (b.maxLat - b.minLat) * (b.maxLng - b.minLng);
      const bestArea = (best.maxLat - best.minLat) * (best.maxLng - best.minLng);
      return area < bestArea ? b : best;
    });
    return smallest.name;
  }

  if (lng < -1.0 && lat > 27.0 && lat < 36.5) return "المغرب - منطقة أخرى (Maroc - Autre)";
  // Fix 36 (GEO-1): the server's Algeria band starts at lat > 18.0, not
  // >= 19.0 — the old threshold told lat 18–19 "out of coverage" while the
  // server would have called it "Algérie - Autre".
  if (lng >= -1.0 && lng <= 8.5 && lat > 18.0 && lat < 37.5) return "الجزائر - منطقة أخرى (Algérie - Autre)";
  if (lng > 8.5 && lng < 11.5 && lat > 30.0 && lat < 37.5) return "تونس - منطقة أخرى (Tunisie - Autre)";
  if (lng >= 11.5 && lat > 20.0 && lat < 33.5) return "ليبيا - منطقة أخرى (Libye - Autre)";

  return OUT_OF_COVERAGE;
}
