import sharp, { type OverlayOptions } from "sharp";
import { getStorage, newPrivateKey, newPublicKey } from "./storage";

/** A region as fractions of the image, 0 to 1, origin top left. */
export type Box = { x: number; y: number; w: number; h: number };

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
export const MAX_SIDE = 1600;
const PADDING = 0.1;
const MIN_SIGMA = 20;

export type InvalidPhotoReason = "empty" | "too_large" | "not_an_image" | "unsupported" | "too_many_pixels";

export class InvalidPhoto extends Error {
  constructor(public reason: InvalidPhotoReason) {
    super(`Invalid photo: ${reason}`);
    this.name = "InvalidPhoto";
  }
}

const ALLOWED = new Set(["jpeg", "png", "webp"]);

/**
 * Validates, applies EXIF orientation, resizes and re-encodes as JPEG. Sharp drops all metadata
 * (EXIF, GPS, ICC, XMP) unless asked to keep it, and rotate() runs first so orientation survives.
 */
async function normalize(input: Buffer): Promise<Buffer> {
  if (!input || input.length === 0) throw new InvalidPhoto("empty");
  if (input.length > MAX_BYTES) throw new InvalidPhoto("too_large");
  const opts = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
  try {
    const meta = await sharp(input, opts).metadata();
    if (!meta.format || !ALLOWED.has(meta.format)) throw new InvalidPhoto("unsupported");
    if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) throw new InvalidPhoto("too_many_pixels");
    return await sharp(input, opts)
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (e) {
    if (e instanceof InvalidPhoto) throw e;
    const msg = e instanceof Error ? e.message : "";
    throw new InvalidPhoto(/pixel limit/i.test(msg) ? "too_many_pixels" : "not_an_image");
  }
}

/** Stores a metadata-free private copy. Exact coordinates live only in database columns. */
export async function storeOriginal(jpeg: Buffer): Promise<{ key: string }> {
  const clean = await normalize(jpeg);
  const key = newPrivateKey();
  await getStorage().putPrivate(key, clean, "image/jpeg");
  return { key };
}

type Rect = { left: number; top: number; width: number; height: number };

/** Regions are untrusted model output. Anything unusable is skipped rather than thrown on. */
function toRect(box: unknown, width: number, height: number): Rect | null {
  if (!box || typeof box !== "object") return null;
  const { x, y, w, h } = box as Record<string, unknown>;
  for (const v of [x, y, w, h]) if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const nx = x as number;
  const ny = y as number;
  const nw = w as number;
  const nh = h as number;
  if (nw <= 0 || nh <= 0) return null;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp01(nx - nw * PADDING);
  const y0 = clamp01(ny - nh * PADDING);
  const x1 = clamp01(nx + nw * (1 + PADDING));
  const y1 = clamp01(ny + nh * (1 + PADDING));
  const left = Math.floor(x0 * width);
  const top = Math.floor(y0 * height);
  const rw = Math.min(width, Math.ceil(x1 * width)) - left;
  const rh = Math.min(height, Math.ceil(y1 * height)) - top;
  if (rw < 1 || rh < 1) return null;
  return { left, top, width: rw, height: rh };
}

/** Blurs the regions of a stored original and publishes the result as a public JPEG. */
export async function publishScrubbed(originalKey: string, regions: Box[]): Promise<{ key: string }> {
  const storage = getStorage();
  const original = await storage.getPrivate(originalKey);
  const { width, height } = await sharp(original).metadata();
  if (!width || !height) throw new InvalidPhoto("not_an_image");

  const overlays: OverlayOptions[] = [];
  for (const region of Array.isArray(regions) ? regions : []) {
    const r = toRect(region, width, height);
    if (!r) continue;
    // Strong enough that text stays unreadable: scales with the box, never below the floor.
    const sigma = Math.min(1000, Math.max(MIN_SIGMA, Math.max(r.width, r.height) / 4));
    const patch = await sharp(original).extract(r).blur(sigma).toBuffer();
    overlays.push({ input: patch, left: r.left, top: r.top });
  }

  const out = await sharp(original).composite(overlays).jpeg({ quality: 85 }).toBuffer();
  const key = newPublicKey();
  await storage.putPublic(key, out, "image/jpeg");
  return { key };
}
