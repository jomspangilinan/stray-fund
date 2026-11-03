import { eq } from "drizzle-orm";
import { NEUTRAL_AVATAR, parseAvatar } from "@/lib/avatar";
import { otherCats, type KeepsakeData } from "@/lib/keepsake";
import { db } from "./db/client";
import { cats } from "./db/schema";
import { getCatCard, getYard } from "./public";
import { LOCAL_DATA_DIR, readLocalPublic } from "./storage";

const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

/**
 * Everything the keepsake may know. Public fields only: the name, the public photo's address in this app, and
 * look-alike palette names. A cat with no public photo has none.
 */
export async function getKeepsake(catId: string): Promise<KeepsakeData | null> {
  const card = await getCatCard(catId);
  if (!card || !card.cat.photoUrl) return null;
  const [row] = await db.select({ avatar: cats.avatar, sex: cats.sex }).from(cats).where(eq(cats.id, catId)).limit(1);
  if (!row) return null;
  const yard = await getYard(null);
  return {
    name: card.cat.name,
    photo: `/api/cats/${catId}/keepsake/photo`,
    hero: { id: catId, avatar: parseAvatar(row.avatar) ?? NEUTRAL_AVATAR, female: row.sex === "female" },
    others: otherCats(yard.cats, catId).map((c) => ({ id: c.id, avatar: c.avatar, female: c.female })),
  };
}

/**
 * The public photo's bytes, read by the server so the browser never fetches another origin. The address comes from
 * our own storage and a random key, never from a request. Null when it cannot be read.
 */
export async function readPublicPhoto(url: string): Promise<Buffer | null> {
  try {
    if (url.startsWith("/api/dev-photos/")) return await readLocalPublic(LOCAL_DATA_DIR, url.slice("/api/dev-photos/".length));
    if (!/^https:\/\//.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_PHOTO_BYTES ? buf : null;
  } catch {
    return null;
  }
}
