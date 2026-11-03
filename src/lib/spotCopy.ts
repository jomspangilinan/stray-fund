export type RevealState = "new_cat" | "matched" | "needs_review";

/** The words above the card. Only the real result picks them, and a name is used only when the server sent one. */
export function revealCopy(state: RevealState, name: string | null): { heading: string; sub: string } {
  if (state === "new_cat") {
    return { heading: "New cat spotted!", sub: "New card started. Thanks for spotting." };
  }
  if (state === "matched") {
    return { heading: name ? `It's ${name} again!` : "We know this cat!", sub: "Your sighting is noted on their card." };
  }
  return { heading: "A caretaker will take a look.", sub: "Thanks. We have your photo." };
}
