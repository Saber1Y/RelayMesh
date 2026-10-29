import { Graph } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

/** The RelayMesh mark and name, linking home. Shared by the marketing and app headers. */
export function Brand({ showName = true }: { showName?: boolean }) {
  return (
    <Link href="/" className="press flex items-center gap-2.5 rounded-full text-[15px] font-semibold tracking-[-0.02em]" aria-label="RelayMesh home">
      <span className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-ink shadow-glow">
        <Graph size={16} weight="bold" />
      </span>
      {showName && <span>RelayMesh</span>}
    </Link>
  );
}
