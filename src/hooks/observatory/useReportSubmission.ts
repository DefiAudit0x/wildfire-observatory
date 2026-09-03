import { useCallback } from "react";
import type { Report } from "../../types";
import { isValidReport } from "../../utils/datasetValidators";
import type { CitizenReportPayload } from "./observatoryShared";
import { buildMultipartForm } from "./observatoryUpload";
import { broadcastReportToMesh, broadcastFailedReportToMesh } from "./observatoryMeshBroadcast";
import type { UseObservatoryPollResult } from "./useObservatoryPoll";

/**
 * Citizen report submission (ARC-H4). Transport-vs-rejection semantics are
 * the heart of this module:
 *   - transport failure / 5xx → the report fans out to the mesh (an online
 *     gateway device may relay it) and the error propagates to the UI;
 *   - 4xx → the server READ the report and refused it: no fan-out (relaying
 *     would only re-submit the same refusal), the error propagates instead.
 */

export interface SubmissionAccepted {
  submissionAccepted: true;
  responseValid: false;
  syncRequired: true;
  clientGeneratedId?: string;
  imageNotAttached?: boolean;
}
export type SubmissionResult = (Report & { responseValid: true; imageNotAttached?: boolean }) | SubmissionAccepted;

export function useReportSubmission(
  deviceId: string,
  poll: UseObservatoryPollResult
) {
  const { fetchData, admitServerReport } = poll;

  const handleCreateReport = useCallback(
    async (payload: CitizenReportPayload): Promise<SubmissionResult> => {
      const submission = payload.clientGeneratedId
        ? payload
        : { ...payload, clientGeneratedId: crypto.randomUUID() };
      let res: Response;
      let imageNotAttached = false;

      try {
        // 15s timeout for all write paths (audit B7): same ceiling as polling.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          if (payload.image && typeof payload.image === "string" && payload.image.startsWith("data:image/")) {
            // Multipart upload: avoids sending base64 through the JSON body parser.
            const { fd, imageDropped } = await buildMultipartForm(submission, deviceId, controller.signal);
            res = await fetch("/api/reports", { method: "POST", body: fd, signal: controller.signal });
            imageNotAttached = imageDropped;
          } else {
            res = await fetch("/api/reports", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...submission, deviceId }),
              signal: controller.signal,
            });
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        // TRANSPORT failure (server unreachable, request aborted): the report
        // never reached the server, so its content fans out to the mesh for an
        // online gateway device to relay (meshRelay). A server REJECTION (4xx,
        // handled below) is NOT a transport failure — the server read the
        // report and refused it, and relaying it would only re-submit the same
        // refusal; the client keeps the visible error instead.
        console.warn("Report transport failed; fanning out to mesh:", err);
        broadcastFailedReportToMesh(submission);
        throw err;
      }

      if (!res.ok) {
        let serverMsg: string | undefined;
        try {
          const data = await res.json();
          serverMsg = data?.error;
        } catch {
          // non-JSON error body
        }
        if (res.status >= 500) {
          // Server-side failure (5xx): the server is alive but could not
          // commit the report — an online peer may have better luck.
          broadcastFailedReportToMesh(submission);
        }
        const err: any = new Error(serverMsg || "Report failed");
        err.data = { error: serverMsg };
        throw err;
      }

      const newReport = await res.json();

      // The POST response is another state entry point: it must pass the same
      // report contract as the GET poll. A malformed payload is kept out of
      // state — the fetchData refresh right after re-syncs from the validated
      // GET list anyway.
      const reportIsValid = isValidReport(newReport);
      if (reportIsValid) {
        admitServerReport(newReport);
        // On success the SERVER's normalized copy goes onto the mesh (the
        // receivers' isValidReport gate accepts it), never the raw client
        // payload. The mesh copy never carries PII.
        broadcastReportToMesh(newReport);
      } else {
        console.warn("Server returned a malformed report payload; keeping the current list");
      }

      // Reconcile the authoritative datasets before the success flow returns;
      // callers that navigate immediately to the map must see the accepted
      // report in the refreshed marker list.
      await fetchData();
      // The server accepted the POST, but a malformed response is not safe to
      // render as a fabricated pending report. Reconcile from the authoritative
      // GET list and let the UI say "accepted; syncing" without inventing a
      // status or report body.
      if (!reportIsValid) {
        return {
          submissionAccepted: true,
          responseValid: false,
          syncRequired: true,
          clientGeneratedId: submission.clientGeneratedId,
          imageNotAttached,
        };
      }
      return {
        ...newReport,
        responseValid: true,
        ...(imageNotAttached ? { imageNotAttached: true } : {}),
      };
    },
    [deviceId, fetchData, admitServerReport]
  );

  return { handleCreateReport };
}
