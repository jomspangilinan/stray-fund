import sharp from "sharp";
import { avatarFromPixels } from "@/lib/photoAvatar";
import type { Avatar } from "@/lib/avatar";
import type { CatBox } from "@/lib/keepsake";

/** With no cat box (the AI path only), the middle of the frame stands in for the cat. */
const MIDDLE = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };

/** The cat's colours from its photo: crop to the box, shrink to 16x16 and read the pixels. */
export async function avatarFromPhoto(jpeg: Buffer, box: CatBox | null): Promise<Avatar> {
  const { data: upright, info } = await sharp(jpeg).rotate().toBuffer({ resolveWithObject: true });
  const area = box ?? MIDDLE;
  const left = Math.min(info.width - 1, Math.max(0, Math.floor(area.x * info.width)));
  const top = Math.min(info.height - 1, Math.max(0, Math.floor(area.y * info.height)));
  const width = Math.max(1, Math.min(info.width - left, Math.round(area.w * info.width)));
  const height = Math.max(1, Math.min(info.height - top, Math.round(area.h * info.height)));
  const { data } = await sharp(upright)
    .extract({ left, top, width, height })
    .resize(16, 16, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return avatarFromPixels(data, 16, 16);
}
