import type { Server } from "node:http";

/**
 * Fix 41 (SRV-2): resolve once the server is bound; reject on an async bind
 * error (EADDRINUSE, ...). Listeners are removed on settle so a later
 * runtime error is not swallowed. The `server.listening` fast path covers a
 * server that bound between the `listen()` call and the await (same-tick
 * race). Without this, `startServer().catch` could never see an async bind
 * error — the `error` event on an EventEmitter with no listener throws.
 */
export function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}
