import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto grid max-w-xl gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-muted">There is no intent at this address. Intent links look like /intents/0x followed by 32 hex characters.</p>
      <Link href="/" className="text-accent hover:underline">
        Create a new intent
      </Link>
    </div>
  );
}
