import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export default function Home() {
  return (
    <main className="pt-6">
      <h1 className="text-5xl font-extrabold">{APP_NAME}</h1>
      <p className="mt-4 max-w-[34ch]">One shared fund that pays vets to neuter the colony&apos;s stray cats.</p>
      <div className="mt-6 flex flex-wrap gap-4">
        <Link href="/catch" className="btn inline-flex items-center">
          Catch a cat
        </Link>
        <Link href="/donate" className="btn-quiet inline-flex items-center">
          Donate
        </Link>
      </div>
    </main>
  );
}
