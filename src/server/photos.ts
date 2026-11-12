import sharp, { type OverlayOptions } from "sharp";
import { fromCatBox, type CatBox } from "../lib/keepsake";
import { MASK_SIDE } from "../lib/catMask";
import { getStorage, newPrivateKey, newPublicKey } from "./storage";

/** A region as fractions of the image, 0 to 1, origin top left. */
export type Box = { x: number; y: number; w: number; h: number };

export const MAX_BYTES = 10 * 1024 * 1024;
/** Spot photos are camera captures from a canvas, well under this. */
export const MAX_PIXELS = 16_000_000;
/** Vet evidence (receipts, ear-tip photos) comes from the phone gallery, often 12 to 50 MP. */
export const EVIDENCE_MAX_PIXELS = 40_000_000;
export const MAX_CONCURRENT_DECODES = 2;
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

/** True when the bytes start with the JPEG signature FF D8 FF. */
export function isJpeg(buf: Uint8Array): boolean {
  return !!buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

let running = 0;
const waiting: Array<() => void> = [];

/** Runs fn once fewer than MAX_CONCURRENT_DECODES others are running in this process. First come, first served. */
export async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_DECODES) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter, so the count stays put and the queue stays in order.
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/**
 * Validates, applies EXIF orientation, resizes and re-encodes as JPEG. Sharp drops all metadata
 * (EXIF, GPS, ICC, XMP) unless asked to keep it, and rotate() runs first so orientation survives.
 */
function normalize(input: Buffer, maxPixels: number): Promise<Buffer> {
  if (!input || input.length === 0) return Promise.reject(new InvalidPhoto("empty"));
  if (input.length > MAX_BYTES) return Promise.reject(new InvalidPhoto("too_large"));
  return withDecodeSlot(() => decode(input, maxPixels));
}

