"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

/** Copies a value (hash, address) to the clipboard and confirms briefly in place. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => undefined)}
      className="press inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
      aria-label={copied ? "Copied" : `${label} ${value}`}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check size={13} weight="bold" className="text-positive" /> : <Copy size={13} />}
    </button>
  );
}
