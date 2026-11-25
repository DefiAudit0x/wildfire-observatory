import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import WebSocket from "ws";
import { meshHub, MESH_PATH } from "../server/mesh.js";
import { createMeshToken } from "../server/mesh-auth.js";

function connectClient(server: http.Server, deviceId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", deviceId, label: `node-${deviceId}`, token: createMeshToken(deviceId) }));
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
      if (!server) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });

  beforeAll(async () => {
    server = http.createServer();
    meshHub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const nodeA = await connectClient(server, "node-A");
    clients.push(nodeA);
    // connectClient resolves on socket open, before the hello is
    // processed — wait until A's joined broadcast for B proves the
    // pair is established, or a stale B-join would resolve the
    // registration test's own listener first.
    const joinedB = waitForMessage(nodeA, "node:joined");
    clients.push(await connectClient(server, "node-B"));
    await joinedB;
  });

  it("registers nodes and broadcasts node:joined to peers", async () => {
    const nodeA = clients[0];
    const nodeB = clients[1];

    // Both listeners attach BEFORE node-C hellos: the joined
    // broadcast for C reaches a node only if that node is already
    // registered, so awaiting both proves A and B are established.
    const joinedA = waitForMessage(nodeA, "node:joined");
    const joinedB = waitForMessage(nodeB, "node:joined");
    const nodeC = await connectClient(server, "node-C");
    clients.push(nodeC);

    const [joinedMessage] = await Promise.all([joinedA, joinedB]);
    expect(joinedMessage.node).toEqual(expect.objectContaining({ id: "node-C" }));
    expect(joinedMessage.nodeCount).toBe(3);

    // Leave exactly the beforeAll pair behind for the later cases.
    const closed = new Promise<void>((resolve) => { nodeC.on("close", () => resolve()); });
    nodeC.close();
    await closed;
    expect(meshHub.getNodeCount()).toBe(2);
  });

  it("relays report:new from one node to all other nodes — with trust fields STRIPPED (v2.15.0)", async () => {
    const nodeA = clients[0];
    const nodeB = clients[1];
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();

    const received = waitForMessage(nodeB, "report:new");
    nodeA.send(JSON.stringify({
      type: "report:new",
      report: { id: "rep-mesh-1", locationName: "غابة تجريبية", status: "verified", consensusCount: 999 },
    }));

    const message = await received;
    expect(message.from).toBe("node-A");
    // A mesh node may gossip a report's EXISTENCE, never its trust level:
    // the relayed copy must not carry the node's claimed status/consensus.
    expect(message.report).toEqual(expect.objectContaining({ id: "rep-mesh-1" }));
    expect(message.report).toMatchObject({ origin: "mesh" });
    expect((message.report as Record<string, unknown>).status).toBeUndefined();
    expect((message.report as Record<string, unknown>).consensusCount).toBeUndefined();
  });

  it("relays report:confirm as an id-only refetch hint (v2.15.0)", async () => {
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
    expect(message.from).toBe("node-A");
    // Attacker-controlled trust values never traverse the hub.
    expect(message.consensusCount).toBeUndefined();
    expect(message.status).toBeUndefined();
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

  it("identity comes from the token subject, not the hello deviceId claim", async () => {
    // Post-#62 model: the JWT subject is authoritative. A spoofed hello
    // deviceId claim must be ignored — the node joins under the token's
    // subject (the anti-spoofing property behind issue #49).
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(ws);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const welcome = waitForMessage(ws, "welcome");
    ws.send(JSON.stringify({
      type: "hello",
      deviceId: "impostor",
      label: "attacker",
      token: createMeshToken("subject-from-token"),
    }));
    const welcomeMessage = await welcome;
    expect(welcomeMessage.deviceId).toBe("subject-from-token");
    expect(welcomeMessage.nodeCount).toBe(3); // node-A + node-B + this node
  });

  it("handles duplicate subject by replacing old connection", async () => {
    const nodeA = clients[0];
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");

    // Replacement keeps the node count: capture it first, because the
    // third node (subject-from-token) exists only when the identity
    // test ran before this one — in isolation the count is 2.
    const countBefore = meshHub.getNodeCount();

    const oldClosed = new Promise<void>((resolve) => {
      nodeA.on("close", () => resolve());
    });

    const replacement = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(replacement);
    const welcome = waitForMessage(replacement, "welcome");
    await new Promise<void>((resolve) => replacement.on("open", () => resolve()));
    replacement.send(JSON.stringify({ type: "hello", deviceId: "node-A", label: "replacement", token: createMeshToken("node-A") }));

    await oldClosed;
    const welcomeMessage = await welcome;
    expect(welcomeMessage.deviceId).toBe("node-A");
    expect(welcomeMessage.nodeCount).toBe(countBefore); // replacement, not an addition
    expect(meshHub.getNodeCount()).toBe(countBefore);
  });
  it("ignores non-object frames before mesh hello and accepts the following hello", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${MESH_PATH}`);
    clients.push(ws);
    const firstMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once("message", (raw) => {
        try { resolve(JSON.parse(raw.toString())); } catch (error) { reject(error); }
      });
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("Socket closed before hello response")));
    });
    try {
      ws.once("open", () => {
        for (const value of [null, 42, []]) ws.send(JSON.stringify(value));
        ws.send(JSON.stringify({ type: "hello", token: createMeshToken("node-guard-test") }));
      });
      expect(await firstMessage).toMatchObject({ type: "welcome" });
    } finally {
      ws.terminate();
    }
  });
});
