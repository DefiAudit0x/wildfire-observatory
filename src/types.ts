export interface Report {
  id: string;
  lat: number;
  lng: number;
  locationName: string;
  wilaya: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'verified' | 'rejected' | 'resolved';
  image?: string; // Base64 image
  reporterName?: string;
  reporterPhone?: string;
  reporterType?: 'citizen' | 'volunteer' | 'official';
  reporterBadgeCode?: string;
  deviceId?: string;
  timestamp: string;
  aiVerification?: {
    isVerified: boolean;
    confidence: number;
    detectedSigns: string[];
    aiComments: string;
    suggestedSeverity: string;
  };
  consensusCount: number; // how many people confirmed this
  clusterId?: string;
  clusterSize?: number;
  isClusterLeader?: boolean;
  handlingTeamAr?: string;
  handlingTeamFr?: string;
  resolutionNotes?: string;
  resolvedAt?: string;
  resolvedOutcome?: 'extinguished' | 'contained' | 'evacuated' | 'false_alarm' | string;
}

export interface SatelliteHotspot {
  id: string;
  lat: number;
  lng: number;
  brightness: number; // in Kelvin
  confidence: number; // 0 - 100
  scanTime: string;
  satellite: 'MODIS' | 'VIIRS';
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
  audioUrl?: string; // Base64 audio or playable URL of recorded voice distress call
  audioDuration?: number; // duration in seconds
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
