import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="enter mx-auto grid max-w-xl gap-4 px-5 pt-36 pb-24">
      <p className="text-sm font-semibold text-accent">404 / Not found</p>
      <h1 className="text-4xl font-semibold tracking-[-0.05em]">No intent here</h1>
      <p className="text-muted">Intent links look like /intents/0x followed by 32 hex characters. Check the link, or start a new transfer.</p>
      <Link href="/desk" className="press inline-flex w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline">
        <ArrowLeft size={14} />
        Create a new intent
      </Link>
    </div>
  );
}
