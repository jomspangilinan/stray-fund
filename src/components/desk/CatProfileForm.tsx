"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ToneNote, type ReplyTone } from "./ToneNote";

const SEXES = ["unknown", "female", "male"] as const;
const FLAGS = ["pregnant", "injured", "sick", "kitten"] as const;
const FLAG_WORD: Record<string, string> = { pregnant: "Pregnant", injured: "Hurt", sick: "Sick", kitten: "A kitten" };
const CLAIM_WORD: Record<string, string> = { injured: "Hurt", pregnant: "Pregnant", sick: "Sick", kitten: "A kitten" };
const REPORT_STATE: Record<string, string> = { open: "open, waiting on To check", confirmed: "confirmed", dismissed: "dismissed", cleared: "cleared by a vet" };

const SEX_WORD: Record<string, string> = { female: "Female", male: "Male", unknown: "Not sure" };

/** Two small plain ears, as on the Spot screen. A tipped ear has its point cut straight across. */
function EarDrawing() {
  return (
    <svg viewBox="0 0 96 44" width="72" height="33" role="img" aria-label="Left, a tipped ear with a flat top. Right, an ear with a point." className="flex-none text-ink">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <path d="M10 40 L18 12 L36 12 L44 40 Z" />
        <path d="M56 40 L74 6 L92 40 Z" />
      </g>
    </svg>
  );
}

