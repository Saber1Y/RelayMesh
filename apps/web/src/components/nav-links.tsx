"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/#how", label: "How it works", match: (p: string) => p === "/" },
  { href: "/desk", label: "Desk", match: (p: string) => p.startsWith("/desk") || p.startsWith("/intents") },
  { href: "/verify", label: "Verify", match: (p: string) => p.startsWith("/verify") },
] as const;

/** Section links with the current area marked, so users always know where they are. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
      {LINKS.map(({ href, label, match }) => {
        const active = href !== "/#how" && match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${active ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
          >
            {label}
          </Link>
        );
      })}
      <a
        href="https://github.com/Saber1Y/RelayMesh/blob/main/docs/evidence.md"
        target="_blank"
        rel="noreferrer"
        className="rounded-full px-3.5 py-1.5 text-sm text-muted transition-colors hover:text-ink"
      >
        Evidence
      </a>
    </nav>
  );
}
