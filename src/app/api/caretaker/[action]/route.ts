import { NextResponse } from "next/server";
import { isAction, runAction } from "@/server/caretaker";
import { BodyTooLarge, readLimited } from "@/server/http";
import { AuthError, requireRole } from "@/server/session";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY = 32 * 1024;
const reply = (status: number, message: string, ok = false) =>
  NextResponse.json({ ok, message }, { status, headers: NO_STORE });

/**
 * Every caretaker action. The role is checked here on the server, and a JSON content type is
 * required so that a form on another site cannot post to it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  let session;
  try {
    session = await requireRole("caretaker");
  } catch (e) {
    if (e instanceof AuthError) return reply(e.status, e.message);
    throw e;
  }
  const { action } = await ctx.params;
  if (!isAction(action)) return reply(404, "There is no such action.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return reply(415, "Send the request as JSON.");
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(await readLimited(req, MAX_BODY)).toString("utf8"));
  } catch (e) {
    return e instanceof BodyTooLarge ? reply(413, "That request is too large.") : reply(400, "Send a valid JSON object.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(400, "Send a valid JSON object.");

  const out = await runAction(action, session.userId, body as Record<string, unknown>);
  return reply(out.status, out.message, out.ok);
}
