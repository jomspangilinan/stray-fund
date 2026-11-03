import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "./db/client";
import { users } from "./db/schema";
import { ensureDemoPersonas } from "./demoPersonas";
import { isDemoMode } from "@/lib/config";

export const SESSION_COOKIE = "sf_session";
const SESSION_DAYS = 14;

export type Role = "donor" | "caretaker" | "vet" | "foster";
export type Session = { userId: string; role: Role; username: string };

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters");
  }
  return new TextEncoder().encode(s);
}

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({ role: session.role, username: session.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function readSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const { sub, role, username } = payload;
    if (typeof sub !== "string" || typeof role !== "string" || typeof username !== "string") {
      return null;
    }
    return { userId: sub, role: role as Role, username };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_DAYS * 24 * 60 * 60,
});

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

/** Returns the session, or throws AuthError 401 (signed out) or 403 (wrong role). */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AuthError(401, "Sign in first");
  if (!roles.includes(session.role)) throw new AuthError(403, "Not allowed");
  return session;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "staff", "moderator",
  "agent", "stray_fund", "strayfund", "caretaker", "vet", "foster", "donor",
  "paypal", "null", "undefined", "api", "me",
]);

export function validateUsername(raw: unknown): { ok: true; username: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !USERNAME_PATTERN.test(raw)) {
    return { ok: false, error: "Use 3 to 20 letters, digits or underscores" };
  }
  const lower = raw.toLowerCase();
  if (RESERVED.has(lower) || lower.startsWith("demo_")) {
    return { ok: false, error: "That name is reserved" };
  }
  return { ok: true, username: raw };
}

function pgCode(e: unknown): string | undefined {
  for (let cur = e; cur instanceof Error; cur = cur.cause) {
    const code = (cur as Error & { code?: string }).code;
    if (code) return code;
  }
  return undefined;
}

/**
 * Finds a donor by username (ignoring case) or creates one. The role is never
 * an input: new users are always donors, and existing staff accounts cannot be
 * entered by typing their name.
 */
export async function signInDonor(rawUsername: unknown): Promise<Session> {
  const v = validateUsername(rawUsername);
  if (!v.ok) throw new AuthError(403, v.error);

  const find = async () => {
    const [row] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${v.username.toLowerCase()}`);
    return row;
  };
  let row = await find();
  if (!row) {
    try {
      [row] = await db.insert(users).values({ username: v.username, role: "donor" }).returning();
    } catch (e) {
      if (pgCode(e) !== "23505") throw e;
      row = await find();
    }
  }
  if (!row || row.role !== "donor") throw new AuthError(403, "That name is taken");
  return { userId: row.id, role: "donor", username: row.username };
}

/** Demo only: a persona key names a seeded account. Never a role from the client. */
export const PERSONAS = {
  neighbour: "demo_neighbour",
  caretaker: "demo_caretaker",
  vet: "demo_vet",
} as const;
export type PersonaKey = keyof typeof PERSONAS;

export function isPersonaKey(k: unknown): k is PersonaKey {
  return typeof k === "string" && Object.hasOwn(PERSONAS, k);
}

export async function switchPersona(key: PersonaKey): Promise<Session> {
  if (!isDemoMode()) throw new AuthError(403, "Persona switching is off");
  await ensureDemoPersonas();
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.username} = ${PERSONAS[key]}`);
  return { userId: row.id, role: row.role as Role, username: row.username };
}
