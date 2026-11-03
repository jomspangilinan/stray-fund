import { getSession } from "@/server/session";

/** Every caretaker screen sits inside this. The pages and the API check the role again. */
export async function DeskGate({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card mt-8">
        <p className="font-bold">This page is for caretakers.</p>
        <p className="small soft mt-1">In the demo, pick the Caretaker role in the bar at the top.</p>
      </div>
    );
  }
  if (session.role !== "caretaker") return <p className="note note-bad mt-8 font-bold">This page is for caretakers.</p>;
  return <>{children}</>;
}
