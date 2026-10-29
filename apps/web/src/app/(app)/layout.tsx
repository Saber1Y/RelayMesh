import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { AppNav } from "@/components/app-nav";
import { Brand } from "@/components/brand";
import { NetworkStatus } from "@/components/network-status";

/**
 * The app: a sticky bar with its sections and the live chain status. No call to action here; the
 * user is already in the product.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-50 border-b border-line bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1160px] items-center justify-between gap-3 px-4 sm:px-6 md:px-10">
          <div className="flex items-center gap-6">
            <Brand />
            <AppNav variant="bar" />
          </div>
          <div className="flex items-center gap-1.5">
            <NetworkStatus />
            <a
              href="https://github.com/Saber1Y/RelayMesh"
              target="_blank"
              rel="noreferrer"
              aria-label="RelayMesh source on GitHub"
              className="press flex size-8 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-ink"
            >
              <GithubLogo size={17} />
            </a>
          </div>
        </div>
        <AppNav variant="row" />
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </>
  );
}
