/*
 * The cat's cut-out as a small grey picture over the whole frame. Pure: no sharp, no DOM, so the phone
 * and the worker share it. 255 is the cat, 0 everything else.
 */

/** The cut-out is this many pixels on each side, whatever the photo's shape. */
export const MASK_SIDE = 64;

/** A cell of the probability grid counts as cat from here up. */
export const MASK_THRESHOLD = 0.5;

/** How a frame was fitted into the model's square input: input = frame * scale + pad. */
export type Fit = { scale: number; padX: number; padY: number };

/** A box in the model's input pixels, corners included. */
export type InputBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * Turns a probability grid over the model's square input into a MASK_SIDE x MASK_SIDE cut-out over the frame.
 * Each cut-out pixel looks up its centre in the input (undoing the fit), reads the grid there with bilinear
 * sampling, and is cat only inside the box and at or over the threshold.
 */
export function frameMask(
  prob: Float32Array,
  grid: number,
  inputSide: number,
  fit: Fit,
  box: InputBox,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(MASK_SIDE * MASK_SIDE);
  const cell = inputSide / grid;
  const at = (gx: number, gy: number) => prob[Math.min(grid - 1, Math.max(0, gy)) * grid + Math.min(grid - 1, Math.max(0, gx))];
  for (let j = 0; j < MASK_SIDE; j++) {
    const iy = ((j + 0.5) / MASK_SIDE) * height * fit.scale + fit.padY;
    if (iy < box.y0 || iy > box.y1) continue;
    const gy = iy / cell - 0.5;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let i = 0; i < MASK_SIDE; i++) {
      const ix = ((i + 0.5) / MASK_SIDE) * width * fit.scale + fit.padX;
      if (ix < box.x0 || ix > box.x1) continue;
      const gx = ix / cell - 0.5;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const p =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      if (p >= MASK_THRESHOLD) out[j * MASK_SIDE + i] = 255;
    }
  }
  return out;
}