/** One choice, in the Spot screen's chip style. `multi` makes it a tick box instead of one-of-several. */
function Chip({ on, onClick, label, multi = false }: { on: boolean; onClick: () => void; label: string; multi?: boolean }) {
  return (
    <button type="button" role={multi ? "checkbox" : "radio"} aria-checked={on} onClick={onClick} className="chip whitespace-normal text-left">
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

/** A labelled group of chips on a pale panel, so white chips show on the white card. */
function Group({ title, note, lead, children }: { title: string; note?: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section role="group" aria-label={title} className="rounded-in bg-pale p-3">
      <h3 className="font-extrabold">{title}</h3>
      {(note || lead) && (
        <div className="mt-1 flex items-center gap-3">
          {lead}
          {note && <p className="small soft">{note}</p>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

export type ProfileCat = {
  id: string;
  name: string;
  sex: string;
  sexUnconfirmed: boolean;
  flags: string[];
  status: string;
  statusLabel: string;
  earTipped: boolean | null;
  neuteredUnconfirmed: boolean;
};
export type ProfileReport = { id: string; claim: string; status: string };

type Step = { action: string; body: Record<string, string | string[]> };

/** Which stage moves a caretaker can make from here, with the action each one sends. */
function stageMoves(status: string): { value: string; label: string; action: string }[] {
  if (status === "neutered") {
    return [
      { value: "adoptable", label: "Ready for a home", action: "cat_adoptable" },
      { value: "queued", label: "Not neutered after all, back to the queue", action: "cat_undo_neutered" },
    ];
  }
  if (status === "adoptable") {
    return [
      { value: "adopted", label: "Adopted", action: "cat_adopted" },
      { value: "neutered", label: "Not ready for a home yet, back to neutered", action: "cat_not_adoptable" },
    ];
  }
  if (status === "adopted") return [{ value: "adoptable", label: "Not adopted after all, back to ready for a home", action: "cat_not_adopted" }];
  return [];
}

/**
 * A cat's whole profile with one Save. Only what changed is sent, one action at a time, through the same routes as
 * everywhere else, so the server checks each one. The first refusal stops the rest and says what didn't go through.
 */
export function CatProfileForm({ cat, reports }: { cat: ProfileCat; reports: ProfileReport[] }) {
  const router = useRouter();
  // While money is moving (funded, booked, in care) the ear-tip record waits for the vet.
  const earEditable = ["spotted", "queued", "neutered", "adoptable", "adopted"].includes(cat.status);
  const beforeSurgery = cat.status === "spotted" || cat.status === "queued";
  const earNow = cat.earTipped === true && !cat.neuteredUnconfirmed ? "present" : cat.earTipped === false ? "absent" : "";

  const [name, setName] = useState(cat.name);
  const [sex, setSex] = useState(cat.sex);
  const [flags, setFlags] = useState<string[]>(cat.flags);
  const [ear, setEar] = useState(earNow);
  const [stage, setStage] = useState(cat.status);
  const [reopen, setReopen] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: ReplyTone; message: string } | null>(null);

  // After a save the page refreshes with the new values. Take them in, but keep the message on screen.
  const fresh = JSON.stringify([cat, reports]);
  const [shown, setShown] = useState(fresh);
  if (shown !== fresh) {
    setShown(fresh);
    setName(cat.name);
    setSex(cat.sex);
    setFlags(cat.flags);
    setEar(earNow);
    setStage(cat.status);
    setReopen([]);
  }

  const moves = stageMoves(cat.status);
  const sameFlags = flags.length === cat.flags.length && flags.every((f) => cat.flags.includes(f));

  function steps(): Step[] {
    const out: Step[] = [];
    if (name.trim() !== cat.name) out.push({ action: "cat_rename", body: { catId: cat.id, name: name.trim() } });
    if (sex !== cat.sex || !sameFlags) {
      out.push({ action: "cat_set_details", body: { catId: cat.id, sex, flags } });
    }
    if (ear !== earNow && (ear === "present" || ear === "absent")) out.push({ action: "cat_set_ear_tip", body: { catId: cat.id, earTip: ear } });
    const move = moves.find((m) => m.value === stage);
    if (move) out.push({ action: move.action, body: { catId: cat.id } });
    for (const id of reopen) out.push({ action: "report_reopen", body: { reportId: id } });
    return out;
  }
  const pending = steps();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (sending || pending.length === 0) return;
    setSending(true);
    setResult(null);
    const said: string[] = [];
    let tone: ReplyTone = "ok";
    try {
      for (const s of pending) {
        const res = await fetch(`/api/caretaker/${s.action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(s.body),
        });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; tone?: ReplyTone };
        if (!res.ok || json.ok !== true) {
          said.push(`${json.message ?? "Something went wrong."} Nothing after this was saved.`);
          tone = "bad";
          break;
        }
        said.push(json.message ?? "Saved.");
        if (json.tone === "warn") tone = "warn";
      }
    } catch {
      said.push("Could not reach the server. Check your connection and try again.");
      tone = "bad";
    } finally {
      setSending(false);
      setResult({ tone, message: said.join(" ") });
      setReopen([]);
      router.refresh();
    }
  }

  return (
    <form onSubmit={save} className="mt-4 grid gap-5" noValidate>
      <label className="grid gap-1">
        <span className="font-extrabold">Name</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" />
      </label>

      <Group title="Sex" note={cat.sexUnconfirmed ? `A neighbour said ${cat.sex}. Saving confirms it.` : undefined}>
        {SEXES.map((x) => (
          <Chip key={x} on={sex === x} onClick={() => setSex(x)} label={SEX_WORD[x]} />
        ))}
      </Group>

      <Group
        title="Ear tip"
        lead={<EarDrawing />}
        note={earEditable ? "A flat cut across the point of one ear means the cat is already neutered." : "The vet records this after surgery."}
      >
        {earEditable ? (
          <>
            <Chip on={ear === "present"} onClick={() => setEar("present")} label={beforeSurgery ? "Tipped, already neutered" : "Tipped"} />
            <Chip on={ear === "absent"} onClick={() => setEar("absent")} label={cat.status === "spotted" ? "Not tipped, join the queue" : "Not tipped"} />
          </>
        ) : (
          <p className="font-bold">{cat.earTipped === true ? "Tipped" : cat.earTipped === false ? "Not tipped" : "Not known yet"}</p>
        )}
      </Group>

      <Group title="Stage" note={moves.length === 0 ? "This one moves with the money and the vet, so it can't be set by hand." : undefined}>
        <Chip on={stage === cat.status} onClick={() => setStage(cat.status)} label={cat.statusLabel} />
        {moves.map((m) => (
          <Chip key={m.value} on={stage === m.value} onClick={() => setStage(m.value)} label={m.label} />
        ))}
      </Group>

      <Group title="Report something" note="Hurt, sick or pregnant files your report and holds the cat until a vet clears it.">
        {FLAGS.map((f) => (
          <Chip
            key={f}
            multi
            on={flags.includes(f)}
            onClick={() => setFlags((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]))}
            label={FLAG_WORD[f]}
          />
        ))}
      </Group>

      {reports.length > 0 && (
        <section>
          <h3 className="font-extrabold">Reports so far</h3>
          <ul className="mt-2 grid gap-2">
            {reports.map((r) => {
              const canReopen = r.status === "confirmed" || r.status === "dismissed";
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-in bg-pale px-3 py-2">
                  <span>
                    <span className="font-bold">{CLAIM_WORD[r.claim] ?? r.claim}</span>, {REPORT_STATE[r.status] ?? r.status}
                  </span>
                  {canReopen && (
                    <Chip
                      multi
                      on={reopen.includes(r.id)}
                      onClick={() => setReopen((cur) => (cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]))}
                      label="Reopen"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="grid gap-2">
        <button type="submit" className="btn w-full" disabled={sending || pending.length === 0}>
          {sending ? "Saving" : pending.length === 0 ? "Nothing changed" : "Save"}
        </button>
        {result && <ToneNote tone={result.tone} message={result.message} />}
        <p className="small soft">A report a vet has cleared, and money PayPal has already sent, can&apos;t be taken back.</p>
      </div>
    </form>
  );
}
