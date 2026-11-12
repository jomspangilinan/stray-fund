export class BodyTooLarge extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "BodyTooLarge";
  }
}

export const JSON_BODY_MAX = 4 * 1024;
export const WEBHOOK_BODY_MAX = 64 * 1024;

export class UnsupportedMediaType extends Error {
  constructor() {
    super("Send the request as JSON.");
    this.name = "UnsupportedMediaType";
  }
}

/**
 * Reads a JSON body. A non-JSON content type is refused so a form on another site cannot post to a
 * cookie route, and the read stops at maxBytes. A body that does not parse throws a SyntaxError.
 */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new UnsupportedMediaType();
  }
  return JSON.parse(Buffer.from(await readLimited(req, maxBytes)).toString("utf8"));
}

/** Like readJson, but a body that is not valid JSON gives null so the caller can answer its own 400. */
export async function readJsonOrNull(req: Request, maxBytes: number): Promise<unknown> {
  try {
    return await readJson(req, maxBytes);
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

/** The status and one-sentence message for a refused body, or null when the error is something else. */
export function bodyRefusal(e: unknown): { status: number; message: string } | null {
  if (e instanceof UnsupportedMediaType) return { status: 415, message: "Send the request as JSON." };
  if (e instanceof BodyTooLarge) return { status: 413, message: "That request is too large." };
  return null;
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
