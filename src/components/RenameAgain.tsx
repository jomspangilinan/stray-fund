"use client";

import { useRouter } from "next/navigation";
import { AnotherNameButton } from "./AnotherNameButton";

/** Another name on the cat card: the new name shows once the page refreshes. */
export function RenameAgain({ catId }: { catId: string }) {
  const router = useRouter();
  return <AnotherNameButton catId={catId} onNamed={() => router.refresh()} />;
}
