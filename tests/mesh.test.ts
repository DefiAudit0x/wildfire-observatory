import { describe, it, expect, afterAll } from "vitest";
import http from "http";
import WebSocket from "ws";
import { generateKeyPairSync, sign } from "node:crypto";
import { meshHub, MESH_PATH } from "../server/mesh.js";
import { createMeshToken } from "../server/mesh-auth.js";

function meshCredentials(deviceId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const token = createMeshToken(deviceId, publicKeyPem);
  const signature = sign(null, Buffer.from(token, "utf8"), privateKey).toString("base64");
  return { token, publicKey: publicKeyPem, signature };
}

function connectClient(server: http.Server, deviceId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", deviceId, label: `node-${deviceId}`, ...meshCredentials(deviceId) }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === type) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(message);
        }
      } catch {
        // ignore malformed
      }
    };
    ws.on("message", onMessage);
  });
}

describe("mesh hub", () => {
  let server: http.Server;
  const clients: WebSocket[] = [];

  afterAll(() => {
    clients.forEach((c) => { try { c.close(); } catch { /* ignore */ } });
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });

  it("registers nodes and broadcasts node:joined to peers", async () => {
    server = http.createServer();
    meshHub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const nodeA = await connectClient(server, "node-A");
    clients.push(nodeA);

    const joined = waitForMessage(nodeA, "node:joined");
    const nodeB = await connectClient(server, "node-B");
    clients.push(nodeB);

    const joinedMessage = await joined;
    expect(joinedMessage.node).toEqual(expect.objectContaining({ id: "node-B" }));
    expect(joinedMessage.nodeCount).toBe(2);
  });

  it("relays report:new from one node to all other nodes", async () => {
    const nodeA = clients[0];
    const nodeB = clients[1];
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();

    const received = waitForMessage(nodeB, "report:new");
    nodeA.send(JSON.stringify({
      type: "report:new",
      report: {
        id: "rep-mesh-1", lat: 36.8, lng: 7.5, locationName: "غابة تجريبية", wilaya: "عنابة",
        description: "بلاغ حريق تجريبي صالح", severity: "high", status: "pending",
        timestamp: new Date().toISOString(), consensusCount: 1,
      },
    }));

    const message = await received;
    expect(message.from).toBe("node-A");
    expect(message.report).toEqual(expect.objectContaining({ id: "rep-mesh-1" }));
  });

  it("relays report:confirm broadcasts", async () => {
    const nodeA = clients[0];
    const nodeB = clients[1];

    const received = waitForMessage(nodeB, "report:confirm");
    nodeA.send(JSON.stringify({
      type: "report:confirm",
      id: "rep-mesh-1",
      consensusCount: 6,
      status: "verified",
    }));

    const message = await received;
    expect(message.id).toBe("rep-mesh-1");
    expect(message.consensusCount).toBe(6);
    expect(message.status).toBe("verified");
  });

  it("rejects messages before hello", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(ws);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const errorMessage = waitForMessage(ws, "error");
    ws.send(JSON.stringify({ type: "report:new", report: {} }));
    const message = await errorMessage;
    expect(String(message.message)).toContain("hello");
  });

  it("rejects hello with an invalid mesh token", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(ws);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const errorMessage = waitForMessage(ws, "error");
    ws.send(JSON.stringify({ type: "hello", deviceId: "evildude", label: "attacker", token: "not-a-valid-token" }));
    const message = await errorMessage;
    expect(String(message.message)).toContain("Unauthorized");
  });

  it("rejects a token issued for a different deviceId", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(ws);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const errorMessage = waitForMessage(ws, "error");
    const credentials = meshCredentials("other-device");
    ws.send(JSON.stringify({
      type: "hello",
      deviceId: "impostor",
      label: "attacker",
      ...credentials,
    }));
    const message = await errorMessage;
    expect(String(message.message)).toContain("Unauthorized");
  });

  it("handles duplicate deviceId by replacing old connection", async () => {
    const nodeA = clients[0];
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");

    const oldClosed = new Promise<void>((resolve) => {
      nodeA.on("close", () => resolve());
    });

    const replacement = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(replacement);
    const welcome = waitForMessage(replacement, "welcome");
    await new Promise<void>((resolve) => replacement.on("open", () => resolve()));
    replacement.send(JSON.stringify({ type: "hello", deviceId: "node-A", label: "replacement", ...meshCredentials("node-A") }));

    await oldClosed;
    const welcomeMessage = await welcome;
    expect(welcomeMessage.deviceId).toBe("node-A");
    expect(welcomeMessage.nodeCount).toBe(2);
    expect(meshHub.getNodeCount()).toBe(2);
  });
});
