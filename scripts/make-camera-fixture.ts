/*
 * Writes tests/fixtures/camera.y4m, the video the end-to-end test's fake camera plays. The picture is a
 * flat cartoon cat drawn here from plain shapes: original artwork, no photograph, nothing to license.
 * Two frames at 224 by 168, about 113 KB. Run with: npx tsx scripts/make-camera-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const W = 224;
const H = 168;

const cat = (blink: boolean) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#cfe3d6"/>
  <rect y="118" width="${W}" height="50" fill="#a9c4b2"/>
  <ellipse cx="112" cy="132" rx="62" ry="30" fill="#e8913a"/>
  <polygon points="62,54 70,12 98,40" fill="#e8913a"/>
  <polygon points="162,54 154,12 126,40" fill="#e8913a"/>
  <polygon points="68,46 72,24 88,40" fill="#f2b8a0"/>
  <polygon points="156,46 152,24 136,40" fill="#f2b8a0"/>
  <ellipse cx="112" cy="76" rx="52" ry="44" fill="#e8913a"/>
  <path d="M96 40 L98 54 M112 36 L112 52 M128 40 L126 54" stroke="#b9651c" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="112" cy="94" rx="24" ry="17" fill="#fbf1e2"/>
  ${blink
    ? `<path d="M80 74 q8 6 16 0 M128 74 q8 6 16 0" stroke="#1d2a24" stroke-width="3.5" fill="none" stroke-linecap="round"/>`
    : `<ellipse cx="88" cy="74" rx="8" ry="10" fill="#1d2a24"/><ellipse cx="136" cy="74" rx="8" ry="10" fill="#1d2a24"/><circle cx="91" cy="70" r="2.6" fill="#fff"/><circle cx="139" cy="70" r="2.6" fill="#fff"/>`}
  <polygon points="106,88 118,88 112,96" fill="#d9707a"/>
  <path d="M112 96 q-7 9 -15 4 M112 96 q7 9 15 4" stroke="#1d2a24" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <path d="M70 90 h-24 M70 98 h-22 M154 90 h24 M154 98 h22" stroke="#fbf1e2" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** Planar I420 from RGB, full range BT.601, the layout y4m 4:2:0 expects. */
function i420(rgb: Buffer): Buffer {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 3;
      const [r, g, b] = [rgb[o], rgb[o + 1], rgb[o + 2]];
      y[j * W + i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  for (let j = 0; j < H / 2; j++) {
    for (let i = 0; i < W / 2; i++) {
      let r = 0, g = 0, b = 0;
      for (const [dj, di] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const o = ((2 * j + dj) * W + 2 * i + di) * 3;
        r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2];
      }
      r /= 4; g /= 4; b /= 4;
      u[j * (W / 2) + i] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
      v[j * (W / 2) + i] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    }
  }
  return Buffer.concat([y, u, v]);
}

async function main() {
  const frames: Buffer[] = [];
  for (const blink of [false, true]) {
    const { data } = await sharp(Buffer.from(cat(blink))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    frames.push(Buffer.concat([Buffer.from("FRAME\n"), i420(data)]));
  }
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F2:1 Ip A1:1 C420jpeg\n`);
  const out = path.resolve("tests", "fixtures", "camera.y4m");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([header, ...frames]));
  console.log(`wrote ${out}`);
}

void main();
