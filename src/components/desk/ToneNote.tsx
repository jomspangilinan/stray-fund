export type ReplyTone = "ok" | "warn" | "bad";

const LEAD: Record<Exclude<ReplyTone, "ok">, string> = { warn: "Needs a look", bad: "Did not go through" };

/** The answer to an action. A success is one short note; a warning or a failure says so in words and is announced at once. */
export function ToneNote({ tone, message }: { tone: ReplyTone; message: string }) {
  if (tone === "ok") {
    return (
      <p role="status" className="note note-ok font-bold">
        {message}
      </p>
    );
  }
  return (
    <div role="alert" className="note note-bad">
      <p className="font-bold">{LEAD[tone]}</p>
      <p>{message}</p>
    </div>
  );
}
