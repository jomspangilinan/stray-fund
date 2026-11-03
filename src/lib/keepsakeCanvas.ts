"use client";

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CatAvatar } from "@/components/CatAvatar";
import { MIN_SCORE, pickCat, skipDetector, type Box } from "./catDetect";
import {
  BACK_SLOTS, cropRect, FRAME, HERO, KEEPSAKE_H, KEEPSAKE_W, NAIL, PHOTO_BOX, standaloneSvg, titleName, type KeepsakeCat, type KeepsakeData,
} from "./keepsake";

/** How long the cat finder may take while someone waits. Past this the photo is simply centred. */
const FIND_LIMIT_MS = 3000;

/** Draws the app's own avatar off screen and reads it back as a standalone picture. */
function catImage(c: KeepsakeCat): Promise<HTMLImageElement> {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(createElement(CatAvatar, { avatar: c.avatar, id: c.id, ribbon: c.female })));
  const svg = standaloneSvg(host.innerHTML);
  root.unmount();
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

/** Looks for the cat in the public photo on this device. Never throws: no box just means a centred crop. */
async function findCat(img: HTMLImageElement): Promise<Box | null> {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (skipDetector(conn)) return null;
  const work = (async () => {
    const det = await (await import("./detector")).loadDetector();
    try {
      return pickCat(await det.detect(img));
    } finally {
      det.dispose();
    }
  })().catch(() => null);
  const box = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), FIND_LIMIT_MS))]);
  return box && box.score >= MIN_SCORE ? box : null;
}

/** Shrinks the type until the text fits the width. */
function fit(ctx: CanvasRenderingContext2D, text: string, family: string, weight: number, max: number, min: number, width: number): number {
  for (let size = max; size > min; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) return size;
  }
  ctx.font = `${weight} ${min}px ${family}`;
  return min;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let t = Array.from(text);
  while (t.length > 1 && ctx.measureText(`${t.join("")}…`).width > width) t = t.slice(0, -1);
  return `${t.join("").trimEnd()}…`;
}

function scene(ctx: CanvasRenderingContext2D) {
  const W = KEEPSAKE_W;
  ctx.fillStyle = "#7fb2b4";
  ctx.fillRect(0, 0, W, 1130);
  ctx.fillStyle = "#5f969b";
  ctx.fillRect(0, 930, W, 200);
  ctx.fillStyle = "#e9dec9";
  ctx.fillRect(0, 1130, W, 790);
  // The gate and the window on the wall.
  ctx.fillStyle = "#3f7a80";
  ctx.beginPath();
  ctx.moveTo(-60, 930); ctx.lineTo(-60, 700); ctx.arc(35, 700, 95, Math.PI, 0); ctx.lineTo(130, 930); ctx.fill();
  ctx.fillStyle = "#2f666c";
  ctx.beginPath();
  ctx.moveTo(-36, 930); ctx.lineTo(-36, 706); ctx.arc(34, 706, 70, Math.PI, 0); ctx.lineTo(104, 930); ctx.fill();
  ctx.fillStyle = "#5f969b";
  ctx.beginPath(); ctx.roundRect(968, 560, 150, 230, 75); ctx.fill();
  ctx.fillStyle = "#b9dcd8";
  ctx.beginPath(); ctx.roundRect(990, 582, 110, 186, 55); ctx.fill();
  ctx.strokeStyle = "#5f969b"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(1045, 582); ctx.lineTo(1045, 768); ctx.moveTo(990, 675); ctx.lineTo(1100, 675); ctx.stroke();
  // Floor boards.
  ctx.fillStyle = "#d9cbb1";
  const boards: [number, number, number, number][] = [
    [30, 1180, 250, 44], [310, 1180, 260, 44], [600, 1180, 220, 44], [850, 1180, 250, 44],
    [-40, 1290, 300, 56], [290, 1290, 300, 56], [620, 1290, 280, 56], [930, 1290, 200, 56],
    [20, 1420, 340, 68], [390, 1420, 320, 68], [740, 1420, 340, 68],
    [-40, 1560, 380, 78], [370, 1560, 340, 78], [740, 1560, 380, 78],
    [-20, 1710, 420, 90], [430, 1710, 380, 90], [840, 1710, 260, 90],
  ];
  for (const [x, y, w, h] of boards) { ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill(); }
}

