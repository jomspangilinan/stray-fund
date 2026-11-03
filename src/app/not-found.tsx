import Link from "next/link";

export default function NotFound() {
  return (
    <main className="pt-8">
      <div className="card">
        <h1 className="title">We could not find that page</h1>
        <p className="mt-2 soft">The link may be old, or the cat may not have a card yet.</p>
        <Link href="/cats" className="btn mt-4">
          See the cats
        </Link>
      </div>
    </main>
  );
}
