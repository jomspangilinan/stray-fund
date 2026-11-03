import type { ExactPlace } from "@/server/vetFlow";

/** Vet pages only. Exact coordinates never appear on a public page. */
export function ExactLocation({ exact }: { exact: ExactPlace }) {
  if (!exact) return <p className="text-sm text-dusk">No location on file. Ask a caretaker.</p>;
  return (
    <p className="text-sm">
      <span className="font-bold">Exact location:</span> {exact.lat.toFixed(5)}, {exact.lng.toFixed(5)}
      {exact.approximate && <span className="block text-dusk">Approximate. The finder shared no location, so this is the middle of the colony.</span>}
    </p>
  );
}
