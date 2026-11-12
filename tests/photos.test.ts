import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_MAX_PIXELS,
  InvalidPhoto,
  KEEP_MARGIN,
  isJpeg,
  withDecodeSlot,
  MASK_MAX_BYTES,
  catOnly,
  maskUsable,
  publishCatOnly,
  storeOriginal,
  type KeepArea,
} from "../src/server/photos";
import { FUR } from "../src/lib/avatar";
import { avatarFromPixels } from "../src/lib/photoAvatar";
import { avatarFromPhoto } from "../src/server/photoAvatar";
import { getStorage } from "../src/server/storage";
import { checkerImage, gpsJpeg, greyRegion, variance } from "./helpers/images";

const storage = () => getStorage();

async function readPublic(key: string): Promise<Buffer> {
  const res = await fetchPublic(key);
  return res;
}
// In tests the driver is memory, which exposes the public bytes directly.
async function fetchPublic(key: string): Promise<Buffer> {
  const s = storage() as unknown as { readPublic(key: string): Buffer };
  return s.readPublic(key);
}

describe("storeOriginal", () => {
  it("fixture really carries GPS before processing", async () => {
    const meta = await sharp(await gpsJpeg()).metadata();
    expect(meta.exif).toBeDefined();
  });

  it("stores the original without EXIF, GPS, ICC or XMP", async () => {
    const { key } = await storeOriginal(await gpsJpeg());
    expect(key).toMatch(/^originals\/[0-9a-f-]{36}\.jpg$/);
    const stored = await storage().getPrivate(key);
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from("Exif"))).toBe(false);
  });

  it("uses random keys unrelated to the input", async () => {
    const buf = await gpsJpeg();
    const a = await storeOriginal(buf);
    const b = await storeOriginal(buf);
    expect(a.key).not.toBe(b.key);
  });

  it("bakes EXIF orientation into pixels before dropping metadata", async () => {
    // Stored 400x300, left half red. Orientation 6 means display rotated 90 degrees clockwise,
    // so the red half must end up on top of a portrait 300x400 image.
    const red = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    const src = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .composite([{ input: red, left: 0, top: 0 }])
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();
    expect((await sharp(src).metadata()).orientation).toBe(6);

    const { key } = await storeOriginal(src);
    const out = await storage().getPrivate(key);
    const meta = await sharp(out).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(400);
    const top = await sharp(await sharp(out).extract({ left: 140, top: 50, width: 20, height: 20 }).toBuffer()).stats();
    const bottom = await sharp(await sharp(out).extract({ left: 140, top: 330, width: 20, height: 20 }).toBuffer()).stats();
    expect(top.channels[0].mean).toBeGreaterThan(200); // red
    expect(top.channels[2].mean).toBeLessThan(60);
    expect(bottom.channels[2].mean).toBeGreaterThan(200); // blue
    expect(bottom.channels[0].mean).toBeLessThan(60);
  });

  it("resizes the longest side to at most 1600 and never enlarges", async () => {
    const big = await sharp({ create: { width: 3200, height: 1200, channels: 3, background: "#888" } })
      .jpeg()
      .toBuffer();
    const { key } = await storeOriginal(big);
    const m = await sharp(await storage().getPrivate(key)).metadata();
    expect(m.width).toBe(1600);
    expect(m.height).toBe(600);

    const small = await storeOriginal(await gpsJpeg(400, 300));
    const sm = await sharp(await storage().getPrivate(small.key)).metadata();
    expect(sm.width).toBe(400);
  });

  it("accepts png and webp but always emits jpeg", async () => {
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#123" } })
      .png()
      .toBuffer();
    const { key } = await storeOriginal(png);
    expect((await sharp(await storage().getPrivate(key)).metadata()).format).toBe("jpeg");
  });
});

