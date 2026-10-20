import { sourceFeeTotal, type Intent, type Quote } from "@relaymesh/core";
import type { QuoteContext, RouteProvider, RouteRejectionCode } from "./types";

export interface ProviderRejection {
  provider: string;
  code: RouteRejectionCode;
  reason: string;
}

export interface CollectedQuotes {
  /** Best first. See rankQuotes for the ordering. */
  ranked: Quote[];
  /** Every provider that produced no quote, and why. Shown to the user, never hidden. */
  rejections: ProviderRejection[];
}

/**
 * Deterministic, explainable ranking: highest expected destination output, then lowest fees in
 * the source asset, then the longest remaining validity, then quote ID as a stable tie-breaker.
 */
export function rankQuotes(quotes: readonly Quote[], intent: Intent): Quote[] {
  return [...quotes].sort((a, b) => {
    if (a.expectedOutput !== b.expectedOutput) return a.expectedOutput > b.expectedOutput ? -1 : 1;
    const feeA = sourceFeeTotal(a, intent);
    const feeB = sourceFeeTotal(b, intent);
    if (feeA !== feeB) return feeA < feeB ? -1 : 1;
    if (a.expiresAt !== b.expiresAt) return b.expiresAt - a.expiresAt;
    return a.quoteId < b.quoteId ? -1 : a.quoteId > b.quoteId ? 1 : 0;
  });
}

/** Asks every provider in parallel. One provider failing never hides another provider's quotes. */
export async function collectQuotes(providers: readonly RouteProvider[], intent: Intent, ctx: QuoteContext): Promise<CollectedQuotes> {
  const quotes: Quote[] = [];
  const rejections: ProviderRejection[] = [];

  const results = await Promise.all(
    providers.map(async (provider) => {
      const status = provider.status();
      if (!status.available) {
        return { provider: provider.id, result: { ok: false as const, code: "PROVIDER_UNAVAILABLE" as const, reason: status.reason } };
      }
      if (!provider.supports(intent)) {
        return {
          provider: provider.id,
          result: { ok: false as const, code: "UNSUPPORTED_ROUTE" as const, reason: `${provider.name} does not support this chain/asset pair` },
        };
      }
      try {
        return { provider: provider.id, result: await provider.quote(intent, ctx) };
      } catch (error) {
        return {
          provider: provider.id,
          result: { ok: false as const, code: "PROVIDER_ERROR" as const, reason: error instanceof Error ? error.message : String(error) },
        };
      }
    }),
  );

  for (const { provider, result } of results) {
    if (result.ok) quotes.push(...result.quotes);
    else rejections.push({ provider, code: result.code, reason: result.reason });
  }
  return { ranked: rankQuotes(quotes, intent), rejections };
}
