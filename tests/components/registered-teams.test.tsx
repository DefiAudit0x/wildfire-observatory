import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RegisteredTeams from "../../src/components/command/RegisteredTeams";
import { RegisteredTeam } from "../../src/components/command/registeredTeams";

/**
 * Team Mode (Phase 1) — the registered-teams command panel: roster render,
 * dispatch by teamId, and join-code minting flow.
 */

const TEAM_A: RegisteredTeam = {
  teamId: "team-a1",
  name: "Unité Béjaïa",
  nameAr: "وحدة بجاية",
  type: "protection_civile",
  baseLat: null,
  baseLng: null,
  members: [
    {
      memberId: "tm-m1",
      name: "فريق الجبل",
      joinedAt: null,
      lastSeenAt: Date.now() - 10_000,
      online: true,
      lat: 36.751,
      lng: 5.071,
      accuracy: 8,
      heading: null,
      speed: 5.5,
      batteryPct: 64,
      trail: [
        { lat: 36.75, lng: 5.07, t: Date.now() - 60_000 },
        { lat: 36.751, lng: 5.071, t: Date.now() - 10_000 },
      ],
    },
    { memberId: "tm-m2", name: "منسحب", joinedAt: null, lastSeenAt: Date.now() - 3_600_000, online: false, lat: 36.5, lng: 5.0, accuracy: null, heading: null, speed: null, batteryPct: null, trail: [] },
  ],
  activeMission: null,
};

const SOS = [
  { id: "sos-77", status: "active", name: "المحتجز أحمد", lat: 36.8, lng: 5.1, timestamp: new Date().toISOString() },
] as any;

function setup(teams: RegisteredTeam[] = [TEAM_A]) {
  const onDispatch = vi.fn(async () => true);
  const onTeamsChanged = vi.fn(async () => {});
  const notify = vi.fn();
  render(
    <RegisteredTeams
      isArabic
      teams={teams}
      sosCalls={SOS}
      dispatchLoading={false}
      onDispatch={onDispatch}
      onTargetMember={vi.fn()}
      onTeamsChanged={onTeamsChanged}
      onSessionExpired={vi.fn()}
      notify={notify}
    />
  );
  return { onDispatch, onTeamsChanged, notify };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("RegisteredTeams", () => {
  it("renders registered teams with member chips and online state", () => {
    setup();
    expect(screen.getByText("وحدة بجاية")).toBeInTheDocument();
    expect(screen.getByText(/فريق الجبل/)).toBeInTheDocument();
    expect(screen.getByText(/منسحب/)).toBeInTheDocument();
    expect(screen.getByText(/1 عضو متصل/)).toBeInTheDocument();
  });

  it("shows the empty-state hint when no teams exist", () => {
    setup([]);
    expect(screen.getByText(/لا توجد فرق مسجلة بعد/)).toBeInTheDocument();
  });

  it("dispatches the registered team by teamId with notes", async () => {
    const { onDispatch } = setup();
    fireEvent.change(screen.getByPlaceholderText("تعليمات (اختياري)..."), { target: { value: "انطلقوا" } });
    fireEvent.click(screen.getByRole("button", { name: /توجيه/ }));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledWith("team-a1", "sos-77", "انطلقوا"));
  });

  it("auto-picks the oldest unassigned SOS when none selected", async () => {
    const { onDispatch } = setup();
    fireEvent.click(screen.getByRole("button", { name: /توجيه/ }));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledWith("team-a1", "sos-77", ""));
  });

  it("mints a join code and displays it for copying", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/join-code")) {
        return new Response(JSON.stringify({ code: "ABC2345X", teamId: "team-a1", expiresAt: Date.now() + 86_400_000, maxUses: 12 }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /رمز انضمام/ }));
    await waitFor(() => expect(screen.getByText("ABC2345X")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team-a1/join-code", expect.objectContaining({ method: "POST" }));
  });

  it("shows the create-team form and posts the registration", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ teamId: "team-new" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { onTeamsChanged } = setup([]);
    fireEvent.click(screen.getByRole("button", { name: /تسجيل فريق/ }));
    fireEvent.change(screen.getByPlaceholderText("الاسم بالفرنسية (Unité Béjaïa)"), { target: { value: "Unité Alger" } });
    fireEvent.change(screen.getByPlaceholderText("الاسم بالعربية"), { target: { value: "وحدة الجزائر" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل" }));
    await waitFor(() => expect(onTeamsChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams", expect.objectContaining({ method: "POST" }));
  });

  it("shows the active mission when the team is busy (no dispatch controls)", () => {
    const busy = { ...TEAM_A, activeMission: { sosId: "sos-77", phase: "en_route", since: 123 } };
    setup([busy]);
    expect(screen.getByText(/مهمة جارية على بلاغ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /توجيه/ })).not.toBeInTheDocument();
  });
});
