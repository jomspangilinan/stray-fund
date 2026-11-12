import { getSession } from "@/server/session";
import { DeskSwitch } from "./DeskSwitch";

/** Reads the session cookie, so render it inside Suspense. The header link between the desk and the neighbour view. */
export async function DeskSwitchSlot() {
  const session = await getSession();
  return <DeskSwitch role={session?.role ?? null} />;
}
