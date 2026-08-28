import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "http";
import { connectionKey } from "../server/live.js";

function request(forwarded?: string, remoteAddress = "127.0.0.1"): IncomingMessage {
  return {
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("live websocket connection identity", () => {
  it("uses the right-most value from a trusted single-hop X-Forwarded-For chain", () => {
    expect(connectionKey(request("198.51.100.99, 203.0.113.42"))).toBe("203.0.113.42");
  });

  it("does not let a spoofed left-most value change the limiter key", () => {
    expect(connectionKey(request("spoofed-client, 203.0.113.42"))).toBe("203.0.113.42");
  });

  it("falls back to the socket address when forwarding metadata is absent", () => {
    expect(connectionKey(request(undefined, "::1"))).toBe("::1");
  });
});