describe("input validation", () => {
  it("rejects a non-image buffer", async () => {
    await expect(storeOriginal(Buffer.from("definitely not an image"))).rejects.toBeInstanceOf(InvalidPhoto);
  });

  it("rejects an empty buffer", async () => {
    await expect(storeOriginal(Buffer.alloc(0))).rejects.toBeInstanceOf(InvalidPhoto);
  });

  it("rejects over 10 MB before decoding", async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0xff);
    await expect(storeOriginal(huge)).rejects.toMatchObject({ name: "InvalidPhoto", reason: "too_large" });
  });

  it("rejects a decompression bomb over 40 megapixels", async () => {
    const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#000" } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(10 * 1024 * 1024);
    await expect(storeOriginal(bomb)).rejects.toBeInstanceOf(InvalidPhoto);
  });

  it("refuses a 4001x4001 PNG (over 16 MP) for a spot photo but accepts it as evidence", async () => {
    const big = await sharp({ create: { width: 4001, height: 4001, channels: 3, background: "#123" } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(big.length).toBeLessThan(1024 * 1024);
    await expect(storeOriginal(big)).rejects.toMatchObject({ name: "InvalidPhoto", reason: "too_many_pixels" });
    await expect(storeOriginal(big, EVIDENCE_MAX_PIXELS)).resolves.toHaveProperty("key");
  });

  it("rejects image formats outside jpeg, png and webp", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } })
      .gif()
      .toBuffer();
    await expect(storeOriginal(gif)).rejects.toBeInstanceOf(InvalidPhoto);
  });
});

