import type { Role } from "@/server/session";

/** The demo roles strip, in order. Simulated: each key names a seeded demo account, never a real sign-in. */
export const DEMO_ROLES = [
  { key: "neighbour", label: "Neighbour", username: "demo_neighbour", role: "donor" },
  { key: "caretaker", label: "Caretaker", username: "demo_caretaker", role: "caretaker" },
  { key: "vet", label: "Vet", username: "demo_vet", role: "vet" },
] as const satisfies readonly { key: string; label: string; username: string; role: Role }[];

/** What "Try it now" signs a visitor in as: an ordinary neighbour with no desk. */
export const GATE_PERSONA = "neighbour";
