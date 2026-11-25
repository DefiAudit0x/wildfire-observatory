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

  it("ignores X-Forwarded-For from a direct client (untrusted peer)", () => {
    expect(connectionKey(request("198.51.100.99", "203.0.113.7"))).toBe("203.0.113.7");
  });

  it("ignores a whole forwarded chain from a direct client", () => {
    expect(connectionKey(request("198.51.100.99, 203.0.113.42", "203.0.113.7"))).toBe("203.0.113.7");
  });

  it("still honors the header from a private-network proxy peer (Render)", () => {
    expect(connectionKey(request("198.51.100.99, 203.0.113.42", "10.0.0.5"))).toBe("203.0.113.42");
  });

  it("honors the header from an IPv6 loopback peer", () => {
    expect(connectionKey(request("198.51.100.99", "::1"))).toBe("198.51.100.99");
  });
});
