"use client";

import { usePathname, useRouter } from "next/navigation";
import { DEMO_ROLES } from "@/lib/demoRoles";
import { JUDGE_ONLY_LINE } from "@/lib/judgeLine";
import { landingAfterSwitch } from "@/lib/nav";
import { useState } from "react";

/** The one demo badge (test money is claimed only when moneyIsTest() is true). Demo only, and simulated: it switches to a demo account and is not a real sign-in. The layout renders this only when DEMO_MODE is on; the API checks it again. */
export function PersonaSwitcher({ current, testMoney, judge }: { current: string | null; testMoney: boolean; judge: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);

  async function pick(key: (typeof DEMO_ROLES)[number]["key"], role: (typeof DEMO_ROLES)[number]["role"]) {
    setError(null);
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: key }),
    });
    if (!res.ok) {
      setError("Could not switch");
      return;
    }
    // The desk roles land on their desk; the layout and the page read the new cookie on this navigation.
    router.push(landingAfterSwitch(role, pathname));
    router.refresh();
  }

  return (
    <div className="bg-pale">
      <div className="mx-auto flex max-w-2xl items-center gap-x-2 px-4 py-1 text-[0.8125rem]">
        <span className="font-semibold text-soft">{testMoney ? "Test money · Demo roles" : "Demo roles"}</span>
        <div role="group" aria-label="View the app as" className="flex gap-1">
          {DEMO_ROLES.filter((p) => judge || p.role === "donor").map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pick(p.key, p.role)}
              aria-pressed={current === p.username}
              className="press min-h-8 rounded-in px-2.5 font-bold text-main aria-pressed:bg-main aria-pressed:text-white"
            >
              {p.label}
            </button>
          ))}
        </div>
        {!judge && <span className="small soft">{JUDGE_ONLY_LINE}</span>}
        {error && (
          <span role="alert" className="font-bold text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
