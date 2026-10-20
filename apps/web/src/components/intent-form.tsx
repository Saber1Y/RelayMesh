"use client";

import { ArrowRight, CaretDown, Wallet } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { normalizeAddress, parseDecimalAmount } from "@relaymesh/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { shortHash } from "@/lib/format";
import { connectWallets, type WalletAccount } from "@/lib/wallet";
import { Button, Field, inputClass, stagger } from "./ui";

type WalletState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "no-extension" }
  | { status: "error"; message: string }
  | { status: "connected"; accounts: WalletAccount[] };

type FieldName = "source" | "recipient" | "amount" | "deadline" | "minReceived" | "maxFee";
type Errors = Partial<Record<FieldName, string>>;

const DEADLINES = [10, 30, 60] as const;
const SERVER_FIELD: Record<string, FieldName> = {
  requester: "source",
  "destination.recipient": "recipient",
  "source.amount": "amount",
  "constraints.deadline": "deadline",
  "constraints.minOutput": "minReceived",
  "constraints.maxFee": "maxFee",
};

function validate(values: { source: string; recipient: string; amount: string; minReceived: string; maxFee: string }) {
  const errors: Errors = {};
  let requester = "";
  let recipient = "";
  let amount = 0n;
  let minOutput: bigint | undefined;
  let maxFee: bigint | undefined;

  try {
    requester = normalizeAddress("portaldot-v3-substrate", values.source);
  } catch {
    errors.source = values.source ? "Enter a valid PortalDot (SS58) address." : "Choose or enter the account that sends the tPOT.";
  }
  try {
    recipient = normalizeAddress("portaldot-v3-evm", values.recipient);
  } catch {
    errors.recipient = values.recipient ? "Enter a valid EVM address (0x followed by 40 hex characters)." : "Enter the EVM address that should receive the tPOT.";
  }
  try {
    amount = parseDecimalAmount(values.amount, 14);
    if (amount === 0n) errors.amount = "Amount must be greater than zero.";
  } catch {
    errors.amount = values.amount ? "Use a plain number with at most 14 decimal places." : "Enter an amount.";
  }
  if (values.minReceived) {
    try {
      minOutput = parseDecimalAmount(values.minReceived, 18);
    } catch {
      errors.minReceived = "Use a plain number with at most 18 decimal places.";
    }
  }
  if (values.maxFee) {
    try {
      maxFee = parseDecimalAmount(values.maxFee, 14);
    } catch {
      errors.maxFee = "Use a plain number with at most 14 decimal places.";
    }
  }
  return { errors, requester, recipient, amount, minOutput, maxFee };
}

