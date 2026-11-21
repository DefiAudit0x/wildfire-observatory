import express from "express";
import fs from "node:fs/promises";
import path from "path";
import logger from "./logger.js";

const BACKEND_BUNDLE_NAMES = new Set(["server.cjs", "server.cjs.map"]);
const MAX_PATH_DECODES = 32;

function decodeRequestPath(requestPath: string): string | null {
  let decoded = requestPath;
  for (let attempt = 0; attempt < MAX_PATH_DECODES; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded.replace(/\\/g, "/");
      decoded = next;
    } catch {
      return null;
    }
  }
  return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded.replace(/\\/g, "/");
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isAssetsPath(requestPath: string): boolean {
  const decodedPath = decodeRequestPath(requestPath);
  if (decodedPath === null) return false;
  const normalizedPath = path.posix.normalize(decodedPath).toLowerCase();
  return normalizedPath === "/assets" || normalizedPath.startsWith("/assets/");
}

function shouldRejectPath(requestPath: string): boolean {
  const decodedPath = decodeRequestPath(requestPath);
  if (decodedPath === null) return true;

  const normalizedPath = path.posix.normalize(decodedPath);
  const basename = path.posix.basename(normalizedPath).toLowerCase();
  if (BACKEND_BUNDLE_NAMES.has(basename)) return true;

  // The fallback is scoped to dist/assets. Reject encoded or dot-segment paths
  // that start there but normalize outside it before static lookup can run.
  return decodedPath.startsWith("/assets/") && !normalizedPath.startsWith("/assets/");
}

/** Production static-file handling; exported so its real HTTP behavior can be tested. */
export function createProductionAssetsRouter(distPath: string): express.Router {
  const resolvedDistPath = path.resolve(distPath);
  const assetsPath = path.resolve(resolvedDistPath, "assets");
  const router = express.Router();

  router.use((req, res, next) => {
    if (shouldRejectPath(req.path)) return void res.status(404).json({ error: "Not found" });
    next();
  });

  const staticDist = express.static(resolvedDistPath);
  router.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const decodedPath = decodeRequestPath(req.path);
    if (!decodedPath || !isAssetsPath(decodedPath)) return staticDist(req, res, next);

    const normalizedPath = path.posix.normalize(decodedPath);
    if (normalizedPath.toLowerCase() === "/assets") return next();
    const requestedAsset = normalizedPath.slice("/assets/".length);
    const resolvedAsset = path.resolve(assetsPath, requestedAsset);
    if (!isInsideDirectory(assetsPath, resolvedAsset) || shouldRejectPath(normalizedPath)) {
      return void res.status(404).json({ error: "Asset not found" });
    }

    try {
      const realAssetsPath = await fs.realpath(assetsPath);
      const realAssetPath = await fs.realpath(resolvedAsset);
      if (!isInsideDirectory(realAssetsPath, realAssetPath) || shouldRejectPath(realAssetPath)) {
        return void res.status(404).json({ error: "Asset not found" });
      }
      const relativeAsset = path.relative(realAssetsPath, realAssetPath);
      res.sendFile(relativeAsset, { root: realAssetsPath }, (err) => {
        if (!err || res.headersSent) return;
        logger.warn({ path: req.path, err: err.message }, "Asset not found");
        res.status(404).json({ error: "Asset not found" });
      });
    } catch (err) {
      logger.warn({ path: req.path, err: err instanceof Error ? err.message : String(err) }, "Asset not found");
      res.status(404).json({ error: "Asset not found" });
    }
  });

  return router;
}
