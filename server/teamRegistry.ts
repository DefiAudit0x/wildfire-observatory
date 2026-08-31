import logger from "./logger.js";
import { docMergeSet } from "./fs.js";
import { getHaversineDistance } from "./geo.js";

/**
 * Live registry of field-team member positions.
 *
 * Design (mirrors the citizen heartbeat registry in routes/command.ts, with
 * the upgrades Team Mode needs):
 *  - Positions live in process memory — GPS streams are high-volume and
 *    low-value-per-write; persisting every 15s ping to Firestore would burn
 *    ~5.7k writes/member/day for data that is stale the moment it lands.
 *  - A THROTTLED DURABLE SNAPSHOT (at most one write per member per 5 min)
 *    lands in teamMembers/{id} so a process restart recovers the last known
 *    position instead of losing the whole map mid-operation.
 *  - Entries expire from memory 30 min after the last heartbeat; `online`
 *    is computed on read (heartbeat window 90s) — never stored.
 *  - A short breadcrumb trail (last 50 points) gives the command map a
 *    recent-path line without history storage.
 *
 * Multi-instance note: like the citizen registry, this map is per-process.
 * The deployment runs a single server instance (fly.toml); if that changes,
 * the registry must move to a shared store BEFORE fan-out grows.
 */

export interface TeamPositionPoint {
  lat: number;
  lng: number;
  t: number;
}

export interface TeamMemberPosition {
  memberId: string;
  teamId: string;
  name: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  batteryPct: number | null;
  lastSeen: number;
  trail: TeamPositionPoint[];
}

interface RegistryEntry extends TeamMemberPosition {
  lastSnapshotAt: number;
}

const ONLINE_WINDOW_MS = 90 * 1000;
const EVICTION_MS = 30 * 60 * 1000;
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const TRAIL_MAX_POINTS = 50;
const TRAIL_MIN_GAP_MS = 10 * 1000;
const TRAIL_MIN_MOVE_M = 20;

const registry = new Map<string, RegistryEntry>();

export function isOnline(lastSeen: number, now = Date.now()): boolean {
  return now - lastSeen <= ONLINE_WINDOW_MS;
}

export interface HeartbeatInput {
  memberId: string;
  teamId: string;
  name: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  batteryPct?: number | null;
  now?: number;
}

/** Records one heartbeat. Returns the stored position snapshot. */
export function recordHeartbeat(input: HeartbeatInput): TeamMemberPosition {
  const now = input.now ?? Date.now();
  const existing = registry.get(input.memberId);
  const trail: TeamPositionPoint[] = existing ? [...existing.trail] : [];

  const lastPoint = trail.at(-1);
  const movedM = lastPoint ? getHaversineDistance(lastPoint.lat, lastPoint.lng, input.lat, input.lng) * 1000 : Infinity;
  if (!lastPoint || movedM >= TRAIL_MIN_MOVE_M || now - lastPoint.t >= TRAIL_MIN_GAP_MS) {
    trail.push({ lat: input.lat, lng: input.lng, t: now });
    if (trail.length > TRAIL_MAX_POINTS) trail.splice(0, trail.length - TRAIL_MAX_POINTS);
  }

  const entry: RegistryEntry = {
    memberId: input.memberId,
    teamId: input.teamId,
    name: input.name,
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy ?? null,
    heading: input.heading ?? null,
    speed: input.speed ?? null,
    batteryPct: input.batteryPct ?? null,
    lastSeen: now,
    trail,
    lastSnapshotAt: existing?.lastSnapshotAt ?? 0,
  };
  registry.set(input.memberId, entry);
  return toPublic(entry);
}

function toPublic(entry: RegistryEntry): TeamMemberPosition {
  const { lastSnapshotAt, ...publicPart } = entry;
  void lastSnapshotAt;
  return publicPart;
}

/**
 * Firestore snapshot, at most one write per member per SNAPSHOT_MIN_INTERVAL_MS.
 * Fire-and-forget: GPS must never block on, or fail with, the durable layer.
 *
 * ARC-R1: this MUST stay a MERGE write. A full-replacement docSet here raced
 * a dispatcher's member removal (snapshot lands after active:false → removal
 * silently undone, device back on the map) and wiped the join-time audit
 * binding (principal, joinedAt, rejoinCount) every 5 minutes of heartbeating.
 * The payload deliberately carries NO authority fields — only display data.
 */
export function snapshotIfDue(memberId: string, teamId: string, now = Date.now()): void {
  const entry = registry.get(memberId);
  if (!entry) return;
  if (now - entry.lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) return;
  entry.lastSnapshotAt = now;
  void docMergeSet("teamMembers", memberId, {
    memberId,
    teamId,
    name: entry.name,
    lastKnownLat: entry.lat,
    lastKnownLng: entry.lng,
    lastSeenAt: entry.lastSeen,
  }).catch((err) => logger.warn({ err, memberId }, "Team position snapshot failed"));
}

/** Removes a member (leave/deactivation) from the live layer. */
export function removeMember(memberId: string): void {
  registry.delete(memberId);
}

export interface TeamPositionsQuery {
  teamId?: string;
  now?: number;
}

/** Live snapshot for the command center; stale entries are pruned on read. */
export function listPositions(query: TeamPositionsQuery = {}): TeamMemberPosition[] {
  const now = query.now ?? Date.now();
  const out: TeamMemberPosition[] = [];
  for (const [memberId, entry] of registry) {
    if (now - entry.lastSeen > EVICTION_MS) {
      registry.delete(memberId);
      continue;
    }
    if (query.teamId && entry.teamId !== query.teamId) continue;
    out.push(toPublic(entry));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Test/ops hook: clears the registry entirely. */
export function clearRegistry(): void {
  registry.clear();
}
