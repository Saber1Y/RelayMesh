import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { v3Config } from "@/server/services";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "RelayMesh",
  description: "Intent-based transfers on PortalDot V3 with verifiable settlement receipts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-[100dvh] font-sans antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link href="/" className="text-[15px] font-semibold tracking-tight">
              RelayMesh
            </Link>
            <div className="flex items-center gap-3 text-sm">
              <span className="hidden text-muted sm:inline">PortalDot V3 testnet</span>
              <span className="rounded-lg border border-line px-2 py-1 font-mono text-xs text-muted" title="EVM chain ID">
                {v3Config.evmChainId}
              </span>
              <Link
                href="/"
                className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-ink transition-colors hover:bg-accent-hover active:translate-y-px"
              >
                New intent
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      </body>
    </html>
  );
}
