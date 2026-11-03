"use client";

import { useRef, useState } from "react";
import type { NameControls } from "@/server/catNames";
import { NameSuggest } from "./NameSuggest";
import { RenameAgain } from "./RenameAgain";

/**
 * The cat's name on the card. Signed-in people get a small pencil beside it that opens one inline panel:
 * suggest a name, and for the finder who still can, Another name. Signed-out visitors (names undefined)
 * see just the name. After a suggestion is sent the panel closes and a quiet line shows it to that person only.
 */
export function CatNameEditor({
  catId,
  name,
  names,
}: {
  catId: string;
  name: string;
  names?: NameControls;
}) {
  const [open, setOpen] = useState(false);
  const [sentName, setSentName] = useState<string | null>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  const pending = names ? (names.pending ?? sentName) : null;

  // The optimistic line lasts only until the refreshed page brings a new names object; then the server alone decides.
  const [seen, setSeen] = useState(names);
  if (names !== seen) {
    setSeen(names);
    setSentName(null);
  }

  function close() {
    setOpen(false);
    pencil.current?.focus();
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1">
        <h1 className="title">{name}</h1>
        {names && (
          <button
            ref={pencil}
            type="button"
            className="icon-btn"
            aria-label="Change name"
            aria-expanded={open}
            aria-controls="name-panel"
            onClick={() => (open ? close() : setOpen(true))}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
              <path d="M14.5 7.5l3 3" />
            </svg>
          </button>
        )}
      </div>
      {open && names && (
        <div
          id="name-panel"
          className="name-panel mt-2 grid gap-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <NameSuggest
            catId={catId}
            onSent={(n) => {
              setSentName(n);
              close();
            }}
          />
          {names.canRename && <RenameAgain catId={catId} />}
          <button
            type="button"
            className="link justify-self-start"
            onClick={close}
          >
            Close
          </button>
        </div>
      )}
      {!open && pending && (
        <p className="small soft mt-1">Waiting for a caretaker: {pending}</p>
      )}
    </div>
  );
}