async function decode(input: Buffer, maxPixels: number): Promise<Buffer> {
  const opts = { limitInputPixels: maxPixels, failOn: "error" as const };
  try {
    const meta = await sharp(input, opts).metadata();
    if (!meta.format || !ALLOWED.has(meta.format)) throw new InvalidPhoto("unsupported");
    if ((meta.width ?? 0) * (meta.height ?? 0) > maxPixels) throw new InvalidPhoto("too_many_pixels");
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

/** Stores a metadata-free private copy. Pass EVIDENCE_MAX_PIXELS for gallery photos; the default is the camera cap.  Exact coordinates live only in database columns. */
export async function storeOriginal(jpeg: Buffer, maxPixels: number = MAX_PIXELS): Promise<{ key: string }> {
  const clean = await normalize(jpeg, maxPixels);
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

export const KEEP_MARGIN = 0.15;
export const FEATHER = 0.2;
export const NO_BOX_KEEP = 0.6;
/** Lives with the pure mask code, which the phone shares. */
export { MASK_SIDE };
export const MASK_MAX_BYTES = 8 * 1024;
export const MASK_DILATE = 0.04;
const MASK_MAX_WHITE = 0.8;
const MASK_MIN_INSIDE = 0.5;
const WHITE_AT = 128;
/** The mask is dilated at this working size, where the longer side is cheap to dilate, then scaled up. */
const DILATE_WORK_SIDE = 256;

/** What stays sharp in a published photo: the cat's cut-out (a 64x64 grey PNG over the whole frame) and its box. */
export type KeepArea = { box: CatBox | null; mask: Buffer | null };

async function decodeMask(mask: Buffer): Promise<Buffer | null> {
  try {
    if (!Buffer.isBuffer(mask) || mask.length === 0 || mask.length > MASK_MAX_BYTES) return null;
    const img = sharp(mask, { limitInputPixels: MASK_SIDE * MASK_SIDE, failOn: "error" });
    const meta = await img.metadata();
    if (meta.format !== "png" || meta.width !== MASK_SIDE || meta.height !== MASK_SIDE) return null;
    return await img.removeAlpha().greyscale().raw().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Whether a mask from a phone can be trusted to decide what stays sharp. It must be a small 64x64 PNG,
 * cover something but not most of the frame, and (with the cat's box) lie mostly in that box widened by the margin.
 * A mask with no box to check it against is not used.
 */
export async function maskUsable(mask: Buffer, box: CatBox | null): Promise<boolean> {
  const px = await decodeMask(mask);
  if (!px || !box) return false;
  const area = box as Box;
  for (const v of [area.x, area.y, area.w, area.h]) if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (area.w <= 0 || area.h <= 0) return false;
  const x0 = area.x - area.w * KEEP_MARGIN;
  const x1 = area.x + area.w * (1 + KEEP_MARGIN);
  const y0 = area.y - area.h * KEEP_MARGIN;
  const y1 = area.y + area.h * (1 + KEEP_MARGIN);
  let white = 0;
  let inside = 0;
  for (let y = 0; y < MASK_SIDE; y++) {
    for (let x = 0; x < MASK_SIDE; x++) {
      if (px[y * MASK_SIDE + x] < WHITE_AT) continue;
      white++;
      const cx = (x + 0.5) / MASK_SIDE;
      const cy = (y + 0.5) / MASK_SIDE;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) inside++;
    }
  }
  if (white === 0) return false;
  if (white / (MASK_SIDE * MASK_SIDE) > MASK_MAX_WHITE) return false;
  return inside / white >= MASK_MIN_INSIDE;
}

/** One byte per pixel, 255 where the photo stays sharp, from the mask: dilated, then feathered. */
async function maskAlpha(px: Buffer, width: number, height: number): Promise<Buffer> {
  const longer = Math.max(width, height);
  const work = Math.min(DILATE_WORK_SIDE, longer);
  const scale = work / longer;
  const ww = Math.max(1, Math.round(width * scale));
  const wh = Math.max(1, Math.round(height * scale));
  const binary = await sharp(px, { raw: { width: MASK_SIDE, height: MASK_SIDE, channels: 1 } })
    .resize(ww, wh, { fit: "fill", kernel: "cubic" })
    .threshold(WHITE_AT)
    .greyscale()
    .raw()
    .toBuffer();
  const dilatePx = MASK_DILATE * longer;
  const steps = Math.max(1, Math.round(MASK_DILATE * work));
  const grown = await sharp(binary, { raw: { width: ww, height: wh, channels: 1 } }).dilate(steps).greyscale().raw().toBuffer();
  return sharp(grown, { raw: { width: ww, height: wh, channels: 1 } })
    .resize(width, height, { fit: "fill", kernel: "cubic" })
    .blur(Math.max(0.5, FEATHER * dilatePx))
    .greyscale()
    .raw()
    .toBuffer();
}

/** One byte per pixel, 255 inside a soft circle: opaque out to 80% of the radius, fading to nothing at the edge. */
async function circleAlpha(cx: number, cy: number, radius: number, width: number, height: number): Promise<Buffer> {
  const fadeFrom = Math.round((1 - FEATHER) * 1000) / 10;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${radius}">` +
    `<stop offset="${fadeFrom}%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="#000"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer();
}

/** The sharp area as one byte per pixel: the usable mask, else a circle on the box, else one in the middle. */
async function keepAlpha(keep: KeepArea, width: number, height: number): Promise<Buffer> {
  const box = keep && keep.box ? fromCatBox(keep.box, { w: width, h: height }) : null;
  const goodBox = box && [box.x, box.y, box.w, box.h].every((v) => Number.isFinite(v)) && box.w > 0 && box.h > 0 ? box : null;
  if (keep && keep.mask && (await maskUsable(keep.mask, goodBox ? keep.box : null))) {
    const px = await decodeMask(keep.mask);
    if (px) return maskAlpha(px, width, height);
  }
  if (goodBox) {
    const radius = Math.max(goodBox.w, goodBox.h) * (0.5 + KEEP_MARGIN);
    return circleAlpha(goodBox.x + goodBox.w / 2, goodBox.y + goodBox.h / 2, radius, width, height);
  }
  return circleAlpha(width / 2, height / 2, (Math.min(width, height) * NO_BOX_KEEP) / 2, width, height);
}

/** One byte per pixel, 255 inside the regions, with soft edges. Nothing when no region is usable. */
async function regionsAlpha(regions: unknown, width: number, height: number): Promise<Buffer | null> {
  const rects: Rect[] = [];
  for (const region of Array.isArray(regions) ? regions : []) {
    const r = toRect(region, width, height);
    if (r) rects.push(r);
  }
  if (rects.length === 0) return null;
  const fill = Buffer.alloc(width * height);
  for (const r of rects) {
    for (let y = r.top; y < r.top + r.height; y++) fill.fill(255, y * width + r.left, y * width + r.left + r.width);
  }
  return sharp(fill, { raw: { width, height, channels: 1 } })
    .blur(Math.max(1, Math.max(width, height) / 200))
    .greyscale()
    .raw()
    .toBuffer();
}

/**
 * Blurs the whole photo and lays the sharp cat back on top. Regions inside the sharp area are blurred again
 * with soft edges. The result is a metadata-free JPEG.
 */
export async function catOnly(jpeg: Buffer, keep: KeepArea, regions: Box[] = []): Promise<Buffer> {
  const { width, height } = await sharp(jpeg).metadata();
  if (!width || !height) throw new InvalidPhoto("not_an_image");
  const base = sharp(jpeg).removeAlpha();
  const sigma = Math.min(1000, Math.max(MIN_SIGMA, Math.max(width, height) / 40));
  const blurred = await base.clone().blur(sigma).toBuffer();

  const alpha = await keepAlpha(keep, width, height);
  const hidden = await regionsAlpha(regions, width, height);
  if (hidden) for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round((alpha[i] * (255 - hidden[i])) / 255);

  const { data: rgb } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const cat = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return sharp(blurred).composite([{ input: cat }]).jpeg({ quality: 85 }).toBuffer();
}

/** Reads a stored original, keeps the cat sharp and blurs the rest, and publishes the result as a public JPEG. */
export async function publishCatOnly(originalKey: string, keep: KeepArea, regions: Box[] = []): Promise<{ key: string }> {
  const storage = getStorage();
  const original = await storage.getPrivate(originalKey);
  const out = await catOnly(original, keep, regions);
  const key = newPublicKey();
  await storage.putPublic(key, out, "image/jpeg");
  return { key };
}
