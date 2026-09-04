import { useEffect, useState } from "react";
import { meshClient } from "../../lib/mesh";
import { checkAndRecordMessageHash } from "../../utils/meshBridge";
import { isValidReport } from "../../utils/datasetValidators";
import { isReportStatus } from "./observatoryPendingReport";

/**
 * Mesh client lifecycle + gossip ingestion (ARC-H4). Subscribes to the
 * singleton meshClient; report-shaped messages are admitted through the
 * poll owner's admission functions so the sync mirrors stay in lockstep.
 */

const CONSENSUS_COUNT_CEILING = 1_000_000;

export function useMeshSync(
  admitMeshReport: (report: unknown) => void,
  applyReportConsensus: (id: string, status: unknown, consensusCount: number) => void
): { meshStatus: "connecting" | "online" | "offline"; meshNodeCount: number } {
  const [meshStatus, setMeshStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [meshNodeCount, setMeshNodeCount] = useState(0);

  // Mesh network: live peer-to-peer-ish synchronization
  useEffect(() => {
    meshClient.connect();

    const offStatus = meshClient.onStatus((status, count) => {
      setMeshStatus(status);
      setMeshNodeCount(count);
      if (status === "online") {
        window.dispatchEvent(new Event("mesh:online"));
      }
    });

    const offMessage = meshClient.onMessage((message) => {
      if (message.type === "report:new") {
        // Anti-replay: the same gossip must not be admitted twice, even when
        // two transports (WS mesh + refresh poll) deliver it back-to-back.
        // The identity is the report's OWN id when the message carries one
        // (the stable, relay-unchanged key) — never a random UUID that would
        // re-admit the same report on every hop.
        const report = message.report as unknown;
        // Audit B10: validate report BEFORE recording gossip hash to prevent
        // cache poisoning from malformed reports with colliding IDs.
        if (!isValidReport(report)) return;
        const gossipId = JSON.stringify([
          message.type,
          (report as { id?: unknown } | null)?.id ?? message.id,
          message.ts,
          message.lat,
          message.lng,
        ]);
        if (!checkAndRecordMessageHash(gossipId)) return;
        // v2.15.0 mesh-authenticity fix: a mesh peer may gossip a report's
        // EXISTENCE, never its trust level. Whatever the frame claims, a
        // mesh-admitted report is displayed honestly as PENDING with an
        // explicit mesh-origin marker until the HTTP API says otherwise.
        // (The hub already strips status/consensusCount server-side; this
        // client-side clamp keeps older hubs honest too.)
        const meshReport = {
          ...(report as unknown as Record<string, unknown>),
          status: "pending",
          origin: "mesh",
        } as unknown;
        admitMeshReport(meshReport);
      } else if (message.type === "report:confirm") {
        // v2.15.0 mesh-authenticity fix: node-RELAYED confirm frames (which
        // carry a `from` nodeId) contain NO trust data anymore — the hub
        // strips consensusCount/status before rebroadcasting, because a
        // mesh peer must never vouch for verification. They act purely as a
        // refetch hint; the next HTTP poll reconciles the truth.
        // The hub's OWN ledger broadcast (a real server-side confirmation,
        // no `from` field) remains trustworthy and is applied as before.
        const hubAuthoritative = message.from === undefined;
        if (!hubAuthoritative) return;
        const id = String(message.id);
        const rawStatus = message.status;
        const consensusCount = Number(message.consensusCount);
        // Consensus updates are protocol data: the status must be a real
        // report status and the count a non-negative INTEGER (Infinity,
        // fractions and coerced garbage are not consensus).
        if (
          id &&
          isReportStatus(rawStatus) &&
          Number.isInteger(consensusCount) &&
          consensusCount >= 0 &&
          consensusCount <= CONSENSUS_COUNT_CEILING
        ) {
          applyReportConsensus(id, rawStatus, consensusCount);
        }
      }
    });

    return () => {
      offStatus();
      offMessage();
      meshClient.disconnect();
    };
  }, [admitMeshReport, applyReportConsensus]);

  return { meshStatus, meshNodeCount };
}
