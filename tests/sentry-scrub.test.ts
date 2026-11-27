import { describe, it, expect } from "vitest";
import { scrubSentryEvent } from "../server/sentry-scrub.js";

function makeEvent(body: unknown, extra?: Record<string, unknown>) {
  return {
    event_id: "x",
    request: { data: body },
    extra,
  } as any;
}

describe("scrubSentryEvent", () => {
  it("redacts imageBase64 in a string JSON request body", () => {
    const event = makeEvent(JSON.stringify({ locationName: "Annaba", imageBase64: "data:image/jpeg;base64,AAAA" }));
    const out = scrubSentryEvent(event);
    const data = JSON.parse((out as any).request.data);
    expect(data.imageBase64).toBe("[redacted]");
    expect(data.reportName).toBeUndefined();
    expect(data.locationName).toBe("Annaba");
  });

  it("redacts deviceId, phone and email in an object request body", () => {
    const event = makeEvent({ deviceId: "device-123", phone: "0612345678", email: "a@b.com", lat: 36.75 });
    const out = scrubSentryEvent(event);
    expect((out as any).request.data.deviceId).toBe("[redacted]");
    expect((out as any).request.data.phone).toBe("[redacted]");
    expect((out as any).request.data.email).toBe("[redacted]");
    expect((out as any).request.data.lat).toBe("[redacted]");
  });

  it("redacts whole body when it is not JSON", () => {
    const event = makeEvent("not-json{");
    const out = scrubSentryEvent(event);
    expect((out as any).request.data).toBe("[redacted]");
  });

  it("redacts common PII keys but keeps unrelated keys in extra", () => {
    const event = makeEvent(undefined, { sosAudio: "audio", badgeCode: "DZ16-1", route: "/api/reports" });
    const out = scrubSentryEvent(event);
    expect((out as any).extra.sosAudio).toBe("[redacted]");
    expect((out as any).extra.badgeCode).toBe("DZ16-1");
    expect((out as any).extra.route).toBe("/api/reports");
  });

  it("redacts audio/image/device/phone/email-named extra keys via regex", () => {
    const event = makeEvent(undefined, { myAudioClip: "clip", deviceSerial: "s", emailAddr: "x@y.z", imageData: "x" });
    const out = scrubSentryEvent(event);
    expect((out as any).extra.myAudioClip).toBe("[redacted]");
    expect((out as any).extra.deviceSerial).toBe("[redacted]");
    expect((out as any).extra.emailAddr).toBe("[redacted]");
    expect((out as any).extra.imageData).toBe("[redacted]");
  });

  it("redacts credential and identity field variants in nested request bodies", () => {
    const event = makeEvent({
      user: {
        password: "secret-password",
        PasswordHash: "secret-hash",
        reporterBadgeCode: "DZ16-1",
        reporter_badge_code: "DZ16-2",
        fullName: "Amina Benali",
        reporterName: "Amina",
        idNumber: "123456789",
      },
      incidentType: "wildfire",
    });
    const out = scrubSentryEvent(event) as any;

    expect(out.request.data.user).toEqual({
      password: "[redacted]",
      PasswordHash: "[redacted]",
      reporterBadgeCode: "[redacted]",
      reporter_badge_code: "[redacted]",
      fullName: "[redacted]",
      reporterName: "[redacted]",
      idNumber: "[redacted]",
    });
    expect(out.request.data.incidentType).toBe("wildfire");
  });

  it("redacts credential and identity field variants in Sentry extras", () => {
    const event = makeEvent(undefined, {
      password: "secret-password",
      reporterBadgeCode: "DZ16-1",
      fullName: "Amina Benali",
      reporterName: "Amina",
      idNumber: "123456789",
      eventCategory: "report-created",
    });
    const out = scrubSentryEvent(event) as any;

    expect(out.extra).toEqual({
      password: "[redacted]",
      reporterBadgeCode: "[redacted]",
      fullName: "[redacted]",
      reporterName: "[redacted]",
      idNumber: "[redacted]",
      eventCategory: "report-created",
    });
  });

  it("redacts token and coordinate field variants (CodeRabbit on PR #213)", () => {
    // "accessToken"/"verificationToken" normalize to "accesstoken"/
    // "verificationtoken", matching neither the exact "token" entry nor
    // the key regex; "latitude"/"longitude" likewise match neither the
    // "lat"/"lng" entries nor the regex. All four are credentials or
    // precise location and must be redacted.
    const event = makeEvent({
      accessToken: "secret-access",
      verificationToken: "secret-verify",
      latitude: 36.75,
      longitude: 7.6,
      token: "secret-token",
      lat: 36.75,
      lng: 7.6,
      wilaya: "Annaba",
    });
    const out = scrubSentryEvent(event) as any;
    expect(out.request.data.accessToken).toBe("[redacted]");
    expect(out.request.data.verificationToken).toBe("[redacted]");
    expect(out.request.data.latitude).toBe("[redacted]");
    expect(out.request.data.longitude).toBe("[redacted]");
    expect(out.request.data.token).toBe("[redacted]");
    expect(out.request.data.lat).toBe("[redacted]");
    expect(out.request.data.lng).toBe("[redacted]");
    expect(out.request.data.wilaya).toBe("Annaba");
  });

  it("redacts nested token and coordinate fields", () => {
    const event = makeEvent({
      auth: { accessToken: "secret-access" },
      location: { latitude: 36.75, longitude: 7.6 },
      incidentType: "wildfire",
    });
    const out = scrubSentryEvent(event) as any;
    expect(out.request.data.auth.accessToken).toBe("[redacted]");
    expect(out.request.data.location.latitude).toBe("[redacted]");
    expect(out.request.data.location.longitude).toBe("[redacted]");
    expect(out.request.data.incidentType).toBe("wildfire");
  });

  it("returns the same event object for events without request/extra", () => {
    const event = { event_id: "x" } as any;
    const out = scrubSentryEvent(event);
    expect(out).toBe(event);
  });
});
