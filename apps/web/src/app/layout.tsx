import { GithubLogo, Graph } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { NavLinks } from "@/components/nav-links";
import { NetworkStatus } from "@/components/network-status";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "RelayMesh",
  description: "Intent-based transfers on PortalDot V3 with verifiable settlement receipts.",
  openGraph: {
    title: "RelayMesh",
    description: "One intent. A verified route. A receipt that proves it landed.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} data-scroll-behavior="smooth">
      <body className="min-h-[100dvh] font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <header className="fixed top-4 left-1/2 z-50 flex w-[min(980px,calc(100vw-1.5rem))] -translate-x-1/2 items-center justify-between gap-3 rounded-full border border-line bg-surface/80 py-2 pr-2 pl-3 shadow-panel backdrop-blur-xl sm:pl-4">
          <Link href="/" className="press flex items-center gap-2.5 rounded-full text-[15px] font-semibold tracking-[-0.02em]" aria-label="RelayMesh home">
            <span className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-ink shadow-glow">
              <Graph size={16} weight="bold" />
            </span>
            <span className="hidden sm:inline">RelayMesh</span>
          </Link>
          <NavLinks />
          <div className="flex items-center gap-2">
            <NetworkStatus />
            <Link
              href="/desk"
              className="press rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-glow hover:-translate-y-0.5 hover:bg-accent-hover"
            >
              Launch desk
            </Link>
          </div>
        </header>

        <div className="relative z-10 flex min-h-[100dvh] flex-col">
          <main id="main" className="flex-1">
            {children}
          </main>

          <footer className="border-t border-line">
            <div className="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-3 px-5 py-6 text-[13px] text-muted md:px-10">
              <p>Testnet software on PortalDot V3. RelayMesh never holds keys or funds.</p>
              <a href="https://github.com/Saber1Y/RelayMesh" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink">
                <GithubLogo size={14} />
                Source
              </a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
