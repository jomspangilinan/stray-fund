/** A designed loading state: rows that look like the list that is coming. */
export function ListSkeleton({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="mt-6" role="status" aria-label={label}>
      <ul className="list" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 p-3">
            <span className="skeleton h-[52px] w-[52px] flex-none" />
            <span className="grid flex-1 gap-2">
              <span className="skeleton h-4 w-2/5" />
              <span className="skeleton h-3 w-3/5" />
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function BlockSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="mt-6 grid gap-3" role="status" aria-label={label}>
      <span className="skeleton h-28 w-full !rounded-out" aria-hidden="true" />
      <span className="skeleton h-4 w-3/5" aria-hidden="true" />
      <span className="skeleton h-4 w-2/5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
