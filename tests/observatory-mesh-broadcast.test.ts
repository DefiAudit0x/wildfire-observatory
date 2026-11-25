// @vitest-environment jsdom
/**
 * Fix 56b: the mesh fan-out helpers must check the Boolean result of
 * broadcastMessage — a report above the 190 KiB mesh ceiling was dropped
 * silently. A rejected broadcast is now warned about and reported to the
 * caller instead.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/meshBridge", () => ({
  broadcastMessage: vi.fn(() => true),
  isMeshSupported: () => true,
}));

import { broadcastMessage } from "../src/utils/meshBridge";
import {
  broadcastReportToMesh,
  broadcastFailedReportToMesh,
} from "../src/hooks/observatory/observatoryMeshBroadcast";
import type { CitizenReportPayload } from "../src/hooks/observatory/observatoryShared";

describe("observatory mesh broadcast (Fix 56b)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mockedBroadcast = vi.mocked(broadcastMessage);

  beforeEach(() => {
    mockedBroadcast.mockReturnValue(true);
    warn.mockClear();
  });
  afterEach(() => {
    warn.mockClear();
  });

  it("broadcastReportToMesh returns true when the mesh accepts the report", () => {
    const report = { lat: 36.75, lng: 3.05, description: "test" };
    expect(broadcastReportToMesh(report)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("broadcastReportToMesh returns false and warns when the mesh rejects it", () => {
    mockedBroadcast.mockReturnValueOnce(false);
    const report = { lat: 36.75, lng: 3.05, description: "test" };
    expect(broadcastReportToMesh(report)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("broadcastFailedReportToMesh returns true when the mesh accepts the report", () => {
    const payload: CitizenReportPayload = {
      lat: 36.75,
      lng: 3.05,
      locationName: "Algiers",
      wilaya: "Alger",
      description: "test",
    };
    expect(broadcastFailedReportToMesh(payload)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("broadcastFailedReportToMesh returns false and warns when the mesh rejects it", () => {
    mockedBroadcast.mockReturnValueOnce(false);
    const payload: CitizenReportPayload = {
      lat: 36.75,
      lng: 3.05,
      locationName: "Algiers",
      wilaya: "Alger",
      description: "test",
    };
    expect(broadcastFailedReportToMesh(payload)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
