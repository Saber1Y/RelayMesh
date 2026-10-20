import type { ComponentProps, ReactNode } from "react";
import type { Tone } from "@/lib/format";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-raised text-muted",
  accent: "bg-accent-soft text-accent",
  positive: "bg-positive-soft text-positive",
  caution: "bg-caution-soft text-caution",
  critical: "bg-critical-soft text-critical",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function Panel({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type ButtonProps = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" };

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const styles = {
    primary: "bg-accent text-accent-ink hover:bg-accent-hover",
    secondary: "border border-line-strong bg-surface text-ink hover:bg-raised",
    ghost: "text-accent hover:bg-accent-soft",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

/** Monospace text for hashes, addresses and amounts. */
export function Mono({ children, title, className = "" }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`font-mono text-[13px] ${className}`} title={title}>
      {children}
    </span>
  );
}

export function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor: string; help?: ReactNode; error?: string | undefined; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm text-critical">
          {error}
        </p>
      ) : (
        help && (
          <p id={`${htmlFor}-help`} className="text-sm text-muted">
            {help}
          </p>
        )
      )}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/80 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 aria-[invalid=true]:border-critical";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-raised ${className}`} aria-hidden />;
}
