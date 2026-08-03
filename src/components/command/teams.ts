import { TrappedSOS } from "../../types";

export interface PredefinedTeam {
  id: string;
  type: "protection_civile" | "volunteers";
  teamNameAr: string;
  teamNameFr: string;
  emoji: string;
  color: string;
  baseLat: number;
  baseLng: number;
  offset: { dLat: number; dLng: number };
}

export interface TeamStatus extends PredefinedTeam {
  status: "available" | "en_route" | "on_site";
  currentLat: number;
  currentLng: number;
  arrived: boolean;
  remainingMin: number;
  assistedPerson: string | null;
  notes: string;
}

export const PREDEFINED_TEAMS: PredefinedTeam[] = [
  {
    id: "unit_1",
    type: "protection_civile",
    teamNameAr: "وحدة التدخل السريع - الحماية المدنية 1",
    teamNameFr: "Unité d'Intervention Rapide - Protection Civile 1",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.72,
    baseLng: 4.91,
    offset: { dLat: 0.025, dLng: -0.03 },
  },
  {
    id: "unit_2",
    type: "protection_civile",
    teamNameAr: "وحدة الدعم والإسناد - الحماية المدنية بجاية",
    teamNameFr: "Unité de Soutien - Protection Civile Béjaïa",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.75,
    baseLng: 5.06,
    offset: { dLat: 0.035, dLng: 0.02 },
  },
  {
    id: "unit_3",
    type: "protection_civile",
    teamNameAr: "وحدة الإطفاء والإنقاذ الجبلية",
    teamNameFr: "Unité Mobile de Lutte Contre les Feux de Forêt",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.68,
    baseLng: 5.22,
    offset: { dLat: -0.02, dLng: -0.035 },
  },
  {
    id: "vol_1",
    type: "volunteers",
    teamNameAr: "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة",
    teamNameFr: "Groupe Croissant Rouge Algérien - Secouristes",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.74,
    baseLng: 4.88,
    offset: { dLat: -0.03, dLng: 0.025 },
  },
  {
    id: "vol_2",
    type: "volunteers",
    teamNameAr: "رابطة المتطوعين والشباب المحلي للإغاثة",
    teamNameFr: "Association des Jeunes Volontaires Locaux",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.71,
    baseLng: 5.15,
    offset: { dLat: 0.015, dLng: -0.035 },
  },
  {
    id: "vol_3",
    type: "volunteers",
    teamNameAr: "فرقة الدراجات النارية الجبلية للمتطوعين",
    teamNameFr: "Brigade Moto Tout-Terrain des Volontaires",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.62,
    baseLng: 5.01,
    offset: { dLat: -0.025, dLng: 0.03 },
  },
];

export function getTeamNames(teamId: string): { nameAr: string; nameFr: string } {
  const team = PREDEFINED_TEAMS.find((t) => t.id === teamId);
  if (team) return { nameAr: team.teamNameAr, nameFr: team.teamNameFr };
  return { nameAr: teamId, nameFr: teamId };
}

export function getTeamStatusText(dispatchedAt: string | { seconds?: number } | undefined, isArabic: boolean): { text: string; arrived: boolean } {
  if (!dispatchedAt) {
    return { text: isArabic ? "في الطريق" : "En route", arrived: false };
  }
  let dispatchedTime = Date.now();
  if (typeof dispatchedAt === "string") {
    dispatchedTime = new Date(dispatchedAt).getTime();
  } else if (dispatchedAt && typeof dispatchedAt === "object" && (dispatchedAt as any).seconds) {
    dispatchedTime = (dispatchedAt as any).seconds * 1000;
  }
  if (isNaN(dispatchedTime)) dispatchedTime = Date.now();

  const elapsed = Date.now() - dispatchedTime;
  const duration = 2 * 60000; // 2 minutes journey
  if (elapsed >= duration) {
    return { text: isArabic ? "✓ وصلت للموقع" : "✓ Arrivée", arrived: true };
  }
  const remainingMin = Math.ceil((duration - elapsed) / 60000);
  return { text: isArabic ? `في الطريق (${remainingMin} د)` : `En route (~${remainingMin} min)`, arrived: false };
}

export function getTeamsStatusAndPositions(sosCalls: TrappedSOS[]): TeamStatus[] {
  return PREDEFINED_TEAMS.map((team) => {
    let activeSosAssisted: TrappedSOS | null = null;
    let dispatchInfo: any = null;

    for (const sos of sosCalls) {
      if (sos.status !== "active") continue;
      if (sos.dispatchedTeams && sos.dispatchedTeams.length > 0) {
        const found = sos.dispatchedTeams.find(
          (t) => t.teamNameFr === team.teamNameFr || t.teamNameAr === team.teamNameAr
        );
        if (found) {
          activeSosAssisted = sos;
          dispatchInfo = found;
          break;
        }
      }
    }

    if (activeSosAssisted && dispatchInfo) {
      let dispatchedTime = Date.now();
      if (dispatchInfo.dispatchedAt) {
        if (typeof dispatchInfo.dispatchedAt === "string") {
          dispatchedTime = new Date(dispatchInfo.dispatchedAt).getTime();
        } else if (typeof dispatchInfo.dispatchedAt === "object" && (dispatchInfo.dispatchedAt as any).seconds) {
          dispatchedTime = (dispatchInfo.dispatchedAt as any).seconds * 1000;
        } else {
          dispatchedTime = new Date(dispatchInfo.dispatchedAt).getTime();
        }
      }
      if (isNaN(dispatchedTime)) dispatchedTime = Date.now();

      const elapsed = Date.now() - dispatchedTime;
      const duration = 2 * 60000; // 2 minutes journey
      let progress = elapsed / duration;
      if (isNaN(progress)) progress = 0;
      progress = Math.min(1, Math.max(0, progress));

      const startLat = activeSosAssisted.lat + team.offset.dLat;
      const startLng = activeSosAssisted.lng + team.offset.dLng;

      const currentLat = startLat + (activeSosAssisted.lat - startLat) * progress;
      const currentLng = startLng + (activeSosAssisted.lng - startLng) * progress;

      const arrived = progress >= 1;
      const remainingMin = Math.ceil((duration - elapsed) / 60000);

      return {
        ...team,
        status: (arrived ? "on_site" : "en_route") as "available" | "en_route" | "on_site",
        currentLat,
        currentLng,
        arrived,
        remainingMin,
        assistedPerson: activeSosAssisted.name,
        notes: dispatchInfo.notes,
      };
    }

    return {
      ...team,
      status: "available" as const,
      currentLat: team.baseLat,
      currentLng: team.baseLng,
      arrived: false,
      remainingMin: 0,
      assistedPerson: null,
      notes: "",
    };
  });
}

export function getTeamStatusBadge(team: TeamStatus, isArabic: boolean): { indicator: string; text: string; badge: string } {
  if (team.status === "available") {
    return {
      indicator: "bg-emerald-500",
      text: isArabic ? "متاح في المقر" : "Disponible à la base",
      badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    };
  }
  if (team.status === "en_route") {
    return {
      indicator: "bg-amber-500 animate-pulse",
      text: isArabic ? `في الطريق لنجدة ${team.assistedPerson} (~${team.remainingMin} د)` : `En route chez ${team.assistedPerson} (~${team.remainingMin}m)`,
      badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    };
  }
  return {
    indicator: "bg-red-500 animate-pulse",
    text: isArabic ? `في الموقع ينجد ${team.assistedPerson}` : `Sur site avec ${team.assistedPerson}`,
    badge: "bg-red-500/10 text-red-400 border-red-500/20",
  };
}
