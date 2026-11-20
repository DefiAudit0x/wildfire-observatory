import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionAssetsRouter } from "../server/assets.js";

const temporaryDirectories: string[] = [];

async function createAssetApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wildfire-assets-test-"));
  temporaryDirectories.push(root);
  const distPath = path.join(root, "dist");
  const assetsPath = path.join(distPath, "assets");
  await mkdir(assetsPath, { recursive: true });
  await writeFile(path.join(distPath, "server.cjs"), "PRIVATE BACKEND BUNDLE");
  await writeFile(path.join(distPath, "server.cjs.map"), "PRIVATE BACKEND SOURCE MAP");
  await writeFile(path.join(distPath, "index.html"), "<main>Wildfire Observatory</main>");
  await writeFile(path.join(assetsPath, "forest.svg"), "<svg>public asset</svg>");
  await symlink(path.join(distPath, "server.cjs"), path.join(assetsPath, "misleading.js"));

  const app = express();
  app.use(createProductionAssetsRouter(distPath));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return supertest(app);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production asset serving", () => {
  it("does not expose the backend bundle or source map through asset paths or encoded aliases", async () => {
    const client = await createAssetApp();

    for (const requestPath of [
      "/server.cjs",
      "/server.cjs.map",
      "/assets/server.cjs",
      "/assets/server.cjs.map",
      "/assets/%73erver.cjs",
      "/assets/server%2ecjs",
      "/assets/%2573erver.cjs",
      "/assets%2fserver.cjs",
      "/assets%252fserver.cjs",
      "/assets%2fmisleading.js",
      "/nested/server.cjs",
      "/%73erver.cjs.map",
    ]) {
      const response = await client.get(requestPath);
      expect(response.status, requestPath).toBe(404);
      expect(response.text).not.toContain("PRIVATE BACKEND");
    }
  });

  it("rejects asset fallback paths that escape assets while preserving legitimate files", async () => {
    const client = await createAssetApp();

    const asset = await client.get("/assets/forest.svg");
    expect(asset.status).toBe(200);
    expect(asset.body.toString()).toContain("public asset");

    const encodedPrefixAsset = await client.get("/assets%2fforest.svg");
    expect(encodedPrefixAsset.status).toBe(200);
    expect(encodedPrefixAsset.body.toString()).toContain("public asset");

    const index = await client.get("/index.html");
    expect(index.status).toBe(200);
    expect(index.text).toContain("Wildfire Observatory");

    for (const requestPath of ["/assets/../server.cjs", "/assets/%2e%2e/server.cjs", "/assets/%252e%252e/index.html"]) {
      expect((await client.get(requestPath)).status, requestPath).toBe(404);
    }
    const symlink = await client.get("/assets/misleading.js");
    expect(symlink.status).toBe(404);
    expect(symlink.text).not.toContain("PRIVATE BACKEND BUNDLE");
  });
});
