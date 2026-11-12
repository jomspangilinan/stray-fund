import type { Metadata } from "next";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { VetDesk } from "@/components/VetDesk";

export const metadata: Metadata = { title: "Bookings | Vet | Stray Fund" };

export default function VetBookingsPage() {
  return (
    <main>
      <PageHead title="Bookings" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <VetDesk view="bookings" />
      </Suspense>
    </main>
  );
}
