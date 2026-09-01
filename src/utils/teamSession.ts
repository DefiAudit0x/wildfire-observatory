/**
 * Phase 2 — team-member session client.
 *
 * One module owning every team-member HTTP call (join, session probe,
 * heartbeat, mission phase, leave) plus the persisted session state and the
 * native (Android FGS) tracking bridge. Kept DOM-light and dependency-free so
 * every rule is unit-testable: the ONLY thing this module does is talk to the
 * hardened /api/teams endpoints and classify their verdicts.
 *
 * Custody decisions (documented in ARCHITECTURE.md §5.4):
 *  - The 12h team token lives in sessionStorage (dies with the tab) — never
 *    localStorage, never a cookie. XSS in a citizen tab cannot reach a team
 *    token it does not share a tab with; closing the panel ends the custody.
 *  - On Android the token is handed to the native FGS through the origin-
 *    gated bridge ONCE at start; the native side keeps it in memory only.
 */

export interface TeamMissionState {
  sosId: string;
  phase: string;
  since: number;
}

export interface TeamSessionState {
  token: string;
  memberId: string;
  teamId: string;
  teamName: string;
  teamNameAr: string;
  name: string;
}

export type TeamFatalCode =
  | "AUTH" // 401 — token unverifiable/expired
  | "MEMBER_INVALID" // membership record gone / cross-team
  | "MEMBER_INACTIVE" // dispatcher deactivated the membership
  | "MEMBER_REVOKED" // token predates the member's current tokenGen
  | "TEAM_INACTIVE"; // dispatcher deactivated the team

export type TeamVerdict =
  | { ok: true; mission: TeamMissionState | null; heartbeatIntervalMs?: number }
  | { ok: false; fatal?: TeamFatalCode; transient?: boolean; message?: string };

const TEAM_SESSION_KEY = "observatory_team_session";
const REQUEST_CEILING_MS = 15_000; // house ceiling (adminApi, W7)
const DEFAULT_HEARTBEAT_MS = 15_000;
export const MIN_HEARTBEAT_MS = 10_000;
export const MAX_HEARTBEAT_MS = 60_000;

/**
 * Dual-env safe storage access (house pattern from utils/device.ts): this
 * module's logic tests run in BOTH jsdom and node environments, and a worker
 * / SSR context legitimately has no sessionStorage. Absent storage simply
 * means the session lives in memory for this page load only.
 */
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

// ========================
// SESSION PERSISTENCE (sessionStorage — tab-scoped)
// ========================

export function loadTeamSession(): TeamSessionState | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const raw = store.getItem(TEAM_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TeamSessionState>;
    if (
      typeof parsed?.token !== "string" || !parsed.token ||
      typeof parsed?.memberId !== "string" || !parsed.memberId ||
      typeof parsed?.teamId !== "string" || !parsed.teamId
    ) {
      return null;
    }
    return {
      token: parsed.token,
      memberId: parsed.memberId,
      teamId: parsed.teamId,
      teamName: typeof parsed.teamName === "string" ? parsed.teamName : "",
      teamNameAr: typeof parsed.teamNameAr === "string" ? parsed.teamNameAr : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
    };
  } catch {
    return null;
  }
}

export function saveTeamSession(session: TeamSessionState): void {
  try {
    sessionStore()?.setItem(TEAM_SESSION_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable — the session lives in memory for this page only
  }
}

export function clearTeamSession(): void {
  try {
    sessionStore()?.removeItem(TEAM_SESSION_KEY);
  } catch {
    // nothing to clear
  }
}

// ========================
// HTTP
// ========================

/**
 * Single team-member fetch: JSON body, Bearer team token when present,
 * same-origin credentials (join needs the public-principal cookie; the global
 * CSRF guard accepts same-origin Origin headers), and the 15s house ceiling.
 */
async function teamFetch(url: string, method: string, body?: unknown, token?: string): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_CEILING_MS)
      : undefined;
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
}

