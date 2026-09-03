/**
 * ARC-H13 — pure canvas capture + telemetry HUD stamp, extracted verbatim
 * from the former ReportForm god-component's captureSnapshot. DOM-only (no
 * React state): the orchestrator wires the hook states in and applies the
 * result to the image/feedback hooks.
 *
 * Honesty contract kept from the original:
 *  - no frame, no photo: the caller gets ok:false and the exact copy telling
 *    the reporter to attach a file or continue without an image;
 *  - the stamp is an evidentiary aid with factual fields only (GPS, UTC,
 *    sensor values marked N/A when absent) — never a "secure proof" claim.
 */

export interface StampCaptureInput {
  stream: MediaStream | null;
  video: HTMLVideoElement | null;
  lat: string;
  lng: string;
  heading: number | null;
  pitch: number | null;
  headingSource: "sensor" | "manual" | "none";
  pitchSource: "sensor" | "manual" | "none";
  includeTelemetry: boolean;
  matchedReport: { locationName?: string } | null;
  alignmentAccuracy: number | null;
  isArabic: boolean;
  bearingDirection: (angle: number) => string;
}

export type StampCaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; errorAr: string; errorFr: string };

export function captureStampedFrame(input: StampCaptureInput): StampCaptureResult {
  const {
    stream,
    video,
    lat,
    lng,
    heading,
    pitch,
    headingSource,
    pitchSource,
    includeTelemetry,
    matchedReport,
    alignmentAccuracy,
    isArabic,
    bearingDirection,
  } = input;

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      ok: false,
      errorAr: "⚠️ الكاميرا غير متاحة. يمكنك إرفاق صورة من جهازك أو متابعة البلاغ بدون صورة.",
      errorFr: "⚠️ Caméra indisponible. Vous pouvez joindre une photo ou continuer sans image.",
    };
  }

  if (stream && video && video.videoWidth > 0 && video.videoHeight > 0) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const targetRatio = 640 / 480;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = videoWidth;
    let sourceHeight = videoHeight;

    if (videoWidth / videoHeight > targetRatio) {
      sourceWidth = videoHeight * targetRatio;
      sourceX = (videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = videoWidth / targetRatio;
      sourceY = (videoHeight - sourceHeight) / 2;
    }

    ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, 640, 480);
  } else {
    // Never fabricate a fake photo: if the camera is unavailable, tell the
    // user and let the report proceed without an image (or via file upload).
    return {
      ok: false,
      errorAr: "⚠️ الكاميرا غير متاحة. يمكنك إرفاق صورة من جهازك أو متابعة البلاغ بدون صورة.",
      errorFr: "⚠️ Caméra indisponible. Vous pouvez joindre une photo ou continuer sans image.",
    };
  }

  // Overlay technical HUD overlay onto the image
  ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
  ctx.lineWidth = 1.5;

  // Crosshair target
  ctx.beginPath();
  ctx.moveTo(320, 200);
  ctx.lineTo(320, 280);
  ctx.moveTo(280, 240);
  ctx.lineTo(360, 240);
  ctx.stroke();

  // Technical bounds indicators
  ctx.beginPath();
  ctx.moveTo(20, 40); ctx.lineTo(40, 40); ctx.moveTo(20, 40); ctx.lineTo(20, 60);
  ctx.moveTo(620, 40); ctx.lineTo(600, 40); ctx.moveTo(620, 40); ctx.lineTo(620, 60);
  ctx.moveTo(20, 440); ctx.lineTo(40, 440); ctx.moveTo(20, 440); ctx.lineTo(20, 420);
  ctx.moveTo(620, 440); ctx.lineTo(600, 440); ctx.moveTo(620, 440); ctx.lineTo(620, 420);
  ctx.stroke();

  // Branded telemetry watermark labels — factual only: GPS, UTC time, and
  // sensor values (marked N/A when absent). No "secure proof" claims: the
  // stamp is an evidentiary aid, not a cryptographic proof.
  ctx.fillStyle = "rgba(248, 250, 252, 0.9)";
  ctx.font = "bold 13px monospace";
  ctx.fillText("MAGHREB WILDFIRE OBSERVATORY - TELEMETRY CAPTURE", 30, 70);

  ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
  ctx.font = "10px monospace";
  ctx.fillText("FIELD VISUAL ASSIST - ALIGNMENT ESTIMATE (NOT PROOF)", 30, 90);

  ctx.fillStyle = "rgba(241, 245, 249, 0.8)";
  ctx.font = "9px monospace";
  ctx.fillText(`GPS LAT: ${lat || "N/A"}`, 30, 115);
  ctx.fillText(`GPS LNG: ${lng || "N/A"}`, 30, 130);
  if (includeTelemetry) {
    ctx.fillText(`BEARING: ${heading !== null ? `${heading}° ${bearingDirection(heading)}` : "N/A"} (${headingSource.toUpperCase()})`, 30, 145);
    ctx.fillText(`PITCH: ${pitch !== null ? `${pitch}° (${pitchSource.toUpperCase()})` : "N/A"}`, 30, 160);
  } else {
    ctx.fillText("SENSOR STAMP: OFF", 30, 145);
  }
  ctx.fillText(`UTC CAPTURE: ${new Date().toISOString().slice(0, 19)}Z`, 30, 175);

  if (matchedReport) {
    ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
    ctx.fillText(`ALIGNMENT WITH EXISTING REPORT: ${alignmentAccuracy}% (ESTIMATE)`, 30, 200);
    ctx.fillText(`LOCATION: ${(matchedReport.locationName ?? "").substring(0, 35).toUpperCase()}`, 30, 215);
  } else {
    ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
    ctx.fillText("NO EXISTING REPORT WITHIN BEARING/RANGE", 30, 200);
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { ok: true, dataUrl };
}
