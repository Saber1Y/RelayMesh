import { formatBaseUnits, getAsset, type ChainId, type IntentStatus } from "@relaymesh/core";

export function shortHash(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Amounts arrive from the API as decimal strings; they are converted with bigint, never Number. */
export function formatAmount(amount: string | bigint, chain: ChainId, asset = "native"): string {
  const { decimals, symbol } = getAsset(chain, asset);
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  const [whole, fraction = ""] = formatBaseUnits(value, decimals).split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  const wholeGrouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const approx = fraction.length > 6 && /[1-9]/.test(fraction.slice(6)) ? "≈ " : "";
  return `${approx}${wholeGrouped}${trimmed ? `.${trimmed}` : ""} ${symbol}`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Fixed UTC format: identical on server and client (no locale), and unambiguous in receipts. */
export function formatTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(11, 19)} UTC`;
}

export type Tone = "neutral" | "accent" | "positive" | "caution" | "critical";

export const STATUS_META: Record<IntentStatus, { label: string; tone: Tone; description: string }> = {
  DRAFT: { label: "Draft", tone: "neutral", description: "Intent recorded. No route quoted yet." },
  QUOTED: { label: "Quoted", tone: "accent", description: "Routes quoted. Pick one to review." },
  AWAITING_SIGNATURE: { label: "Awaiting signature", tone: "accent", description: "Review the call and sign it in your wallet." },
  SOURCE_SUBMITTED: { label: "In block", tone: "caution", description: "Included in a block. Waiting for finality." },
  SOURCE_CONFIRMED: { label: "Source final", tone: "caution", description: "Source transaction finalized." },
  DESTINATION_PENDING: { label: "Checking destination", tone: "caution", description: "Waiting to observe funds on the destination." },
  SETTLED: { label: "Settled", tone: "positive", description: "Destination funds observed and finalized." },
  EXPIRED: { label: "Expired", tone: "neutral", description: "The deadline passed before anything was signed." },
  FAILED_BEFORE_SOURCE: { label: "Failed", tone: "critical", description: "The source transaction failed. No funds moved." },
  NEEDS_REVIEW: { label: "Needs review", tone: "critical", description: "Evidence disagrees. Held for manual review." },
};

/**
 * polkadot.js explorer link for a V3 block. Prefer the block number: it is the same for the Substrate
 * and EVM views of a block, while EVM evidence carries an EVM-style hash the explorer cannot look up.
 */
export function explorerBlockUrl(wsUrl: string, block: string | number | bigint): string {
  return `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(wsUrl)}#/explorer/query/${block.toString()}`;
}