export function IntentForm() {
  const router = useRouter();
  const id = useId();
  const [wallet, setWallet] = useState<WalletState>({ status: "idle" });
  const [manualSource, setManualSource] = useState(false);
  const [source, setSource] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [deadlineMinutes, setDeadlineMinutes] = useState<(typeof DEADLINES)[number]>(10);
  const [minReceived, setMinReceived] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  // One idempotency key per set of values: a retry after a network error reuses it, any edit replaces it.
  const idempotencyKey = useRef("");
  useEffect(() => {
    idempotencyKey.current = `web-${crypto.randomUUID()}`;
  }, [source, recipient, amount, deadlineMinutes, minReceived, maxFee]);

  const substrateAccounts = useMemo(() => (wallet.status === "connected" ? wallet.accounts.filter((a) => a.kind === "substrate") : []), [wallet]);
  const evmAccounts = useMemo(() => (wallet.status === "connected" ? wallet.accounts.filter((a) => a.kind === "ethereum") : []), [wallet]);

  async function connect() {
    setWallet({ status: "connecting" });
    try {
      const result = await connectWallets();
      if (result.state === "no-extension") {
        setWallet({ status: "no-extension" });
        setManualSource(true);
        return;
      }
      setWallet({ status: "connected", accounts: result.accounts });
      const first = result.accounts.find((a) => a.kind === "substrate");
      if (first && !source) setSource(first.address);
      if (!first) setManualSource(true);
    } catch (error) {
      setWallet({ status: "error", message: error instanceof Error ? error.message : "The wallet did not respond." });
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const v = validate({ source, recipient, amount, minReceived, maxFee });
    setErrors(v.errors);
    if (Object.keys(v.errors).length > 0) return;

    setSubmitting(true);
    try {
      const body = {
        requester: v.requester,
        source: { chain: "portaldot-v3-substrate", asset: "native", amount: v.amount.toString() },
        destination: { chain: "portaldot-v3-evm", asset: "native", recipient: v.recipient },
        constraints: {
          deadline: Math.floor(Date.now() / 1000) + deadlineMinutes * 60,
          ...(v.minOutput !== undefined && { minOutput: v.minOutput.toString() }),
          ...(v.maxFee !== undefined && { maxFee: v.maxFee.toString() }),
        },
      };
      const { intentId } = await apiFetch<{ intentId: string }>("/api/intents", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey.current },
        body: JSON.stringify(body),
      });
      // Quote right away; if this fails the intent page offers a retry.
      await apiFetch(`/api/intents/${intentId}/quotes`, { method: "POST" }).catch(() => undefined);
      router.push(`/intents/${intentId}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.error.field && SERVER_FIELD[error.error.field]) {
        setErrors({ [SERVER_FIELD[error.error.field] as FieldName]: error.error.message });
      } else {
        setFormError(error instanceof Error ? error.message : "Something went wrong. Try again.");
      }
      setSubmitting(false);
    }
  }

  const fid = (name: string) => `${id}-${name}`;
  const describedBy = (name: FieldName) => (errors[name] ? `${fid(name)}-error` : `${fid(name)}-help`);

  return (
    <form onSubmit={onSubmit} noValidate className="enter grid content-start gap-6 rounded-2xl border border-line bg-surface/65 p-5 shadow-lift backdrop-blur-xl sm:p-7" style={stagger(1)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1.5">
          <h2 className="hud-label text-muted">New transfer intent</h2>
          <p className="text-sm text-muted">Substrate account to EVM address, both on PortalDot V3.</p>
        </div>
        <span className="font-mono text-[9px] tracking-[0.14em] text-accent">REAL / TESTNET</span>
      </div>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="hud-label text-muted" id={fid("source-label")}>
            From
          </span>
          {wallet.status === "connected" && substrateAccounts.length > 0 && (
            <button type="button" className="press rounded-md px-1 text-sm text-accent hover:bg-accent-soft" onClick={() => setManualSource((m) => !m)}>
              {manualSource ? "Pick from wallet" : "Enter an address instead"}
            </button>
          )}
        </div>

        {wallet.status !== "connected" && !manualSource && (
          <div className="grid gap-3 rounded-xl border border-line bg-canvas/50 p-4">
            <p className="text-sm text-muted">Connect Talisman, SubWallet or the polkadot.js extension to send from your account.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={connect} disabled={wallet.status === "connecting"}>
                <Wallet size={16} className="text-accent" />
                {wallet.status === "connecting" ? "Waiting for wallet" : "Connect wallet"}
              </Button>
              <Button variant="secondary" onClick={() => setManualSource(true)}>
                Enter an address
              </Button>
            </div>
            {wallet.status === "error" && <p className="text-sm text-critical">{wallet.message}</p>}
          </div>
        )}

        {wallet.status === "no-extension" && (
          <p className="rounded-xl border border-caution/25 bg-caution-soft px-3 py-2 text-sm text-caution">
            No Polkadot wallet extension was found. You can still preview quotes for an address, but signing needs the account in a wallet.
          </p>
        )}

        {wallet.status === "connected" && !manualSource && substrateAccounts.length > 0 && (
          <select
            id={fid("source")}
            aria-labelledby={fid("source-label")}
            aria-invalid={!!errors.source}
            aria-describedby={describedBy("source")}
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {substrateAccounts.map((a) => (
              <option key={`${a.source}-${a.address}`} value={a.address}>
                {(a.name ?? "Unnamed account") + "  " + shortHash(a.address, 8, 6)}
              </option>
            ))}
          </select>
        )}

        {manualSource && (
          <input
            id={fid("source")}
            aria-labelledby={fid("source-label")}
            aria-invalid={!!errors.source}
            aria-describedby={describedBy("source")}
            className={`${inputClass} font-mono`}
            placeholder="5…"
            autoComplete="off"
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        )}
        {errors.source ? (
          <p id={`${fid("source")}-error`} className="text-sm text-critical">
            {errors.source}
          </p>
        ) : (
          <p id={`${fid("source")}-help`} className="text-sm text-muted">
            {manualSource ? "Addresses from any Substrate network format are accepted and shown in PortalDot format." : "The account that signs and pays the network fee."}
          </p>
        )}
      </div>

      <Field label="To (EVM address)" htmlFor={fid("recipient")} error={errors.recipient} help="Funds arrive in the account Revive maps to this address.">
        <input
          id={fid("recipient")}
          aria-invalid={!!errors.recipient}
          aria-describedby={describedBy("recipient")}
          className={`${inputClass} font-mono`}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
        {evmAccounts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {evmAccounts.map((a) => (
              <button
                key={a.address}
                type="button"
                onClick={() => setRecipient(a.address)}
                className="press rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-accent/50 hover:text-accent"
              >
                {a.name ?? "EVM account"} <span className="font-mono">{shortHash(a.address)}</span>
              </button>
            ))}
          </div>
        )}
      </Field>

      <div className="grid items-start gap-6 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="Amount" htmlFor={fid("amount")} error={errors.amount} help="In tPOT, sent from the source account.">
          <div className="relative">
            <input
              id={fid("amount")}
              aria-invalid={!!errors.amount}
              aria-describedby={describedBy("amount")}
              className={`${inputClass} pr-14 font-mono text-base tabular-nums`}
              inputMode="decimal"
              placeholder="1.0"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">tPOT</span>
          </div>
        </Field>

        <fieldset className="grid gap-2">
          <legend className="hud-label mb-2 text-muted">Deadline</legend>
          <div className="inline-flex w-fit rounded-full border border-line-strong bg-canvas/70 p-1">
            {DEADLINES.map((m) => (
              <label key={m} className="cursor-pointer">
                <input type="radio" name={fid("deadline")} value={m} checked={deadlineMinutes === m} onChange={() => setDeadlineMinutes(m)} className="peer sr-only" />
                <span className="block rounded-full px-3.5 py-1.5 font-mono text-xs text-muted transition-colors duration-150 hover:text-ink peer-checked:bg-white/10 peer-checked:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
                  {m} min
                </span>
              </label>
            ))}
          </div>
          {errors.deadline && <p className="text-sm text-critical">{errors.deadline}</p>}
        </fieldset>
      </div>

      <details className="group rounded-xl border border-line bg-canvas/40">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-4 py-3 text-sm font-medium transition-colors marker:hidden hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
          <span>
            Limits <span className="font-normal text-muted">(optional)</span>
          </span>
          <CaretDown size={14} className="text-muted transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="grid gap-5 border-t border-line p-4 sm:grid-cols-2">
          <Field label="Minimum received" htmlFor={fid("minReceived")} error={errors.minReceived} help="tPOT on the EVM side. Quotes below this are refused.">
            <input
              id={fid("minReceived")}
              aria-invalid={!!errors.minReceived}
              aria-describedby={describedBy("minReceived")}
              className={`${inputClass} font-mono`}
              inputMode="decimal"
              autoComplete="off"
              value={minReceived}
              onChange={(e) => setMinReceived(e.target.value)}
            />
          </Field>
          <Field label="Maximum network fee" htmlFor={fid("maxFee")} error={errors.maxFee} help="tPOT. Checked again right before signing.">
            <input
              id={fid("maxFee")}
              aria-invalid={!!errors.maxFee}
              aria-describedby={describedBy("maxFee")}
              className={`${inputClass} font-mono`}
              inputMode="decimal"
              autoComplete="off"
              value={maxFee}
              onChange={(e) => setMaxFee(e.target.value)}
            />
          </Field>
        </div>
      </details>

      {formError && (
        <p role="alert" className="rounded-xl border border-critical/25 bg-critical-soft px-3 py-2 text-sm text-critical">
          {formError}
        </p>
      )}

      <Button type="submit" disabled={submitting} className="w-full py-3 text-[15px]">
        {submitting ? "Creating intent and quoting" : "Get quotes"}
        {!submitting && <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />}
      </Button>
    </form>
  );
}
