/**
 * Fix 41 (SRV-2): waitForListening resolves once the server is bound and
 * rejects on an async bind error (EADDRINUSE, ...). The helper is tested
 * directly — server.ts self-starts on import, so no test can import it
 * (SRV-1 precedent: createProductionAssetsRouter extracted to server/assets.js).
 * The one-line wiring in startServer (`await waitForListening(httpServer)`)
 * is verified by reading the diff, not by a test.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { waitForListening } from "../server/listen.js";

describe("Fix 41 (SRV-2): waitForListening", () => {
  it("rejects with EADDRINUSE when the port is already bound", async () => {
    const first = createServer();
    await new Promise<void>((resolve) => first.listen(0, resolve));
    const port = (first.address() as { port: number }).port;
    const second = createServer();
    try {
      await expect(waitForListening(second.listen(port))).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      if (second.listening) second.close();
      first.close();
    }
  });

  it("resolves once a free port is bound (control)", async () => {
    const server = createServer();
    try {
      await expect(waitForListening(server.listen(0))).resolves.toBeUndefined();
      expect(server.listening).toBe(true);
    } finally {
      if (server.listening) server.close();
    }
  });
});
