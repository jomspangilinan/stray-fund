import type { Metadata } from "next";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { VetDesk } from "@/components/VetDesk";

export const metadata: Metadata = { title: "To do | Vet | Stray Fund" };

export default function VetPage() {
  return (
    <main>
      <PageHead title="To do" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <VetDesk view="todo" />
      </Suspense>
    </main>
  );
}