function frame(ctx: CanvasRenderingContext2D, photo: HTMLImageElement, crop: { x: number; y: number; w: number; h: number }) {
  ctx.strokeStyle = "#3f2d1f"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(NAIL.x, NAIL.y + 10); ctx.lineTo(300, 396); ctx.moveTo(NAIL.x, NAIL.y + 10); ctx.lineTo(780, 396); ctx.stroke();
  ctx.fillStyle = "#3f2d1f";
  ctx.beginPath(); ctx.arc(NAIL.x, NAIL.y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.shadowColor = "rgba(18,53,42,.28)"; ctx.shadowBlur = 34; ctx.shadowOffsetY = 26;
  ctx.fillStyle = "#6b4a33";
  ctx.beginPath(); ctx.roundRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h, 6); ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#f6f3ee";
  ctx.fillRect(FRAME.x + FRAME.mat, FRAME.y + FRAME.mat, FRAME.w - FRAME.mat * 2, FRAME.h - FRAME.mat * 2);
  ctx.drawImage(photo, crop.x, crop.y, crop.w, crop.h, PHOTO_BOX.x, PHOTO_BOX.y, PHOTO_BOX.w, PHOTO_BOX.h);
}

/**
 * Draws the keepsake and returns it as a PNG. The photo arrives as bytes from this app and the drawings are SVG data
 * URLs, so the canvas is never tainted and no storage CORS rule is involved. Text uses the app's own font.
 */
export async function composeKeepsake(data: KeepsakeData, photoBlob: Blob, opts: { detect?: boolean } = {}): Promise<Blob> {
  const family = getComputedStyle(document.body).fontFamily;
  await Promise.all([document.fonts.load(`800 40px ${family}`), document.fonts.load(`700 40px ${family}`)]).catch(() => undefined);
  const photoUrl = URL.createObjectURL(photoBlob);
  try {
    const [photo, hero, others] = await Promise.all([
      loadImage(photoUrl),
      catImage(data.hero),
      Promise.all(data.others.map(catImage)),
    ]);
    const box = opts.detect === false ? null : await findCat(photo);
    const crop = cropRect({ w: photo.naturalWidth, h: photo.naturalHeight }, box);

    const canvas = document.createElement("canvas");
    canvas.width = KEEPSAKE_W;
    canvas.height = KEEPSAKE_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    scene(ctx);
    frame(ctx, photo, crop);

    // The other cats, small and faded, behind this one.
    others.forEach((img, i) => {
      const s = BACK_SLOTS[i];
      ctx.save();
      ctx.globalAlpha = 0.62;
      // Not every browser blurs a canvas draw; where it is ignored they are still faded.
      ctx.filter = "blur(2.2px) saturate(.8)";
      ctx.drawImage(img, s.x - s.size / 2, s.bottom - s.size, s.size, s.size);
      ctx.restore();
    });
    ctx.drawImage(hero, HERO.x - HERO.size / 2, HERO.bottom - HERO.size, HERO.size, HERO.size);

    // The title: one line when it fits, otherwise "This is" over the name.
    const name = titleName(data.name);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.letterSpacing = "-3px";
    const width = 940;
    const oneLine = `This is ${name}`;
    const size = fit(ctx, oneLine, family, 800, 132, 88, width);
    ctx.font = `800 ${size}px ${family}`;
    if (ctx.measureText(oneLine).width <= width) {
      ctx.fillText(oneLine, KEEPSAKE_W / 2, 122 + size * 0.86);
    } else {
      const nameSize = fit(ctx, name, family, 800, 120, 56, width);
      ctx.font = `800 ${nameSize}px ${family}`;
      const shown = ellipsize(ctx, name, width);
      ctx.fillText(shown, KEEPSAKE_W / 2, 270);
      ctx.font = "800 84px " + family;
      ctx.fillText("This is", KEEPSAKE_W / 2, 270 - nameSize * 0.9);
    }
    ctx.letterSpacing = "0px";
    ctx.fillStyle = "#12352a";
    ctx.font = `700 40px ${family}`;
    ctx.fillText("Stray Fund", KEEPSAKE_W / 2, 1860);

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(photoUrl);
  }
}
