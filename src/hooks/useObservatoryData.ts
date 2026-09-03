import { getDeviceId } from "../utils/device";
import { DATASET_KEYS } from "../utils/datasetHealth";
import type { DatasetHealth, DatasetKey } from "../utils/datasetHealth";
import { buildLocalPendingReport } from "./observatory/observatoryPendingReport";
import type { CitizenReportPayload, FetchOutcome } from "./observatory/observatoryShared";
import { useObservatoryPoll } from "./observatory/useObservatoryPoll";
import { useMeshSync } from "./observatory/useMeshSync";
import { useReportSubmission } from "./observatory/useReportSubmission";
import type { SubmissionResult } from "./observatory/useReportSubmission";
import { useReportConfirmation } from "./observatory/useReportConfirmation";

/**
 * useObservatoryData — thin orchestrator (ARC-H4).
 *
 * The former 775-line god-hook fused ~9 concerns (polling engine, dataset
 * commit/validation, live-event refresh, mesh lifecycle + gossip ingestion,
 * report submission, mesh fan-out, multipart upload, principal enrollment,
 * consensus confirm, notification reads). They now live in focused modules
 * under ./observatory/ — this file only COMPOSES them and preserves the
 * exact public surface App.tsx (and the test suite) has always consumed:
 *
 *   reports, setReports, satellites, wilayas, sosCalls, notifications,
 *   loading, lastRefreshed, lastBackendContact, datasetHealth, meshStatus,
 *   meshNodeCount, deviceId, fetchData, handleCreateReport,
 *   handleConfirmReport, confirmError, clearConfirmError,
 *   handleMarkNotificationRead
 *
 * Hook-call ORDER matters here and mirrors the original file: the poll
 * (fetch + self-schedule + live-event refresh) mounts first, then the mesh
 * client connects, then the write-path callbacks are built.
 */
export function useObservatoryData() {
  const deviceId = getDeviceId();

  const poll = useObservatoryPoll(deviceId);
  const mesh = useMeshSync(poll.admitMeshReport, poll.applyReportConsensus);
  const confirmation = useReportConfirmation(deviceId, poll);
  const submission = useReportSubmission(deviceId, poll);

  return {
    reports: poll.reports,
    // Kept for surface parity: a replace that keeps the sync mirror in
    // lockstep (the original raw setter would have silently drifted
    // reportsRef away from the rendered list — nothing ever used it).
    setReports: poll.replaceReports,
    satellites: poll.satellites,
    wilayas: poll.wilayas,
    sosCalls: poll.sosCalls,
    notifications: poll.notifications,
    loading: poll.loading,
    lastRefreshed: poll.lastRefreshed,
    lastBackendContact: poll.lastBackendContact,
    datasetHealth: poll.datasetHealth,
    meshStatus: mesh.meshStatus,
    meshNodeCount: mesh.meshNodeCount,
    deviceId,
    fetchData: poll.fetchData,
    handleCreateReport: submission.handleCreateReport,
    handleConfirmReport: confirmation.handleConfirmReport,
    confirmError: confirmation.confirmError,
    clearConfirmError: confirmation.clearConfirmError,
    handleMarkNotificationRead: poll.handleMarkNotificationRead,
  };
}

// ---- Legacy export surface (unchanged consumers) --------------------------
// tests/pending-report.test.ts imports the pure coercion helpers from this
// module; the re-exports keep that contract while the implementation lives
// in ./observatory/.
export type { DatasetKey, DatasetHealth };
export { DATASET_KEYS };
export type { CitizenReportPayload, FetchOutcome, SubmissionResult };
export { buildLocalPendingReport };
