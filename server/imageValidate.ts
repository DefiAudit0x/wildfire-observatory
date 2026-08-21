/**
 * Image content validation by magic bytes. The client's MIME claim is
 * metadata, not proof: a browser can be told anything. The server checks the
 * actual leading bytes of the uploaded photo before the payload (and later,
 * Gemini's vision analysis) touches it. JPEG / PNG / WebP / GIF cover the
 * capture and compression pipelines the app actually produces.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87 = "GIF87a";
const GIF89 = "GIF89a";
const RIFF = "RIFF";
const WEBP = "WEBP";

/** 700 KB decoded ceiling — the JSON body path's base64 cap (~500 KB chars)
 *  already lands under this, and the multipart path is capped by multer. */
export const MAX_IMAGE_BYTES = 700 * 1024;

export function hasImageMagicBytes(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  // JPEG: FF D8 FF (3 bytes)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return true;
  // WebP: "RIFF" .... "WEBP" (12 bytes)
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === RIFF &&
    buffer.subarray(8, 12).toString("latin1") === WEBP
  ) {
    return true;
  }
  // GIF: "GIF87a" / "GIF89a" (6 bytes)
  const head = buffer.subarray(0, 6).toString("latin1");
  if (head === GIF87 || head === GIF89) return true;
  return false;
}

/** Validates a "data:image/...;base64,...." data URL by decoding it and
 *  checking the magic bytes (plus a decoded-size ceiling). */
export function validateImageDataUrl(dataUrl: string): boolean {
  if (typeof dataUrl !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) return false;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return false;
  const encoded = dataUrl.slice(comma + 1);
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(encoded, "base64");
  } catch {
    return false;
  }
  const normalized = buffer.toString("base64");
  if (normalized !== encoded) return false;
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return false;
  return hasImageMagicBytes(buffer);
}

/** Validates a multer-received file's buffer. */
export function validateImageFile(file: { buffer?: Buffer }): boolean {
  return !!file && Buffer.isBuffer(file.buffer) && hasImageMagicBytes(file.buffer);
}
