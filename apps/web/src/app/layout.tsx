import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

        <div className="relative z-10 flex min-h-[100dvh] flex-col">
          {/* Each section's layout renders its own header, then <main id="main">. */}
          <div className="flex flex-1 flex-col">{children}</div>

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
