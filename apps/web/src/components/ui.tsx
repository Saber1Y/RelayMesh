import type { ComponentProps, CSSProperties, ReactNode } from "react";
import type { Tone } from "@/lib/format";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-raised text-muted",
  accent: "bg-accent-soft text-accent",
  positive: "bg-positive-soft text-positive",
  caution: "bg-caution-soft text-caution",
  critical: "bg-critical-soft text-critical",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex w-fit items-center rounded-lg px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

/** Stagger index for the `enter` utility. */
export function stagger(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
  index = 0,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <section className={`enter rounded-[14px] border border-line bg-surface shadow-panel ${className}`} style={stagger(index)}>
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-3.5 sm:px-6">
          <div className="grid min-w-[min(100%,16rem)] flex-1 gap-0.5">
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={`px-5 pb-5 sm:px-6 sm:pb-6 ${title || action ? "" : "pt-5 sm:pt-6"}`}>{children}</div>
    </section>
  );
}

type ButtonProps = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" };

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const styles = {
    primary: "bg-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.15)_inset,0_1px_2px_rgb(20_32_72/0.2)] hover:bg-accent-hover",
    secondary: "border border-line-strong bg-surface text-ink hover:border-muted/40 hover:bg-raised",
    ghost: "text-accent hover:bg-accent-soft",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`press group inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

/** Monospace text for hashes, addresses and amounts. */
export function Mono({ children, title, className = "" }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`font-mono text-[13px] tabular-nums ${className}`} title={title}>
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
          <p id={`${htmlFor}-help`} className="text-[13px] text-muted">
            {help}
          </p>
        )
      )}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink shadow-[0_1px_0_rgb(20_32_72/0.03)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted/70 hover:border-muted/40 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 aria-[invalid=true]:border-critical aria-[invalid=true]:focus:ring-critical/15";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-raised ${className}`} aria-hidden />;
}

/** Small key/value row used in summaries. */
export function Stat({ label, children, emphasis = false }: { label: string; children: ReactNode; emphasis?: boolean }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={emphasis ? "text-xl font-semibold tracking-tight tabular-nums" : "text-sm"}>{children}</dd>
    </div>
  );
}
