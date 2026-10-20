import { GithubLogo, Graph } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-[100dvh] font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-lift"
        >
          Skip to content
        </a>
        <div className="relative z-10 flex min-h-[100dvh] flex-col">
          <header className="sticky top-0 z-40 border-b border-line/80 bg-canvas/75 backdrop-blur-md">
            <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
              <Link href="/" className="press flex items-center gap-2.5 rounded-lg" aria-label="RelayMesh home">
                <span className="flex size-7 items-center justify-center rounded-[7px] bg-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.2)_inset]">
                  <Graph size={16} weight="bold" />
                </span>
                <span className="text-[15px] font-semibold tracking-tight">RelayMesh</span>
              </Link>
              <div className="flex items-center gap-3">
                <NetworkStatus />
                <Link
                  href="/"
                  className="press rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.15)_inset] hover:bg-accent-hover"
                >
                  New intent
                </Link>
              </div>
            </div>
          </header>

          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-14">
            {children}
          </main>

          <footer className="border-t border-line/80">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-[13px] text-muted sm:px-6">
              <p>Testnet software on PortalDot V3. RelayMesh never holds keys or funds.</p>
              <a
                href="https://github.com/Saber1Y/RelayMesh"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md hover:text-ink"
              >
                <GithubLogo size={15} />
                Source
              </a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
