import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return (
    <>
      <header className="mx-auto flex h-14 w-full max-w-[1160px] items-center px-4 sm:px-6 md:px-10">
        <Brand />
      </header>
      <main id="main" className="enter mx-auto grid max-w-xl gap-4 px-5 pt-20 pb-24">
        <p className="text-sm font-semibold text-accent">404 / Not found</p>
        <h1 className="text-4xl font-semibold tracking-[-0.05em]">Nothing at this address</h1>
        <p className="text-muted">
          The link may be mistyped, or the intent may belong to another deployment. Intent links look like /intents/0x followed by 32 hex characters.
        </p>
        <div className="flex flex-wrap gap-4">
          <Link href="/desk" className="press inline-flex w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline">
            <ArrowLeft size={14} />
            Go to the desk
          </Link>
          <Link href="/" className="press inline-flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted hover:text-ink">
            RelayMesh home
          </Link>
        </div>
      </main>
    </>
  );
}
