import type { CitizenReportPayload } from "./observatoryShared";
import { FETCH_TIMEOUT_MS } from "./observatoryShared";

/**
 * Pure multipart upload builder (ARC-H4). Extracted verbatim from the former
 * god-hook so the image-decode fallback chain is unit-testable in isolation.
 */

/**
 * Builds the multipart form for an image-bearing report. The data URL is
 * decoded via fetch() into a Blob (the browser-native decoder beats a JS
 * atob() loop on large images), with an atob() fallback for old WebViews.
 * If BOTH decoders fail — a corrupt or non-decodable data URL — the report
 * is still submitted, WITHOUT the image: a broken photo must never block a
 * fire report from reaching the server. The caller receives imageDropped so
 * the reporter is TOLD the photo did not travel (never a silent drop).
 */
export async function buildMultipartForm(
  payload: CitizenReportPayload,
  deviceId: string,
  signal?: AbortSignal
): Promise<{ fd: FormData; imageDropped: boolean }> {
  const imgData = payload.image as string;
  const mime = imgData.split(";")[0].split(":")[1] || "image/jpeg";
  let blob: Blob | null = null;
  try {
    const imageTimeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const imageSignal = signal ? AbortSignal.any([signal, imageTimeout]) : imageTimeout;
    blob = await (await fetch(imgData, { signal: imageSignal })).blob();
  } catch {
    // Older WebViews may refuse to fetch data URLs: fall back to atob.
    try {
      const base64 = imgData.split(",")[1] || "";
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: mime });
    } catch {
      console.warn("Image data URL is not decodable; submitting the report without the image");
    }
  }
  const fd = new FormData();
  if (blob) {
    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    fd.append("image", blob, `report-${Date.now()}.${ext}`);
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "image") continue;
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  }
  fd.append("deviceId", deviceId);
  return { fd, imageDropped: !blob };
}
