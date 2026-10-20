// Spike C (read-only part): confirm how a native PortalDot account and its Revive (EVM) address relate,
// so the Substrate -> EVM route can be verified on both sides.
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";
import {
  assertEvmChainId,
  connectSubstrate,
  createV3PublicClient,
  fallbackAccountIdForH160,
  getFreeBalance,
  h160ForAccountId,
  loadPortaldotV3Config,
} from "../src/index";

const config = loadPortaldotV3Config();
const api = await connectSubstrate(config.wsUrl);
const evm = createV3PublicClient(config);

try {
  await assertEvmChainId(evm, config.evmChainId);
  console.log(`EVM chain ID ${config.evmChainId} confirmed`);

  const revive = api.consts.revive as Record<string, { toString(): string } | undefined>;
  console.log("Revive constants:", Object.fromEntries(Object.entries(revive).map(([k, v]) => [k, v?.toString()])));

  // A funded native account to compare balances on both sides. Prefer the user's own address;
  // otherwise use the sudo key, which is public on-chain state.
  const configured = process.env.SPIKE_SUBSTRATE_ADDRESS;
  const sudoKey = api.query.sudo ? (await api.query.sudo.key()).toString() : "";
  const nativeAddress = configured || sudoKey;
  if (!nativeAddress) throw new Error("Set SPIKE_SUBSTRATE_ADDRESS; no sudo key available");

  const accountId = decodeAddress(nativeAddress);
  const h160 = h160ForAccountId(accountId);
  const mapped = await api.query.revive.originalAccount(h160);
  const nativeFree = await getFreeBalance(api, accountId);
  const evmBalance = await evm.getBalance({ address: h160 });

  console.log({
    source: configured ? "SPIKE_SUBSTRATE_ADDRESS" : "sudo key",
    nativeAddress,
    derivedH160: h160,
    reviveOriginalAccount: mapped.toHuman(),
    nativeFree: nativeFree.toString(),
    ethGetBalance: evmBalance.toString(),
    ratio: nativeFree === 0n ? "n/a" : (Number(evmBalance) / Number(nativeFree)).toString(),
  });

  // The reverse direction: an EVM address's fallback native account.
  const fallback = fallbackAccountIdForH160(h160 as Hex);
  console.log({
    h160,
    fallbackAccountId: u8aToHex(fallback),
    fallbackSs58: encodeAddress(fallback, 42),
    fallbackNativeFree: (await getFreeBalance(api, fallback)).toString(),
  });
} finally {
  await api.disconnect();
}
