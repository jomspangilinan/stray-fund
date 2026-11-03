import { LOCAL_DATA_DIR, readLocalPublic } from "@/server/storage";

/** Serves public photos written by the local storage driver. Development only. */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const { key } = await ctx.params;
  // The storage layer accepts only generated key shapes, so traversal never reaches the filesystem.
  const buf = await readLocalPublic(LOCAL_DATA_DIR, key.join("/"));
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}