function fatalFromStatus(status: number, body: any): TeamFatalCode | null {
  const code = typeof body?.code === "string" ? body.code : "";
  if (status === 401) return "AUTH";
  // Only the 401/403 gate chain decides session death. A 400 (e.g. a GPS
  // glitch producing out-of-coverage coordinates) or a 429/5xx must NEVER
  // clear the session — re-joining burns the join-code budget (Round B).
  if (status !== 403) return null;
  if (code === "MEMBER_REVOKED") return "MEMBER_REVOKED";
  if (code === "MEMBER_INACTIVE") return "MEMBER_INACTIVE";
  if (code === "MEMBER_INVALID") return "MEMBER_INVALID";
  if (code === "TEAM_INACTIVE") return "TEAM_INACTIVE";
  return "AUTH";
}

function normalizeMission(raw: any): TeamMissionState | null {
  if (!raw || typeof raw.sosId !== "string" || !raw.sosId || raw.phase === "cleared") return null;
  return {
    sosId: raw.sosId,
    phase: raw.phase === "on_scene" ? "on_scene" : "en_route",
    since: Number(raw.since) || 0,
  };
}

/**
 * F3 (A2/P2/S5): parse the mission JSON string that rides the native FGS
 * `beat` events. The native side quotes the raw server substring once
 * (JSONObject.quote) so it crosses the JS boundary as a STRING; this function
 * JSON.parses it and runs it through the SAME field allow-list as every
 * server response — extra or hostile fields can only fail to parse, never
 * execute, and a malformed payload degrades to "no mission" instead of
 * crashing the panel.
 */
export function normalizeNativeMission(missionJson: string | null | undefined): TeamMissionState | null {
  if (typeof missionJson !== "string" || !missionJson) return null;
  try {
    return normalizeMission(JSON.parse(missionJson));
  } catch {
    return null;
  }
}

export function clampHeartbeatInterval(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_HEARTBEAT_MS;
  return Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, Math.round(n)));
}

export interface JoinResult {
  ok: boolean;
  message?: string;
  session?: TeamSessionState;
  mission?: TeamMissionState | null;
  heartbeatIntervalMs?: number;
}

/** POST /api/teams/join — redeem a join code. Public + rate-limited server-side. */
export async function joinTeam(code: string, name: string): Promise<JoinResult> {
  let res: Response;
  try {
    res = await teamFetch("/api/teams/join", "POST", { code, name });
  } catch {
    return { ok: false, message: "network" };
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    return { ok: false, message: typeof body?.error === "string" ? body.error : "join-failed" };
  }
  const session: TeamSessionState = {
    token: String(body.token || ""),
    memberId: String(body.memberId || ""),
    teamId: String(body.teamId || ""),
    teamName: String(body.teamName || ""),
    teamNameAr: String(body.teamNameAr || ""),
    name: String(body.name || name),
  };
  if (!session.token || !session.memberId || !session.teamId) {
    return { ok: false, message: "join-failed" };
  }
  return {
    ok: true,
    session,
    mission: normalizeMission(body.mission),
    heartbeatIntervalMs: clampHeartbeatInterval(body.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS),
  };
}

export interface ProbeResult {
  ok: boolean;
  fatal?: TeamFatalCode;
  mission?: TeamMissionState | null;
  teamName?: string;
  teamNameAr?: string;
  name?: string;
  heartbeatIntervalMs?: number;
}

/** POST /api/teams/session — validate a persisted token and restore state. */
export async function probeTeamSession(token: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await teamFetch("/api/teams/session", "POST", undefined, token);
  } catch {
    // Network hiccup on resume is NOT a verdict — keep the session, retry later.
    return { ok: false, fatal: undefined, heartbeatIntervalMs: DEFAULT_HEARTBEAT_MS };
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    return { ok: false, fatal: fatalFromStatus(res.status, body) ?? undefined };
  }
  return {
    ok: true,
    mission: normalizeMission(body.mission),
    teamName: String(body.teamName || ""),
    teamNameAr: String(body.teamNameAr || ""),
    name: String(body.name || ""),
    heartbeatIntervalMs: clampHeartbeatInterval(body.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS),
  };
}

/**
 * POST /api/teams/heartbeat — one GPS beat. Verdict mapping:
 *  - 200 → ok (mission may flip en_route→on_scene from the server view too)
 *  - 401/403 → fatal (the gate chain decided the session is dead)
 *  - 429 / 5xx / transport → transient (keep the session, retry next tick)
 */
