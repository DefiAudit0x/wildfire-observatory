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
const { sendFireAlert } = await import("../server/email.js");

describe("sendFireAlert subscriber preferences", () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.subscribers = [
      { email: "wrong-region@example.test", wilayas: ["Algiers"], minSeverity: "medium" },
      { email: "below-minimum@example.test", wilayas: ["Annaba"], minSeverity: "critical" },
      { email: "matching@example.test", wilayas: ["Annaba"], minSeverity: "high", unsubscribeToken: "match-token" },
      { email: "legacy@example.test", unsubscribeToken: "legacy-token" },
      { email: "empty-regions@example.test", wilayas: [], minSeverity: "medium" },
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
      wilaya: "Annaba",
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
    ]);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("match-token");
    expect(state.info).toHaveBeenLastCalledWith({ count: 3, wilaya: "Annaba" }, "Fire alerts sent");
  });

  it.each([true, false])("defaults missing severity to medium, excluding low alerts (admin SDK: %s)", async (adminSdk) => {
    state.adminSdk = adminSdk;
    state.subscribers = [
      { email: "legacy@example.test" },
      { email: "empty-regions@example.test", wilayas: [] },
      { email: "low@example.test", wilayas: ["Annaba"], minSeverity: "low" },
    ];
    await sendFireAlert({
      severity: "low", locationName: "Test forest", wilaya: "Annaba",
      description: "Low severity test", lat: 36.9, lng: 7.7,
      timestamp: new Date().toISOString(), reporterType: "citizen",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).to).toEqual(["low@example.test"]);
  });
});
