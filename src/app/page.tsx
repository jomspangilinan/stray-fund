import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export default function Home() {
  return (
    <main className="pt-6">
      <h1 className="text-5xl font-extrabold">{APP_NAME}</h1>
      <p className="mt-4 max-w-[34ch]">One shared fund that pays vets to neuter the colony&apos;s stray cats.</p>
      <Link href="/donate" className="btn mt-6 inline-flex items-center">
        Donate
      </Link>
    </main>
  );
}
