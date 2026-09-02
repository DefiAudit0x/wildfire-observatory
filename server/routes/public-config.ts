import { Request, Response } from "express";

/**
 * v2.1.1 — public client configuration. Reads the env at request time (not
 * the config singleton) so the value stays a pure function of the
 * environment: trivially testable, and Render rotates it with the process
 * restart an env change triggers anyway.
 *
 * ONLY public-by-design values may live here — the CARTO basemap key rides
 * in every tile URL any visitor's browser fires, so it is not a secret.
 * Never expose JWT/mailer/FIRMS credentials through this endpoint.
 */
export function publicConfigHandler(_req: Request, res: Response) {
  const cartoKey = (process.env.CARTO_BASEMAP_KEY || "").trim();
  res.json({ cartoKey: cartoKey.length > 0 ? cartoKey : null });
}
