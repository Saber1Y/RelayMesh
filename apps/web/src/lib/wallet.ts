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

export function getBrowserApi(wsUrl: string): Promise<ApiPromise> {
  apiPromise ??= (async () => {
    const { ApiPromise, WsProvider } = await import("@polkadot/api");
    return ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
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
}

/** Decodes the plan's call bytes with the live chain metadata, independently of what the server described. */
export async function decodeCall(wsUrl: string, callHex: Hex): Promise<DecodedCall> {
  const api = await getBrowserApi(wsUrl);
  const call = api.createType("Call", callHex);
  const args: Record<string, string> = {};
  call.meta.args.forEach((arg, i) => {
    const value = call.args[i];
    const human = value?.toHuman();
    args[arg.name.toString()] = typeof human === "string" ? human : JSON.stringify(human);
  });
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
