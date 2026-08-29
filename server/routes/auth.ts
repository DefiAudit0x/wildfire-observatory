import { Request, Response, Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import { generateStaffToken, requireAuth } from "../middleware.js";
import { docGet } from "../fs.js";
import config from "../config.js";

const router = Router();

const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

const loginSchema = z.object({
  agentId: z.string().min(2).max(64),
  password: z.string().min(1).max(128),
});

router.post("/login", staffLoginLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { agentId, password } = parsed.data;
  try {
    const user = await docGet("users", agentId);
    if (!user || user.isActive === false) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const valid = await bcrypt.compare(password, user.passwordHash || "");
    if (!valid) {
      logger.warn({ agentId }, "Failed staff login attempt");
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = generateStaffToken({
      role: user.role,
      unitId: user.unitId,
      name: user.name,
      agentId: user.agentId,
    });
    res.cookie("staff_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 24 * 60 * 60 * 1000,
    });
    logger.info({ agentId, role: user.role, unitId: user.unitId }, "Staff login");
    res.json({
      success: true,
      user: {
        agentId: user.agentId,
        name: user.name,
        role: user.role,
        unitId: user.unitId,
      },
    });
  } catch (err) {
    logger.error({ err }, "Staff login error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/session", requireAuth, (req: Request, res: Response) => {
  const admin = (req as any).admin;
  res.json({
    authenticated: true,
    user: {
      agentId: admin?.agentId || null,
      name: admin?.name || null,
      // C2 fix: never announce a default admin role — an absent role stays absent.
      role: admin?.role ?? null,
      unitId: admin?.unitId || null,
    },
  });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("staff_token");
  res.json({ success: true });
});

export default router;