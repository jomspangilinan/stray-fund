export class BodyTooLarge extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "BodyTooLarge";
  }
}

/** Reads a request body, giving up as soon as it passes the limit instead of buffering all of it. */
export async function readLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parses a body already read by readLimited as a multipart form. Null if it is not one. */
export async function parseForm(req: Request, raw: Uint8Array): Promise<FormData | null> {
  try {
    return await new Request(req.url, {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") ?? "" },
      body: raw as BodyInit,
    }).formData();
  } catch {
    return null;
  }
}
