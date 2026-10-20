import type { ReactNode } from "react";

/** Content container for app pages. Top padding clears the floating pill navigation. */
export function PageShell({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`mx-auto w-full px-4 pt-28 pb-16 sm:px-6 md:px-10 ${narrow ? "max-w-[880px]" : "max-w-[1160px]"}`}>{children}</div>;
}
