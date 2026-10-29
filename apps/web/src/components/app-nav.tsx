"use client";

import { MagnifyingGlass, PaperPlaneTilt, SealCheck } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/desk", label: "Desk", icon: PaperPlaneTilt, match: (p: string) => p.startsWith("/desk") || p.startsWith("/intents") },
  { href: "/verify", label: "Verify", icon: SealCheck, match: (p: string) => p.startsWith("/verify") },
  { href: "/bridge", label: "Bridge", icon: MagnifyingGlass, match: (p: string) => p.startsWith("/bridge") },
] as const;

/**
 * The app's sections with the current one marked. Inline in the bar on wider screens; on phones the
 * same tabs sit in their own row under the bar, so every section stays one tap away.
 */
export function AppNav({ variant }: { variant: "bar" | "row" }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="App"
      className={variant === "bar" ? "hidden items-center gap-1 md:flex" : "flex gap-1 overflow-x-auto border-t border-line px-3 py-2 md:hidden"}
    >
      {TABS.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`press inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors ${
              active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-raised hover:text-ink"
            }`}
          >
            <Icon size={15} weight={active ? "bold" : "regular"} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