describe("catOnly", () => {
  const W = 400;
  const H = 300;
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const cx = 200;
  const cy = 150;

  async function checker(): Promise<Buffer> {
    return sharp(await checkerImage(W, H, { left: 0, top: 0, width: W, height: H }))
      .jpeg({ quality: 95 })
      .toBuffer();
  }
  const varAt = async (img: Buffer, left: number, top: number, width = 20, height = 20) =>
    variance(await greyRegion(img, { left, top, width, height }));

  /** A 64x64 grey PNG, white where the pixel's centre lies in the given fractions of the frame. */
  async function maskOf(area: { x: number; y: number; w: number; h: number } | "all" | "none"): Promise<Buffer> {
    const px = Buffer.alloc(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const fx = (x + 0.5) / 64;
        const fy = (y + 0.5) / 64;
        const on =
          area === "all" ||
          (area !== "none" && fx >= area.x && fx <= area.x + area.w && fy >= area.y && fy <= area.y + area.h);
        px[y * 64 + x] = on ? 255 : 0;
      }
    }
    return sharp(px, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
  }
  const leftHalf = { x: 0, y: 0.2, w: 0.45, h: 0.6 };

  it("falls back to a soft circle on the box: sharp in the middle, blurred in the corners", async () => {
    const input = await checker();
    const before = await varAt(input, cx - 10, cy - 10);
    const out = await catOnly(input, { box, mask: null });
    expect(before).toBeGreaterThan(10000);
    expect(await varAt(out, cx - 10, cy - 10)).toBeGreaterThan(before * 0.7);
    for (const [l, t] of [[0, 0], [W - 20, 0], [0, H - 20], [W - 20, H - 20]]) {
      expect(await varAt(out, l, t)).toBeLessThan(before * 0.1);
    }
  });

  it("fades without a hard edge from the box centre outward", async () => {
    const input = await checker();
    const out = await catOnly(input, { box, mask: null });
    // The circle has radius 200 * 0.65 = 130 and fades over its last 26 px. Variance follows the square of
    // the blend, so bands this thin and a floor at 10% of the sharp variance (the blur's own noise) are fair.
    const sharpVar = await varAt(input, cx - 10, cy - 10);
    const bands: number[] = [];
    for (let d = 0; d + 5 <= 135; d += 5) bands.push(await varAt(out, cx + d, cy - 5, 5, 10));
    expect(bands.some((v) => v > sharpVar * 0.15 && v < sharpVar * 0.85)).toBe(true);
    for (let i = 0; i + 1 < bands.length; i++) {
      const hi = Math.max(bands[i], bands[i + 1]);
      const lo = Math.max(sharpVar * 0.1, Math.min(bands[i], bands[i + 1]));
      expect(hi / lo).toBeLessThan(3);
    }
  });

  it("keeps the usable mask sharp and blurs the rest, without using the circle", async () => {
    const input = await checker();
    const keep: KeepArea = { box: { x: 0, y: 0.2, w: 0.45, h: 0.6 }, mask: await maskOf(leftHalf) };
    expect(await maskUsable(keep.mask!, keep.box)).toBe(true);
    const out = await catOnly(input, keep);
    const before = await varAt(input, 40, 120);
    expect(await varAt(out, 40, 120)).toBeGreaterThan(before * 0.7);
    expect(await varAt(out, 340, 120)).toBeLessThan(before * 0.1);
    // Inside the box's circle (centre 90,150, radius 0.65 * 180 = 117) but well outside the mask: blurred.
    expect(await varAt(out, 190, 140, 10, 10)).toBeLessThan(before * 0.1);
  });

  describe("an unusable mask falls back to the circle", () => {
    const cases: [string, () => Promise<Buffer>][] = [
      ["an all-black mask", () => maskOf("none")],
      ["a mask over 80% white", () => maskOf("all")],
      ["a mask mostly outside the box", () => maskOf({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 })],
      [
        "a mask that is not 64x64",
        () => sharp({ create: { width: 32, height: 32, channels: 3, background: "#fff" } }).png().toBuffer(),
      ],
      ["a mask over the size limit", async () => Buffer.concat([await maskOf(box), Buffer.alloc(MASK_MAX_BYTES)])],
      ["non-PNG bytes", async () => Buffer.from("not a png at all")],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        const mask = await make();
        expect(await maskUsable(mask, box)).toBe(false);
        const input = await checker();
        const before = await varAt(input, cx - 10, cy - 10);
        const out = await catOnly(input, { box, mask });
        const plain = await catOnly(input, { box, mask: null });
        expect(await varAt(out, cx - 10, cy - 10)).toBeGreaterThan(before * 0.7);
        expect(await varAt(out, 0, 0)).toBeLessThan(before * 0.1);
        expect((await greyRegion(out, { left: 0, top: 0, width: W, height: H })).join()).toBe(
          (await greyRegion(plain, { left: 0, top: 0, width: W, height: H })).join(),
        );
      });
    }

    it("a mask with no box to check it against", async () => {
      expect(await maskUsable(await maskOf(box), null)).toBe(false);
    });
  });

  it("accepts a mask that lies inside the box widened by the margin", async () => {
    const wide = { x: box.x - box.w * KEEP_MARGIN * 0.9, y: box.y, w: box.w * (1 + KEEP_MARGIN * 0.9), h: box.h };
    expect(await maskUsable(await maskOf(wide), box)).toBe(true);
  });

  it("with no box and no mask keeps the middle sharp and blurs the corners", async () => {
    const input = await checker();
    const before = await varAt(input, cx - 10, cy - 10);
    const out = await catOnly(input, { box: null, mask: null });
    expect(await varAt(out, cx - 10, cy - 10)).toBeGreaterThan(before * 0.7);
    // Diameter 60% of the shorter side is 180 px: 90 px from the middle is the edge.
    expect(await varAt(out, cx + 100, cy - 10)).toBeLessThan(before * 0.1);
    expect(await varAt(out, 0, 0)).toBeLessThan(before * 0.1);
    expect(await varAt(out, W - 20, H - 20)).toBeLessThan(before * 0.1);
  });

  it("blurs a region that lies inside the sharp area", async () => {
    const input = await checker();
    const before = await varAt(input, cx - 10, cy - 10);
    const region = { x: (cx - 20) / W, y: (cy - 20) / H, w: 40 / W, h: 40 / H };
    const out = await catOnly(input, { box, mask: null }, [region]);
    expect(await varAt(out, cx - 5, cy - 5, 10, 10)).toBeLessThan(before * 0.1);
    // Well inside the circle but away from the region stays sharp.
    expect(await varAt(out, cx + 60, cy - 10)).toBeGreaterThan(before * 0.7);
  });

  it("ignores unusable regions and boxes", async () => {
    const input = await checker();
    const out = await catOnly(input, { box: { x: NaN, y: 0, w: 1, h: 1 }, mask: null }, [null as never, { x: 0, y: 0, w: 0, h: 1 }]);
    const m = await sharp(out).metadata();
    expect([m.width, m.height]).toEqual([W, H]);
  });

  it("publishCatOnly stores a metadata-free JPEG under the public prefix", async () => {
    const { key } = await storeOriginal(await gpsJpeg());
    const pub = await publishCatOnly(key, { box, mask: null });
    expect(pub.key).toMatch(/^photos\/[0-9a-f-]{36}\.jpg$/);
    const m = await sharp(await readPublic(pub.key)).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.exif).toBeUndefined();
    expect([m.width, m.height]).toEqual([400, 300]);
  });

  it("publishCatOnly blurs a sensitive region inside the sharp area and leaves the far corners blurred", async () => {
    const { key } = await storeOriginal(await checker());
    const original = await storage().getPrivate(key);
    const region = { x: (cx - 20) / W, y: (cy - 20) / H, w: 40 / W, h: 40 / H };
    const out = await readPublic((await publishCatOnly(key, { box, mask: null }, [region])).key);
    const before = await varAt(original, cx - 10, cy - 10);
    expect(await varAt(out, cx - 5, cy - 5, 10, 10)).toBeLessThan(before * 0.1);
    expect(await varAt(out, cx + 60, cy - 10)).toBeGreaterThan(before * 0.7);
    expect(await varAt(out, 0, 0)).toBeLessThan(before * 0.1);
  });
});

