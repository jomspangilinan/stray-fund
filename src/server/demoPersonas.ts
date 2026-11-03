import { and, eq } from "drizzle-orm";
import { db } from "./db/client";
import { allowedPayees, users } from "./db/schema";

/** Seeds the demo caretaker and vet. Safe to call any number of times. */
export async function ensureDemoPersonas(): Promise<void> {
  const vetEmail = process.env.PAYPAL_VET_EMAIL || null;
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ username: "demo_caretaker", role: "caretaker" })
      .onConflictDoNothing();
    await tx
      .insert(users)
      .values({ username: "demo_vet", role: "vet", paypalEmail: vetEmail })
      .onConflictDoNothing();
    const [vet] = await tx.select().from(users).where(eq(users.username, "demo_vet"));
    if (vetEmail && vet.paypalEmail !== vetEmail) {
      await tx.update(users).set({ paypalEmail: vetEmail }).where(eq(users.id, vet.id));
    }
    const [existing] = await tx
      .select()
      .from(allowedPayees)
      .where(and(eq(allowedPayees.userId, vet.id), eq(allowedPayees.kind, "vet")));
    if (!existing) {
      await tx.insert(allowedPayees).values({ userId: vet.id, kind: "vet" }).onConflictDoNothing();
    }
  });
}
