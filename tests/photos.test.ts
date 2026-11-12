import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  InvalidPhoto,
  KEEP_MARGIN,
  MASK_MAX_BYTES,
  catOnly,
  maskUsable,
  publishCatOnly,
  publishScrubbed,
  storeOriginal,
  type KeepArea,
} from "../src/server/photos";
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

  it("rejects image formats outside jpeg, png and webp", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } })
      .gif()
      .toBuffer();
    await expect(storeOriginal(gif)).rejects.toBeInstanceOf(InvalidPhoto);
  });
});

describe("publishScrubbed", () => {
  const W = 800;
  const H = 600;
  // Pattern at pixels 300..400 x 200..300. Box normalized covers exactly that.
  const box = { x: 300 / W, y: 200 / H, w: 100 / W, h: 100 / H };

  async function setup() {
    const png = await checkerImage(W, H, { left: 300, top: 200, width: 100, height: 100 });
    const { key } = await storeOriginal(png);
    const original = await storage().getPrivate(key);
    return { key, original };
  }

  it("publishes a jpeg under the public prefix without metadata", async () => {
    const { key } = await setup();
    const pub = await publishScrubbed(key, [box]);
    expect(pub.key).toMatch(/^photos\/[0-9a-f-]{36}\.jpg$/);
    const out = await readPublic(pub.key);
    const m = await sharp(out).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.exif).toBeUndefined();
    expect(m.icc).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(storage().publicUrl(pub.key)).toContain(pub.key);
  });

  it("greatly reduces variance inside the box", async () => {
    const { key, original } = await setup();
    const pub = await publishScrubbed(key, [box]);
    const out = await readPublic(pub.key);
    const region = { left: 310, top: 210, width: 80, height: 80 };
    const before = variance(await greyRegion(original, region));
    const after = variance(await greyRegion(out, region));
    expect(before).toBeGreaterThan(10000);
    expect(after).toBeLessThan(before * 0.02);
  });

  it("changes only the padded region, leaving far pixels untouched", async () => {
    const { key, original } = await setup();
    const pub = await publishScrubbed(key, [box]);
    const out = await readPublic(pub.key);
    const diff = async (r: { left: number; top: number; width: number; height: number }) => {
      const a = await greyRegion(original, r);
      const b = await greyRegion(out, r);
      return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    };
    expect(await diff({ left: 305, top: 205, width: 90, height: 90 })).toBeGreaterThan(20); // inside
    // 10% padding of a 100px box is 10px: pixels at 292 are inside the padded area, 270 are outside.
    expect(await diff({ left: 0, top: 0, width: 200, height: 150 })).toBeLessThan(2);
    expect(await diff({ left: 600, top: 400, width: 200, height: 200 })).toBeLessThan(2);
    // Padding is applied: just outside the raw box edge but within 10px is blurred (not equal to the grey).
    const pad = await greyRegion(out, { left: 292, top: 250, width: 6, height: 2 });
    expect(pad.every((v) => Math.abs(v - 128) < 128)).toBe(true);
    const farLeft = await greyRegion(out, { left: 270, top: 250, width: 10, height: 2 });
    expect(farLeft.every((v) => v === 128 || Math.abs(v - 128) <= 2)).toBe(true);
  });

  it("clamps boxes that run outside the image and never throws on bad boxes", async () => {
    const { key } = await setup();
    const bad = [
      { x: -0.5, y: -0.5, w: 2, h: 2 }, // clamped to the whole image
      { x: NaN, y: 0.1, w: 0.1, h: 0.1 },
      { x: 0.1, y: 0.1, w: Infinity, h: 0.1 },
      { x: 0.1, y: 0.1, w: -0.2, h: 0.1 },
      { x: 5, y: 5, w: 1, h: 1 },
      { x: 0.2, y: 0.2, w: 0, h: 0.3 },
      { x: 0.2, y: 0.2, w: 0.3, h: 0 },
      null as never,
      { x: "a", y: 0, w: 1, h: 1 } as never,
    ];
    const pub = await publishScrubbed(key, bad);
    const m = await sharp(await readPublic(pub.key)).metadata();
    expect(m.width).toBe(W);
    expect(m.height).toBe(H);
  });

  it("skips zero-size boxes, leaving the image visually unchanged", async () => {
    const { key, original } = await setup();
    const pub = await publishScrubbed(key, [
      { x: 0.5, y: 0.5, w: 0, h: 0.2 },
      { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 },
    ]);
    const out = await readPublic(pub.key);
    const r = { left: 0, top: 0, width: W, height: H };
    const a = await greyRegion(original, r);
    const b = await greyRegion(out, r);
    const mean = a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    expect(mean).toBeLessThan(2); // only JPEG re-encode noise
  });

  it("works with no regions", async () => {
    const { key } = await setup();
    const pub = await publishScrubbed(key, []);
    expect((await sharp(await readPublic(pub.key)).metadata()).format).toBe("jpeg");
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
});
