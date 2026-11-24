import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  subscribers: [] as Array<Record<string, unknown>>,
  adminSdk: true,
  info: vi.fn(),
}));

vi.mock("../server/logger.js", () => ({ default: { info: state.info, error: vi.fn(), warn: vi.fn() } }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => ({
    collection: () => ({
      where: () => ({
        get: async () => ({
          forEach: (callback: (doc: { data: () => Record<string, unknown> }) => void) => {
            state.subscribers.forEach((subscriber) => callback({ data: () => subscriber }));
          },
        }),
      }),
    }),
  }),
  isAdminDb: () => state.adminSdk,
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: async () => ({
    forEach: (callback: (doc: { data: () => Record<string, unknown> }) => void) => {
      state.subscribers.forEach((subscriber) => callback({ data: () => subscriber }));
    },
  }),
}));

vi.stubEnv("RESEND_API_KEY", "test-resend-key");
const { sendFireAlert, sendVerificationEmail } = await import("../server/email.js");

describe("sendFireAlert subscriber preferences", () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.subscribers = [
      // Fix 8b: fixtures use canonical region identifiers (the exact
      // WILAYA_BOUNDS labels report creation stores). Fix 8c: a legacy
      // subscriber who saved the free-text alias "Annaba" before 8b must
      // still match — getVerifiedSubscribers normalizes stored aliases to
      // canonical labels at read time. An unrecognizable alias ("Atlantis")
      // still matches nothing, by design.
      { email: "wrong-region@example.test", wilayas: ["الجزائر - سكيكدة (Algérie - Skikda)"], minSeverity: "medium" },
      { email: "below-minimum@example.test", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "critical" },
      { email: "matching@example.test", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "high", unsubscribeToken: "match-token" },
      { email: "legacy@example.test", unsubscribeToken: "legacy-token" },
      { email: "empty-regions@example.test", wilayas: [], minSeverity: "medium" },
      { email: "legacy-alias@example.test", wilayas: ["Annaba"], minSeverity: "medium", unsubscribeToken: "alias-token" },
      { email: "unknown-alias@example.test", wilayas: ["Atlantis"], minSeverity: "medium" },
    ];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])("sends only matching preferences and preserves legacy default reach (admin SDK: %s)", async (adminSdk) => {
    state.adminSdk = adminSdk;
    await sendFireAlert({
      severity: "high",
      locationName: "Test forest",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "A fire report used to verify alert targeting.",
      lat: 36.9,
      lng: 7.7,
      timestamp: new Date().toISOString(),
      reporterType: "citizen",
    });

    const recipients = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).to as string[],
    ).flat();
    expect(recipients).toEqual([
      "matching@example.test",
      "legacy@example.test",
      "empty-regions@example.test",
      "legacy-alias@example.test",
    ]);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("match-token");
    expect(state.info).toHaveBeenLastCalledWith({ count: 4, wilaya: "الجزائر - عنابة (Algérie - Annaba)" }, "Fire alerts sent");
  });

  it.each([true, false])("defaults missing severity to medium, excluding low alerts (admin SDK: %s)", async (adminSdk) => {
    state.adminSdk = adminSdk;
    state.subscribers = [
      { email: "legacy@example.test" },
      { email: "empty-regions@example.test", wilayas: [] },
      { email: "low@example.test", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "low" },
    ];
    await sendFireAlert({
      severity: "low", locationName: "Test forest", wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "Low severity test", lat: 36.9, lng: 7.7,
      timestamp: new Date().toISOString(), reporterType: "citizen",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).to).toEqual(["low@example.test"]);
  });
});

describe("sendEmail provider timeout (Fix 44, MAIL-2)", () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a stalled provider fetch rejects with a timeout error within ~11 s (real timers)", { timeout: 15_000 }, async () => {
    // Lesson (z): vitest fake timers do NOT fire Node's AbortSignal.timeout,
    // so this test MUST use real timers — a fake-timer version would hang to
    // the test timeout and prove nothing. The 30 s suite timeout covers the
    // 10 s provider deadline with room to spare.
    // The stub must honor the abort signal exactly like real fetch does:
    // a never-resolving promise that ignores the signal would hang forever
    // on BOTH old and new code and prove nothing about the timeout.
    vi.stubGlobal("fetch", vi.fn((_input: any, init?: any) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    let caught: any;
    try {
      await sendVerificationEmail("timeout@example.test", "tok-timeout-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(String(caught?.name ?? caught)).toContain("Timeout");
  });

  it("attaches an AbortSignal to the provider fetch (fast, Fix 33 pattern)", async () => {
    await sendVerificationEmail("signal@example.test", "tok-signal-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
