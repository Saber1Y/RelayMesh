import { ArrowRight, GithubLogo } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Brand } from "@/components/brand";

const SECTIONS = [
  { href: "#how", label: "How it works" },
  { href: "#tools", label: "Tools" },
  { href: "#proof", label: "Proof" },
] as const;

/** The public site: a floating header with section links and the one way into the app. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="fixed top-4 left-1/2 z-50 flex w-[min(980px,calc(100vw-1.5rem))] -translate-x-1/2 items-center justify-between gap-3 rounded-full border border-line bg-surface/80 py-2 pr-2 pl-3 shadow-panel backdrop-blur-xl sm:pl-4">
        <Brand />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
          {SECTIONS.map(({ href, label }) => (
            <a key={href} href={href} className="rounded-full px-3.5 py-1.5 text-sm text-muted transition-colors hover:text-ink">
              {label}
            </a>
          ))}
          <a
            href="https://github.com/Saber1Y/RelayMesh"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            <GithubLogo size={15} />
            Code
          </a>
        </nav>
        <Link
          href="/desk"
          className="press group inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-glow hover:-translate-y-0.5 hover:bg-accent-hover"
        >
          Open the app
          <ArrowRight size={14} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </>
  );
}
