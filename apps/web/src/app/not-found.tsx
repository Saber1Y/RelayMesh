import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="enter mx-auto grid max-w-xl gap-4 py-16">
      <p className="font-mono text-sm text-muted">404</p>
      <h1 className="text-3xl font-semibold tracking-[-0.03em]">No intent here</h1>
      <p className="text-muted">Intent links look like /intents/0x followed by 32 hex characters. Check the link, or start a new transfer.</p>
      <Link href="/" className="press inline-flex w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline">
        <ArrowLeft size={14} />
        Create a new intent
      </Link>
    </div>
  );
}
