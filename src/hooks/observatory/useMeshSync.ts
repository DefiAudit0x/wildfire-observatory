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
        admitMeshReport(report);
      } else if (message.type === "report:confirm") {
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
