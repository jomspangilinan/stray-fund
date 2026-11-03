import sharp from "sharp";

/** JPEG with GPS EXIF, left half red and right half blue. */
export async function gpsJpeg(width = 400, height = 300): Promise<Buffer> {
  const left = await sharp({
    create: { width: width / 2, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .composite([{ input: left, left: 0, top: 0 }])
    .withExif({
      IFD0: { Make: "TestCam" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "14/1 36/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "121/1 0/1 0/1",
      },
    })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Mid-grey image with a high-contrast checkerboard in the given pixel box. */
export async function checkerImage(
  width: number,
  height: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Buffer> {
  const px = Buffer.alloc(box.width * box.height * 3);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const v = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0 : 255;
      const i = (y * box.width + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  const patch = await sharp(px, { raw: { width: box.width, height: box.height, channels: 3 } })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: patch, left: box.left, top: box.top }])
    .png()
    .toBuffer();
}

/** Raw greyscale pixels of a region of a decoded image. */
export async function greyRegion(
  img: Buffer,
  r: { left: number; top: number; width: number; height: number },
): Promise<number[]> {
  const { data } = await sharp(img).extract(r).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

export function variance(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}
