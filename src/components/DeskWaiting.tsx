import Link from "next/link";
import { caretakerWaiting } from "@/server/caretaker/queue";
import { getSession } from "@/server/session";
import { vetWaiting } from "@/server/vetFlow";

/** One small line on the yard for a caretaker or vet with work waiting. Nothing for anyone else, and nothing at zero. */
export async function DeskWaiting() {
  const session = await getSession();
  if (!session || (session.role !== "caretaker" && session.role !== "vet")) return null;
  if (session.role === "caretaker") {
    const n = await caretakerWaiting();
    return n === 0 ? null : <DeskLink href="/caretaker" text={`${n} to check`} />;
  }
  const { toSend, toCheck } = await vetWaiting(session.userId);
  const parts = [toCheck > 0 ? `${toCheck} ${toCheck === 1 ? "cat" : "cats"} to check` : null, toSend > 0 ? `${toSend} to send` : null].filter((p) => p !== null);
  return parts.length === 0 ? null : <DeskLink href="/vet" text={parts.join(", ")} />;
}

function DeskLink({ href, text }: { href: string; text: string }) {
  return (
    <Link href={href} className="link mb-2 flex !min-h-11 items-center font-bold">
      {text}
    </Link>
  );
}
