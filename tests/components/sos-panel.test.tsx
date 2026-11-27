// Fix 34 (SPN-1): fetchAudio called onAudioError only from the catch — a
// non-OK HTTP response and an OK response without an audioUrl both fell
// through silently. The panel rides a raw fetch (not apiFetch); real timers
// throughout (useNowTick(30_000) — no fake timers).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SosPanel from "../../src/components/command/SosPanel";
import type { TrappedSOS } from "../../src/types";

const sos = (): TrappedSOS => ({
  id: "SOS-1",
  deviceId: "DEV-1",
  lat: 36.7,
  lng: 5.0,
  name: "متطوع 1",
  phone: "0550000001",
  hasAudio: true,
  status: "active",
  timestamp: new Date().toISOString(),
});

const stubFetch = (res: Response) => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => res);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const renderPanel = (onAudioError: () => void) =>
  render(
    <SosPanel
      isArabic={true}
      sosCalls={[sos()]}
      dispatchLoading={false}
      registeredTeams={[]}
      onDispatch={async () => true}
      onResolve={() => {}}
      onFocusSos={() => {}}
      onAudioError={onAudioError}
    />
  );

describe("SosPanel audio loading (Fix 34 — SPN-1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404 calls onAudioError once", async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 404 }));
    const onAudioError = vi.fn(() => {});
    renderPanel(onAudioError);
    fireEvent.click(screen.getByText("استماع للتسجيل الصوتي"));
    await waitFor(() => expect(onAudioError).toHaveBeenCalledTimes(1));
  });

  it("500 calls onAudioError once", async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 500 }));
    const onAudioError = vi.fn(() => {});
    renderPanel(onAudioError);
    fireEvent.click(screen.getByText("استماع للتسجيل الصوتي"));
    await waitFor(() => expect(onAudioError).toHaveBeenCalledTimes(1));
  });

  it("200 without an audioUrl calls onAudioError once", async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const onAudioError = vi.fn(() => {});
    renderPanel(onAudioError);
    fireEvent.click(screen.getByText("استماع للتسجيل الصوتي"));
    await waitFor(() => expect(onAudioError).toHaveBeenCalledTimes(1));
  });

  it("200 with an audioUrl renders the player and never calls onAudioError (control)", async () => {
    stubFetch(new Response(JSON.stringify({ audioUrl: "https://example.test/audio.mp3" }), { status: 200 }));
    const onAudioError = vi.fn(() => {});
    renderPanel(onAudioError);
    fireEvent.click(screen.getByText("استماع للتسجيل الصوتي"));
    await waitFor(() => expect(screen.getByText(/الاستغاثة الصوتية المسجلة/)).toBeTruthy());
    expect(onAudioError).not.toHaveBeenCalled();
  });

  it("renders an active roster dispatch when the SOS snapshot has no dispatchedTeams", () => {
    render(
      <SosPanel
        isArabic={true}
        sosCalls={[sos()]}
        dispatchLoading={false}
        registeredTeams={[{
          teamId: "TEAM-1",
          name: "Team 1",
          nameAr: "فريق 1",
          type: "protection_civile",
          baseLat: null,
          baseLng: null,
          active: true,
          blockedPrincipals: [],
          members: [],
          activeMission: { sosId: "SOS-1", phase: "en_route", since: Date.now() },
        }]}
        onDispatch={async () => true}
        onResolve={() => {}}
        onFocusSos={() => {}}
      />
    );

    expect(screen.getByText("الفرق الموجهة:")).toBeTruthy();
  });
});