describe("avatarFromPhoto", () => {
  const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const jpegOf = (px: (x: number, y: number) => string) => {
    const data = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) data.set(rgb(px(x, y)), (y * 64 + x) * 3);
    return sharp(data, { raw: { width: 64, height: 64, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
  };

  it("reads a one-colour photo as a solid cat", async () => {
    expect(await avatarFromPhoto(await jpegOf(() => FUR.ginger), null)).toEqual({ pattern: "solid", base: "ginger", accent: "ginger" });
  });

  it("reads black on one side and white on the other as a tuxedo", async () => {
    const a = await avatarFromPhoto(await jpegOf((x) => (x < 32 ? FUR.black : FUR.white)), { x: 0, y: 0, w: 1, h: 1 });
    expect(a.pattern).toBe("tuxedo");
    expect([a.base, a.accent].sort()).toEqual(["black", "white"]);
  });

  it("reads 80% grey and 20% cream as a bicolour", async () => {
    // 64 columns: the last 13 (about 20%) are cream.
    expect(await avatarFromPhoto(await jpegOf((x) => (x < 51 ? FUR.grey : FUR.cream)), { x: 0, y: 0, w: 1, h: 1 })).toEqual({ pattern: "bicolour", base: "grey", accent: "cream" });
  });

  it("crops to the box, and to the middle when there is none", async () => {
    const img = await jpegOf((x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? FUR.brown : FUR.white));
    expect((await avatarFromPhoto(img, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })).base).toBe("brown");
    expect((await avatarFromPhoto(img, null)).base).toBe("brown");
    expect((await avatarFromPhoto(img, { x: 0, y: 0, w: 0.2, h: 0.2 })).base).toBe("white");
  });

  it("keeps a second colour below 15% out of the avatar and ignores see-through pixels", () => {
    const px = new Uint8Array(16 * 16 * 4);
    for (let p = 0; p < 256; p++) px.set([...rgb(p < 38 ? FUR.cream : FUR.grey), 255], p * 4);
    expect(avatarFromPixels(px, 16, 16)).toEqual({ pattern: "solid", base: "grey", accent: "grey" });
    for (let p = 0; p < 256; p++) px[p * 4 + 3] = p < 128 ? 0 : 255;
    expect(avatarFromPixels(px, 16, 16).base).toBe("grey");
  });
});

describe("withDecodeSlot", () => {
  it("never runs more than two at once and keeps arrival order", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const job = (n: number) =>
      withDecodeSlot(async () => {
        started.push(n);
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => gates.push(r));
        active--;
        return n;
      });
    const all = [job(1), job(2), job(3)];
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([1, 2]);
    expect(active).toBe(2);
    gates[0]();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([1, 2, 3]);
    gates[1]();
    gates[2]();
    expect(await Promise.all(all)).toEqual([1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("frees the slot when the work throws", async () => {
    for (let i = 0; i < 4; i++) await expect(withDecodeSlot(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(withDecodeSlot(async () => 7)).resolves.toBe(7);
  });
});

describe("isJpeg", () => {
  it("checks the FF D8 FF signature", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isJpeg(new Uint8Array([]))).toBe(false);
  });
});
