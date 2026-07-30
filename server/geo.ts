import { Report } from "../src/types.js";

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
  if (lng < -1.0) {
    if (lat > 34.5) return "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)";
    if (lat > 33.5) return "المغرب - الرباط سلا القنيطرة (Maroc - Rabat-Salé)";
    if (lat > 31.5) return "المغرب - مراكش آسفي (Maroc - Marrakech-Safi)";
    return "المغرب - سوس ماسة (Maroc - Souss-Massa)";
  }
  if (lng > 8.5 && lng < 11.5 && lat > 30.0 && lat < 37.5) {
    if (lat > 37.0) {
      if (lng > 10.0) return "تونس - تونس العاصمة (Tunisie - Tunis)";
      return "تونس - بنزرت (Tunisie - Bizerte)";
    }
    if (lat > 36.0) return "تونس - جندوبة (Tunisie - Jendouba)";
    if (lat > 35.0) return "تونس - سوسة (Tunisie - Sousse)";
    return "تونس - صفاقس (Tunisie - Sfax)";
  }
  if (lng >= 11.5 && lat > 20.0 && lat < 33.0) {
    if (lat > 32.0) {
      if (lng > 21.0) return "ليبيا - الجبل الأخضر (Libye - Al Jabal al Akhdar)";
      if (lng > 20.0) return "ليبيا - بنغازي (Libye - Benghazi)";
      return "ليبيا - طرابلس (Libye - Tripoli)";
    }
    if (lat > 30.0) return "ليبيا - سرت (Libye - Sirte)";
    if (lat > 25.0) return "ليبيا - سبها (Libye - Sabha)";
    return "ليبيا - الكفرة (Libye - Al Kufra)";
  }
  if (lat < 36.5) {
    if (lng > 7.7) return "الجزائر - سوق أهراس (Algérie - Souk Ahras)";
    if (lng > 6.0) return "الجزائر - جيجل (Algérie - Jijel)";
    return "الجزائر - بجاية (Algérie - Béjaïa)";
  }
  if (lng > 8.0) return "الجزائر - الطارف (Algérie - El Tarf)";
  if (lng > 7.4 && lng <= 7.8) return "الجزائر - عنابة (Algérie - Annaba)";
  if (lng < 4.5) return "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)";
  if (lng < 6.2) return "الجزائر - بجاية (Algérie - Béjaïa)";
  return "الجزائر - سكيكدة (Algérie - Skikda)";
}

const WILAYA_BOUNDS: { name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
  { name: "الجزائر - الطارف (Algérie - El Tarf)", minLat: 36.5, maxLat: 37.0, minLng: 7.8, maxLng: 8.8 },
  { name: "الجزائر - عنابة (Algérie - Annaba)", minLat: 36.7, maxLat: 37.0, minLng: 7.4, maxLng: 8.0 },
  { name: "الجزائر - سكيكدة (Algérie - Skikda)", minLat: 36.6, maxLat: 37.0, minLng: 6.2, maxLng: 7.5 },
  { name: "الجزائر - جيجل (Algérie - Jijel)", minLat: 36.5, maxLat: 36.9, minLng: 5.8, maxLng: 6.5 },
  { name: "الجزائر - بجاية (Algérie - Béjaïa)", minLat: 36.5, maxLat: 36.9, minLng: 4.5, maxLng: 6.0 },
  { name: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", minLat: 36.4, maxLat: 36.8, minLng: 3.8, maxLng: 4.8 },
  { name: "الجزائر - سوق أهراس (Algérie - Souk Ahras)", minLat: 36.0, maxLat: 36.5, minLng: 7.5, maxLng: 8.5 },
  { name: "تونس - جندوبة (Tunisie - Jendouba)", minLat: 36.3, maxLat: 36.9, minLng: 8.3, maxLng: 9.2 },
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
  if (!bounds) return true;
  return pointInBounds(lat, lng, bounds);
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

    for (let j = i + 1; j < reports.length; j++) {
      const other = reports[j];
      if (visited.has(other.id)) continue;
      const dist = getHaversineDistance(rep.lat, rep.lng, other.lat, other.lng);
      if (dist <= CLUSTER_THRESHOLD_KM) {
        clusterMembers.push(other);
        visited.add(other.id);
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
