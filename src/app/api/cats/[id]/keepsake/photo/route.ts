import { getCatCard, isUuid } from "@/server/public";
import { readPublicPhoto } from "@/server/keepsake";

/** The cat's public, blurred photo from this app's own address, so a canvas can read it without any CORS rule. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  const url = (await getCatCard(id))?.cat.photoUrl;
  const buf = url ? await readPublicPhoto(url) : null;
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" },
  });
}