export async function sendTeamHeartbeat(
  token: string,
  fix: { lat: number; lng: number; accuracy?: number | null; heading?: number | null; speed?: number | null }
): Promise<TeamVerdict> {
  let res: Response;
  try {
    res = await teamFetch("/api/teams/heartbeat", "POST", {
      lat: fix.lat,
      lng: fix.lng,
      ...(fix.accuracy != null ? { accuracy: fix.accuracy } : {}),
      ...(fix.heading != null ? { heading: fix.heading } : {}),
      ...(fix.speed != null ? { speed: fix.speed } : {}),
    }, token);
  } catch {
    return { ok: false, transient: true };
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) return { ok: false, transient: true };
    const fatal = fatalFromStatus(res.status, body);
    if (fatal) return { ok: false, fatal, message: body?.error };
    // 400-class: the payload was rejected — keep the session, the next fix
    // will almost certainly be valid. Never a verdict.
    return { ok: false, transient: true };
  }
  return {
    ok: true,
    mission: normalizeMission(body.mission),
    heartbeatIntervalMs: clampHeartbeatInterval(body.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS),
  };
}

export interface PhaseResult {
  ok: boolean;
  code?: "NO_ACTIVE_MISSION" | "not-joined" | "transient" | "fatal";
  fatal?: TeamFatalCode;
  mission?: TeamMissionState | null;
}

/** POST /api/teams/mission/phase — the only field-flippable phase: on_scene. */
export async function flipMissionOnScene(token: string): Promise<PhaseResult> {
  let res: Response;
  try {
    res = await teamFetch("/api/teams/mission/phase", "POST", { phase: "on_scene" }, token);
  } catch {
    return { ok: false, code: "transient" };
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    if (res.status === 409) return { ok: false, code: "NO_ACTIVE_MISSION" };
    if (res.status === 429 || res.status >= 500) return { ok: false, code: "transient" };
    const fatal = fatalFromStatus(res.status, body);
    if (fatal) return { ok: false, code: "fatal", fatal };
    return { ok: false, code: "transient" };
  }
  return { ok: true, mission: normalizeMission(body.mission) };
}

export interface LeaveResult {
  ok: boolean;
  transient?: boolean;
}

/** POST /api/teams/leave — member opts out. */
export async function leaveTeam(token: string): Promise<LeaveResult> {
  let res: Response;
  try {
    res = await teamFetch("/api/teams/leave", "POST", undefined, token);
  } catch {
    return { ok: false, transient: true };
  }
  // 401/403 still means "no longer a member" locally: clear the session either way.
  return { ok: res.ok || res.status === 401 || res.status === 403 };
}

// ========================
// NATIVE (ANDROID FGS) BRIDGE
// ========================

/**
 * The Android WebView exposes window.AndroidBridge (origin-gated natively).
 * Phase 2 adds the team-tracking surface: the panel hands the FGS its config
 * ONCE; from then on the native service owns GPS + beats and survives
 * backgrounding/screen-off — something the WebView JS loop cannot do
 * (Android suspends WebView timers when the app is backgrounded).
 */
export interface TeamTrackingBridge {
  isTeamTrackingSupported(): boolean;
  teamTrackingPrerequisite?(): string;
  /** F4 (A3/P3): optional so older bridge builds stay feature-detected. */
  isTeamTrackingActive?(): boolean;
  startTeamTracking(configJson: string): boolean;
  stopTeamTracking(): void;
}

export function getTeamTrackingBridge(): TeamTrackingBridge | null {
  try {
    const bridge = (globalThis as any).AndroidBridge;
    if (!bridge || typeof bridge !== "object") return null;
    if (typeof bridge.startTeamTracking !== "function" || typeof bridge.stopTeamTracking !== "function") return null;
    if (typeof bridge.isTeamTrackingSupported !== "function") return null;
    return bridge as TeamTrackingBridge;
  } catch {
    return null;
  }
}

export interface NativeTrackingConfig {
  baseUrl: string;
  token: string;
  memberId: string;
  teamId: string;
  intervalMs: number;
}

/** Serializes the FGS config; the native side re-validates everything (allow-listed hosts, interval clamp). */
export function buildNativeTrackingConfig(session: TeamSessionState, intervalMs: number): string {
  const cfg: NativeTrackingConfig = {
    baseUrl: typeof window !== "undefined" ? window.location.origin : "",
    token: session.token,
    memberId: session.memberId,
    teamId: session.teamId,
    intervalMs: clampHeartbeatInterval(intervalMs),
  };
  return JSON.stringify(cfg);
}
