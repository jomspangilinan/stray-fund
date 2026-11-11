import Link from "next/link";
import type { PageLink } from "@/lib/nav";

/** The top of an app screen: where you are, and one plain line about it. Not a hero. An optional action sits on the title's row. */
export function PageHead({ title, action, children }: { title: string; action?: PageLink; children?: React.ReactNode }) {
  return (
    <div className="pt-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="title">{title}</h1>
        {action && (
          <Link href={action.href} className="btn-pop flex-none !min-h-11">
            {action.label}
          </Link>
        )}
      </div>
      {children && <p className="mt-1.5 max-w-[46ch] soft">{children}</p>}
    </div>
  );
}
