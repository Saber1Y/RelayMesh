"use client";

import { CircleNotch, Play } from "@phosphor-icons/react";
import { useState } from "react";
import { CopyButton } from "./copy-button";

type Run = { kind: "idle" } | { kind: "running" } | { kind: "done"; status: number; ms: number; body: string; receiptHash: string | null } | { kind: "error"; message: string };

const PREVIEW_LINES = 24;

/** Calls a GET endpoint of this deployment from the browser and shows the raw answer. */
export function TryEndpoint({ path }: { path: string }) {
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [expanded, setExpanded] = useState(false);

  async function call() {
    setRun({ kind: "running" });
    setExpanded(false);
    const started = performance.now();
    try {
      const response = await fetch(path, { cache: "no-store" });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON: shown as returned.
      }
      setRun({ kind: "done", status: response.status, ms: Math.round(performance.now() - started), body, receiptHash: response.headers.get("x-receipt-hash") });
    } catch {
      setRun({ kind: "error", message: "The request did not complete. Check your connection and try again." });
    }
  }

  const lines = run.kind === "done" ? run.body.split("\n") : [];
  const clipped = !expanded && lines.length > PREVIEW_LINES;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={call}
          disabled={run.kind === "running"}
          className="press inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-raised disabled:opacity-45"
        >
          {run.kind === "running" ? <CircleNotch size={13} className="animate-spin" /> : <Play size={13} weight="fill" className="text-accent" />}
          {run.kind === "running" ? "Calling" : "Run it live"}
        </button>
        {run.kind === "done" && (
          <span className="text-[13px] text-muted tabular-nums">
            <span className={run.status < 400 ? "text-positive" : "text-critical"}>HTTP {run.status}</span> · {run.ms} ms
            {run.receiptHash && (
              <>
                {" "}
                · <span className="font-mono text-[12px]">X-Receipt-Hash {run.receiptHash.slice(0, 10)}…</span>
              </>
            )}
          </span>
        )}
        {run.kind === "error" && <span className="text-[13px] text-critical">{run.message}</span>}
      </div>
      {run.kind === "done" && (
        <div className="relative overflow-hidden rounded-xl border border-line bg-raised/50">
          <div className="absolute top-2 right-2">
            <CopyButton value={run.body} label="Copy response" />
          </div>
          <pre className="max-h-[480px] overflow-auto p-4 pr-10 font-mono text-[12px] leading-relaxed text-ink/90">{clipped ? lines.slice(0, PREVIEW_LINES).join("\n") : run.body}</pre>
          {clipped && (
            <button type="button" onClick={() => setExpanded(true)} className="w-full border-t border-line py-2 text-[13px] text-accent hover:bg-raised">
              Show all {lines.length} lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}
