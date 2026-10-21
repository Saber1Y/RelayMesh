import type { ComponentProps, CSSProperties, ReactNode } from "react";
import type { Tone } from "@/lib/format";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-raised/60 text-muted",
  accent: "border-accent/30 bg-accent-soft text-accent",
  positive: "border-positive/30 bg-positive-soft text-positive",
  caution: "border-caution/30 bg-caution-soft text-caution",
  critical: "border-critical/30 bg-critical-soft text-critical",
};

const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  positive: "bg-positive",
  caution: "bg-caution",
  critical: "bg-critical",
};

/** Mono status tag. A dot is shown only when `live` (a real state that is still changing). */
export function Badge({ tone, children, live = false }: { tone: Tone; children: ReactNode; live?: boolean }) {
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {live && (
        <span className="relative flex size-1.5" aria-hidden>
          <span className={`live-ring absolute inset-0 rounded-full ${DOT_CLASS[tone]}`} />
          <span className={`relative size-1.5 rounded-full ${DOT_CLASS[tone]}`} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Stagger index for the `enter` utility. */
export function stagger(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

/** HUD window: mono micro-label title, optional live tag and action, translucent body. */
export function Panel({
  title,
  icon,
  tag,
  description,
  action,
  children,
  className = "",
  index = 0,
}: {
  title?: string;
  icon?: ReactNode;
  tag?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  index?: number;
}) {
  const hasHeader = title || action || tag;
  return (
    <section
      className={`enter rounded-[18px] border border-line bg-surface shadow-panel ${className}`}
      style={stagger(index)}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-4 sm:px-6">
          <div className="grid min-w-[min(100%,10rem)] flex-1 gap-1.5">
            {title && (
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                {icon && <span className="text-accent [&>svg]:size-3.5">{icon}</span>}
                {title}
              </h2>
            )}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          <div className="flex items-center gap-2">
            {tag}
            {action}
          </div>
        </div>
      )}
      <div className={`px-5 pb-5 sm:px-6 sm:pb-6 ${hasHeader ? "" : "pt-5 sm:pt-6"}`}>{children}</div>
    </section>
  );
}

type ButtonProps = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" };

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const styles = {
    primary: "rounded-full bg-accent text-accent-ink shadow-glow hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-glow-strong",
    secondary: "rounded-full border border-line-strong text-ink hover:bg-raised",
    ghost: "rounded-full text-accent hover:bg-accent-soft",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`press group inline-flex items-center justify-center gap-2 px-5 py-2 text-sm font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none ${styles} ${className}`}
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
  "w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink transition-[border-color,box-shadow] duration-150 hover:border-accent-tint focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 aria-[invalid=true]:border-critical aria-[invalid=true]:focus:ring-critical/15";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-raised ${className}`} aria-hidden />;
}

/** Metric with a top rule: mono label, large value. */
export function Stat({ label, children, emphasis = false }: { label: string; children: ReactNode; emphasis?: boolean }) {
  return (
    <div className="grid content-start gap-2 border-t border-line pt-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={emphasis ? "text-2xl font-semibold tracking-[-0.04em] text-accent tabular-nums" : "text-sm"}>{children}</dd>
    </div>
  );
}
