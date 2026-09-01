import { Report } from "../src/types.js";
import logger from "./logger.js";

/**
 * ARC-M09: the North-Africa admission bounds used to be declared independently
 * in reports.ts and sos.ts (drifting values were the audit's original finding).
 * This is the single canonical copy; both routes import it.
 */
export const NA_BOUNDS = { minLat: 19, maxLat: 38, minLng: -18, maxLng: 25 } as const;

/**
 * Phase 3: one canonical coordinate sanitizer for mission targets. SOS docs
 * historically accepted numeric STRINGS (the SOS schema is a union), and a
 * NaN/Infinity coordinate silently poisons every haversine it feeds. Anything
 * that is not a finite number (or a plain numeric string) degrades to null,
 * which callers must treat as "no verification possible" — never as 0,0.
 */
export function saneCoord(v: unknown): number | null {
  if (typeof v === "boolean" || v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function getHaversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

export function determineWilayaByCoords(lat: number, lng: number): string {
  // 1) Exact match against known bounds (most precise)
  const matched = WILAYA_BOUNDS.find((b) => pointInBounds(lat, lng, b));
  if (matched) return matched.name;

  // 2) Country-level fallback heuristic
  if (lng < -1.0 && lat > 27.0 && lat < 36.5) return "المغرب - منطقة أخرى (Maroc - Autre)";
  if (lng >= -1.0 && lng <= 8.5 && lat > 18.0 && lat < 37.5) return "الجزائر - منطقة أخرى (Algérie - Autre)";
  if (lng > 8.5 && lng < 11.5 && lat > 30.0 && lat < 37.5) return "تونس - منطقة أخرى (Tunisie - Autre)";
  if (lng >= 11.5 && lat > 20.0 && lat < 33.5) return "ليبيا - منطقة أخرى (Libye - Autre)";

  return "خارج التغطية (Hors zone)";
}

export function isInKnownWilaya(lat: number, lng: number): boolean {
  return WILAYA_BOUNDS.some((b) => pointInBounds(lat, lng, b));
}

const WILAYA_BOUNDS: { name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
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

function pointInBounds(lat: number, lng: number, bounds: typeof WILAYA_BOUNDS[0]): boolean {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
}

export function wilayaContainsCoords(wilaya: string, lat: number, lng: number): boolean {
  const bounds = WILAYA_BOUNDS.find((b) => b.name === wilaya);
  if (bounds) return pointInBounds(lat, lng, bounds);

  // Country-level coverage is not a wilaya geofence. Reject until precise
  // bounds or polygon data exists for the declared wilaya.
  logger.warn({ wilaya, lat, lng }, "Geofence rejected — wilaya bounds unavailable");
  return false;
}

export function runClustering(reports: Report[]): Report[] {
  const CLUSTER_THRESHOLD_KM = 3.0;
  const visited = new Set<string>();
  const result: Report[] = [];
  let nextClusterId = 1;

  for (let i = 0; i < reports.length; i++) {
    const rep = reports[i];
    if (visited.has(rep.id)) continue;

    const clusterId = `cluster-${nextClusterId++}`;
    const clusterMembers: Report[] = [rep];
    visited.add(rep.id);

    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < reports.length; j++) {
        const other = reports[j];
        if (visited.has(other.id)) continue;
        const nearCluster = clusterMembers.some((member) =>
          getHaversineDistance(member.lat, member.lng, other.lat, other.lng) <= CLUSTER_THRESHOLD_KM
        );
        if (nearCluster) {
          clusterMembers.push(other);
          visited.add(other.id);
          grew = true;
        }
      }
    }

    const sortedMembers = [...clusterMembers].sort((a, b) => {
      const aWeight = a.reporterType === "official" ? 3 : (a.reporterType === "volunteer" ? 2 : 1);
      const bWeight = b.reporterType === "official" ? 3 : (b.reporterType === "volunteer" ? 2 : 1);
      if (bWeight !== aWeight) return bWeight - aWeight;
      const sevOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
      const aSev = sevOrder[a.severity] || 0;
      const bSev = sevOrder[b.severity] || 0;
      if (bSev !== aSev) return bSev - aSev;
      if (b.consensusCount !== a.consensusCount) return b.consensusCount - a.consensusCount;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    const leaderId = sortedMembers[0].id;
    clusterMembers.forEach((member) => {
      result.push({
        ...member,
        clusterId,
        clusterSize: clusterMembers.length,
        isClusterLeader: member.id === leaderId,
      });
    });
  }

  return result;
}
