"use client";

import type { ApiPromise } from "@polkadot/api";
import type { Hex } from "viem";

// Browser-only wallet and chain helpers. Polkadot packages are imported lazily so they never run
// during server rendering and stay out of the initial bundle.

export interface WalletAccount {
  address: string;
  name: string | undefined;
  /** Extension that holds the key, e.g. "talisman". */
  source: string;
  kind: "substrate" | "ethereum";
}

export type WalletConnection =
  | { state: "no-extension" }
  | { state: "connected"; extensions: string[]; accounts: WalletAccount[] };

const APP_NAME = "RelayMesh";

export async function connectWallets(): Promise<WalletConnection> {
  const { web3Enable, web3Accounts } = await import("@polkadot/extension-dapp");
  const extensions = await web3Enable(APP_NAME);
  if (extensions.length === 0) return { state: "no-extension" };
  const accounts = await web3Accounts({ ss58Format: 42 });
  return {
    state: "connected",
    extensions: extensions.map((e) => e.name),
    accounts: accounts.map((a) => ({
      address: a.address,
      name: a.meta.name,
      source: a.meta.source,
      kind: a.type === "ethereum" ? "ethereum" : "substrate",
    })),
  };
}

let apiPromise: Promise<ApiPromise> | undefined;

// Metadata this browser previously downloaded from the V3 node, keyed `${genesisHash}-${specVersion}`.
// polkadot.js only uses it when the key matches what the node reports at connect time, so a runtime
// upgrade simply misses the cache. It never comes from the RelayMesh server, which keeps the
// in-browser call check independent of the server.
const METADATA_CACHE_KEY = "relaymesh:v3-metadata";

function readMetadataCache(): Record<string, `0x${string}`> | undefined {
  try {
    const raw = localStorage.getItem(METADATA_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, `0x${string}`>) : undefined;
  } catch {
    return undefined;
  }
}

function writeMetadataCache(api: ApiPromise): void {
  try {
    const key = `${api.genesisHash.toHex()}-${api.runtimeVersion.specVersion.toString()}`;
    if (readMetadataCache()?.[key]) return;
    // Keep only the current runtime's metadata (about 1 MB as hex).
    localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify({ [key]: api.runtimeMetadata.toHex() }));
  } catch {
    // Storage full or unavailable: the next visit downloads metadata again.
  }
}

/** Shared browser connection to V3. Call early (e.g. on page load) so it is ready by the time the user reviews. */
export function getBrowserApi(wsUrl: string): Promise<ApiPromise> {
  apiPromise ??= (async () => {
    const { ApiPromise, WsProvider } = await import("@polkadot/api");
    const metadata = readMetadataCache();
    const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true, ...(metadata && { metadata }) });
    writeMetadataCache(api);
    return api;
  })().catch((error: unknown) => {
    apiPromise = undefined;
    throw error;
  });
  return apiPromise;
}

export interface DecodedCall {
  section: string;
  method: string;
  args: Record<string, string>;
  /** For utility.batchAll, the calls it bundles, each decoded the same way. */
  calls?: DecodedCall[];
}

/** Decodes the plan's call bytes with the live chain metadata, independently of what the server described. */
export async function decodeCall(wsUrl: string, callHex: Hex | Uint8Array): Promise<DecodedCall> {
  const api = await getBrowserApi(wsUrl);
  const call = api.createType("Call", callHex);
  const args: Record<string, string> = {};
  call.meta.args.forEach((arg, i) => {
    const value = call.args[i];
    const human = value?.toHuman();
    args[arg.name.toString()] = typeof human === "string" ? human : JSON.stringify(human);
  });
  if (call.section === "utility" && call.method === "batchAll") {
    const inner = [...(call.args[0] as unknown as Iterable<{ toU8a(): Uint8Array }>)];
    const calls = await Promise.all(inner.map((c) => decodeCall(wsUrl, c.toU8a())));
    return { section: call.section, method: call.method, args: {}, calls };
  }
  return { section: call.section, method: call.method, args };
}

export type SubmitPhase = "awaiting-wallet" | "broadcast" | "in-block";

export interface Inclusion {
  txHash: Hex;
  blockHash: Hex;
}

/**
 * Asks the wallet to sign exactly the plan's call and broadcasts it. Resolves once the extrinsic is in
 * a block (success or dispatch failure; the server decides which). Rejects if the user cancels or the
 * transaction is dropped.
 */
export async function signAndSubmit(
  wsUrl: string,
  account: WalletAccount,
  callHex: Hex,
  onPhase: (phase: SubmitPhase) => void,
): Promise<Inclusion> {
  const api = await getBrowserApi(wsUrl);
  const { web3FromSource } = await import("@polkadot/extension-dapp");
  const injector = await web3FromSource(account.source);
  const tx = api.tx(api.createType("Call", callHex));

  onPhase("awaiting-wallet");
  return new Promise<Inclusion>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      fn();
    };

    tx.signAndSend(account.address, { signer: injector.signer, nonce: -1 }, (result) => {
      const { status } = result;
      if (status.isReady || status.isBroadcast) onPhase("broadcast");
      if (status.isInBlock) {
        onPhase("in-block");
        finish(() => resolve({ txHash: tx.hash.toHex() as Hex, blockHash: status.asInBlock.toHex() as Hex }));
      } else if (status.isDropped || status.isInvalid || status.isUsurped) {
        finish(() => reject(new Error(`The network rejected the transaction (${status.type}).`)));
      }
    })
      .then((unsub) => {
        unsubscribe = unsub;
        if (settled) unsub();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(() => reject(new Error(/cancel|reject/i.test(message) ? "You cancelled the signature in your wallet." : message)));
      });
  });
}
