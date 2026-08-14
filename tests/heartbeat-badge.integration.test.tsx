import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { buildHeartbeatPayload } from "../src/hooks/useGeolocation";
import { setReporterBadge } from "../src/utils/badgeStore";

vi.mock("../server/fs.js", () => ({
  collectionGet: vi.fn(async (collectionName: string) =>
    collectionName === "badgeCodes"
      ? [{ code: "verified-session-badge", isActive: true, ownerName: "Operator Test", type: "volunteer" }]
      : null
  ),
}));

describe("verified badge to heartbeat integration", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("uses the session badge in the heartbeat and resolves it server-side", async () => {
    setReporterBadge("verified-session-badge");
    const payload = buildHeartbeatPayload("badge-integration-device", { lat: 36.75, lng: 7.6 });

    expect(payload.badgeCode).toBe("verified-session-badge");
    expect(localStorage.getItem("reporterBadgeCode")).toBeNull();

    const { default: commandRouter } = await import("../server/routes/command.js");
    const app = express();
    app.use(express.json());
    app.use("/api", commandRouter);

    const response = await supertest(app)
      .post("/api/location/heartbeat")
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      name: "Operator Test",
      role: "volunteer",
    });
  });
});
