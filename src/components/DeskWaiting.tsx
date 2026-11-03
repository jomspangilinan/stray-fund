import Link from "next/link";
import { caretakerWaiting } from "@/server/caretaker/queue";
import { getSession } from "@/server/session";
import { vetWaiting } from "@/server/vetFlow";

/** One small line on the yard for a caretaker or vet with work waiting. Nothing for anyone else, and nothing at zero. */
export async function DeskWaiting() {
  const session = await getSession();
  if (!session || (session.role !== "caretaker" && session.role !== "vet")) return null;
  const caretaker = session.role === "caretaker";
  const n = caretaker ? await caretakerWaiting() : await vetWaiting(session.userId);
  if (n === 0) return null;
  return (
    <Link href={caretaker ? "/caretaker" : "/vet"} className="link mb-2 flex !min-h-11 items-center font-bold">
      {n} {caretaker ? "to check" : "to send"}
    </Link>
  );
}
