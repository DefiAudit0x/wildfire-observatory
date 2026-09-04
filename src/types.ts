// ARC-M13: the severity and reporter-type vocabularies are derived from the
// dataset validators (the single owner of the report wire contract) instead of
// re-declared here — a new enum value now lands in one place.
import type { ReportSeverity, ReporterType } from "./utils/datasetValidators";

export interface Report {
  id: string;
  lat: number;
  lng: number;
  locationName: string;
  wilaya: string;
  description: string;
  severity: ReportSeverity;
  status: 'pending' | 'verified' | 'rejected' | 'resolved';
  image?: string; // Base64 image — OUTGOING (submission) only; the wire never carries it (S-H2)
  hasImage?: boolean; // S-H2: photo exists server-side — fetch /api/reports/:id/image
  reporterName?: string;
  reporterPhone?: string;
  reporterType?: ReporterType;
  reporterBadgeCode?: string;
  clientGeneratedId?: string;
  timestamp: string;
  aiVerification?: {
    isVerified: boolean;
    confidence: number;
    detectedSigns: string[];
    aiComments: string;
    suggestedSeverity: string;
  };
  consensusCount: number; // how many people confirmed this
  communityConfirmed?: boolean; // v2.15.0: community threshold reached — distinct from operator/badge verified
  clusterId?: string;
  clusterSize?: number;
  isClusterLeader?: boolean;
}

export interface SatelliteHotspot {
  id: string;
  lat: number;
  lng: number;
  brightness: number; // in Kelvin
  confidence: number; // 0 - 100
  scanTime: string;
  satellite: 'MODIS' | 'VIIRS' | 'MODIS/VIIRS' | 'VIIRS/MODIS';
  wilaya: string;
}

export interface WilayaStatus {
  nameAr: string;
  nameFr: string;
  activeFires: number;
  satelliteHotspots: number;
  severity: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  evacuationRecommended: boolean;
  emergencyPhone: string;
}

export type Language = 'ar' | 'fr';

export type TabId =
  | 'home'
  | 'map'
  | 'report'
  | 'guides'
  | 'radar'
  | 'admin'
  | 'volunteer'
  | 'command'
  | 'evac'
  | 'roster'
  | 'team';

export type TabIdOrEmpty = TabId | '';

export interface EmergencyCenter {
  nameAr: string;
  nameFr: string;
  phone: string;
  locationAr: string;
  locationFr: string;
}

export interface BadgeCode {
  code: string;
  ownerName: string;
  type: 'official' | 'volunteer';
  wilaya: string;
  phone?: string;
  createdAt: string;
  isActive: boolean;
}

export interface VolunteerRegistration {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  wilaya: string;
  type: 'volunteer' | 'official';
  idNumber?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  assignedCode?: string;
}

export interface Notification {
  id: string;
  deviceId: string;
  titleAr: string;
  titleFr: string;
  bodyAr: string;
  bodyFr: string;
  type: 'success' | 'warning' | 'error' | 'info';
  timestamp: string;
  read: boolean;
}

export interface TrappedSOS {
  id: string;
  deviceId: string;
  lat: number;
  lng: number;
  name: string;
  phone?: string;
  audioUrl?: string;
  audioDuration?: number;
  hasAudio?: boolean;
  status: 'active' | 'resolved';
  timestamp: string;
  dispatchedTeams?: {
    type: 'protection_civile' | 'volunteers';
    teamNameAr: string;
    teamNameFr: string;
    dispatchedAt: string;
    status: 'en_route' | 'arrived' | 'completed';
    notes?: string;
  }[];
}
