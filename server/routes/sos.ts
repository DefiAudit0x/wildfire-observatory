import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate } from "../fs.js";
import logger from "../logger.js";

const router = Router();

const sosSchema = z.object({
  deviceId: z.string().min(1),
  lat: z.union([z.number(), z.string()]),
  lng: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  phone: z.string().optional(),
  audioUrl: z.string().optional(),
  audioDuration: z.union([z.number(), z.string()]).optional(),
});

const dispatchSchema = z.object({
  type: z.enum(["protection_civile", "volunteers"]),
  teamNameAr: z.string().min(1),
  teamNameFr: z.string().min(1),
  notes: z.string().optional(),
});

const memorySos: any[] = [];

router.get("/", async (_req: Request, res: Response) => {
  let fromDb: any[] | null = null;
  if (memorySos.length === 0) {
    fromDb = await collectionGet("trappedSos", "timestamp", 100);
  }
  const merged = fromDb && fromDb.length > 0 ? fromDb : memorySos;
  res.json(merged);
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = sosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const data = parsed.data;
  const newSos = {
    id: `sos-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    deviceId: data.deviceId,
    lat: Number(data.lat),
    lng: Number(data.lng),
    name: data.name || "شخص محاصر",
    phone: data.phone || "",
    audioUrl: data.audioUrl || undefined,
    audioDuration: data.audioDuration ? Number(data.audioDuration) : undefined,
    status: "active",
    timestamp: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(newSos).filter(([, v]) => v !== undefined));
  await docSet("trappedSos", newSos.id, clean);
  memorySos.unshift(newSos);
  res.json(newSos);
});

router.post("/:id/resolve", async (req: Request, res: Response) => {
  const { id } = req.params;
  await docUpdate("trappedSos", id, { status: "resolved" });
  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) sos.status = "resolved";
  res.json({ success: true });
});

router.post("/:id/dispatch", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const dispatchItem = {
    type: parsed.data.type,
    teamNameAr: parsed.data.teamNameAr,
    teamNameFr: parsed.data.teamNameFr,
    dispatchedAt: new Date().toISOString(),
    status: "en_route",
    notes: parsed.data.notes || "",
  };

  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) {
    if (!sos.dispatchedTeams) sos.dispatchedTeams = [];
    sos.dispatchedTeams.push(dispatchItem);
  }
  try {
    const existing = await collectionGet("trappedSos");
    const current = existing?.find((d: any) => d.id === id);
    if (current) {
      const teams = current.dispatchedTeams || [];
      await docUpdate("trappedSos", id, { dispatchedTeams: [...teams, dispatchItem] });
    } else if (sos) {
      await docSet("trappedSos", id, sos);
    }
  } catch (err) {
    logger.error({ err, id }, "Firestore dispatch error");
  }
  res.json({ success: true, dispatch: dispatchItem });
});

export default router;
