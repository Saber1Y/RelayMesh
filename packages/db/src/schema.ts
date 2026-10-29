import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { INTENT_STATUSES } from "@relaymesh/core";

// Conventions:
// - token amounts are numeric(78,0) read as bigint (78 digits covers uint256)
// - protocol times (createdAt, deadline, event `at`, quote expiry) are unix seconds, matching @relaymesh/core
// - inserted_at is the database's own wall clock, for auditing only
// - quotes, status_events and idempotency_records are append-only (enforced by triggers in the migrations)

const amount = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
const unixSeconds = (name: string) => bigint(name, { mode: "number" });
const insertedAt = () => timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow();

const statusList = sql.raw(INTENT_STATUSES.map((s) => `'${s}'`).join(", "));
// Inlined as a literal: DDL cannot take bind parameters. `bytes` is always a code constant.
const hex = (column: AnyPgColumn, bytes: number) => sql`${column} ~ ${sql.raw(`'^0x[0-9a-f]{${bytes * 2}}$'`)}`;

export const intents = pgTable(
  "intents",
  {
    intentId: text("intent_id").primaryKey(),
    intentHash: text("intent_hash").notNull().unique(),
    version: smallint("version").notNull(),
    requester: text("requester").notNull(),
    sourceChain: text("source_chain").notNull(),
    sourceAsset: text("source_asset").notNull(),
    sourceAmount: amount("source_amount").notNull(),
    destinationChain: text("destination_chain").notNull(),
    destinationAsset: text("destination_asset").notNull(),
    recipient: text("recipient").notNull(),
    minOutput: amount("min_output"),
    maxFee: amount("max_fee"),
    deadline: unixSeconds("deadline").notNull(),
    createdAt: unixSeconds("created_at").notNull(),
    /** Denormalized latest status for queries; status_events is the source of truth. */
    currentStatus: text("current_status").notNull(),
    selectedQuoteId: text("selected_quote_id"),
    insertedAt: insertedAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("intents_intent_id_hex", hex(t.intentId, 16)),
    check("intents_intent_hash_hex", hex(t.intentHash, 32)),
    check("intents_source_amount_positive", sql`${t.sourceAmount} > 0`),
    check("intents_min_output_nonnegative", sql`${t.minOutput} IS NULL OR ${t.minOutput} >= 0`),
    check("intents_max_fee_nonnegative", sql`${t.maxFee} IS NULL OR ${t.maxFee} >= 0`),
    check("intents_deadline_after_creation", sql`${t.deadline} > ${t.createdAt}`),
    check("intents_current_status_valid", sql`${t.currentStatus} IN (${statusList})`),
    // The selected quote must belong to this intent.
    foreignKey({
      name: "intents_selected_quote_fk",
      columns: [t.selectedQuoteId, t.intentId],
      foreignColumns: [quotes.quoteId, quotes.intentId],
    }),
    index("intents_current_status_idx").on(t.currentStatus),
  ],
);

export const quotes = pgTable(
  "quotes",
  {
    quoteId: text("quote_id").primaryKey(),
    intentId: text("intent_id")
      .notNull()
      .references((): AnyPgColumn => intents.intentId),
    provider: text("provider").notNull(),
    routeId: text("route_id").notNull(),
    expectedOutput: amount("expected_output").notNull(),
    /** Fee[] with amounts as decimal strings (see codec.ts). */
    fees: jsonb("fees").notNull(),
    retrievedAt: unixSeconds("retrieved_at").notNull(),
    expiresAt: unixSeconds("expires_at").notNull(),
    estimatedSeconds: integer("estimated_seconds"),
    insertedAt: insertedAt(),
  },
  (t) => [
    unique("quotes_quote_id_intent_id_key").on(t.quoteId, t.intentId),
    check("quotes_expected_output_nonnegative", sql`${t.expectedOutput} >= 0`),
    check("quotes_expiry_after_retrieval", sql`${t.expiresAt} > ${t.retrievedAt}`),
    check("quotes_fees_array", sql`jsonb_typeof(${t.fees}) = 'array'`),
    index("quotes_intent_id_idx").on(t.intentId),
  ],
);

export const statusEvents = pgTable(
  "status_events",
  {
    intentId: text("intent_id")
      .notNull()
      .references(() => intents.intentId),
    seq: integer("seq").notNull(),
    status: text("status").notNull(),
    at: unixSeconds("at").notNull(),
    reason: text("reason").notNull(),
    /** Evidence with bigints as decimal strings (see codec.ts). */
    evidence: jsonb("evidence"),
    verificationMode: text("verification_mode"),
    insertedAt: insertedAt(),
  },
  (t) => [
    primaryKey({ name: "status_events_pkey", columns: [t.intentId, t.seq] }),
    check("status_events_seq_nonnegative", sql`${t.seq} >= 0`),
    check("status_events_status_valid", sql`${t.status} IN (${statusList})`),
    check("status_events_reason_present", sql`length(btrim(${t.reason})) > 0`),
    check(
      "status_events_verification_mode_valid",
      sql`${t.verificationMode} IS NULL OR ${t.verificationMode} IN ('destination_rpc_state', 'provider_status_plus_destination_rpc', 'provider_report_only')`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    intentId: text("intent_id")
      .notNull()
      .unique()
      .references(() => intents.intentId),
    insertedAt: insertedAt(),
  },
  (t) => [check("idempotency_records_request_hash_hex", hex(t.requestHash, 32))],
);

/** The exact unsigned call handed to the user's wallet, kept so the submitted extrinsic can be verified against it. */
export const executionPlans = pgTable(
  "execution_plans",
  {
    planId: text("plan_id").primaryKey(),
    intentId: text("intent_id").notNull(),
    quoteId: text("quote_id").notNull(),
    kind: text("kind").notNull(),
    chain: text("chain").notNull(),
    signer: text("signer").notNull(),
    callHex: text("call_hex").notNull(),
    destinationAccount: text("destination_account").notNull(),
    estimatedFee: amount("estimated_fee").notNull(),
    submitBefore: unixSeconds("submit_before").notNull(),
    createdAt: unixSeconds("created_at").notNull(),
    insertedAt: insertedAt(),
  },
  (t) => [
    foreignKey({
      name: "execution_plans_quote_fk",
      columns: [t.quoteId, t.intentId],
      foreignColumns: [quotes.quoteId, quotes.intentId],
    }),
    check("execution_plans_kind_valid", sql`${t.kind} IN ('substrate_call')`),
    check("execution_plans_call_hex", sql`${t.callHex} ~ '^0x([0-9a-f]{2})+$'`),
    check("execution_plans_fee_nonnegative", sql`${t.estimatedFee} >= 0`),
    index("execution_plans_intent_id_idx").on(t.intentId),
  ],
);

/** Operational progress markers (e.g. the last finalized block the watcher scanned). Not evidence; may be updated. */
export const watcherCursors = pgTable(
  "watcher_cursors",
  {
    name: text("name").primaryKey(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("watcher_cursors_block_nonnegative", sql`${t.blockNumber} >= 0`)],
);

/**
 * IntentRegistry writes confirmed on chain, from per-intent anchoring before receipt batches replaced
 * it. Rows are only inserted after the transaction is mined and the contract state was read back, so
 * a row is itself evidence. No longer written by the watcher; kept so those receipts stay verifiable
 * and are never anchored twice. Append-only.
 */
export const registryAnchors = pgTable(
  "registry_anchors",
  {
    intentId: text("intent_id")
      .notNull()
      .references(() => intents.intentId),
    step: text("step").notNull(),
    /** intentHash for step "intent", receiptHash for step "receipt". */
    valueHash: text("value_hash").notNull(),
    contractAddress: text("contract_address").notNull(),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    insertedAt: insertedAt(),
  },
  (t) => [
    primaryKey({ name: "registry_anchors_pkey", columns: [t.intentId, t.step] }),
    check("registry_anchors_step_valid", sql`${t.step} IN ('intent', 'receipt')`),
    check("registry_anchors_value_hash_hex", hex(t.valueHash, 32)),
    check("registry_anchors_tx_hash_hex", hex(t.txHash, 32)),
    check("registry_anchors_contract_hex", sql`${t.contractAddress} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

/**
 * A planned ReceiptBatchRegistry batch: the Merkle root over its leaves, written before the root is
 * sent, so a crash between mining and recording can be recovered by reading this exact root back
 * from the chain. A batch is confirmed once it has a receipt_batch_anchors row. Append-only.
 */
export const receiptBatches = pgTable(
  "receipt_batches",
  {
    contractAddress: text("contract_address").notNull(),
    chainId: integer("chain_id").notNull(),
    root: text("root").notNull(),
    leafCount: integer("leaf_count").notNull(),
    /** When the batch was planned, in unix seconds. */
    createdAt: unixSeconds("created_at").notNull(),
    insertedAt: insertedAt(),
  },
  (t) => [
    primaryKey({ name: "receipt_batches_pkey", columns: [t.contractAddress, t.root] }),
    check("receipt_batches_root_hex", hex(t.root, 32)),
    check("receipt_batches_contract_hex", sql`${t.contractAddress} ~ '^0x[0-9a-f]{40}$'`),
    check("receipt_batches_leaf_count_positive", sql`${t.leafCount} > 0`),
  ],
);

/** One settled intent's leaf in a batch, with the proof from its leaf to the batch root. Append-only. */
export const receiptBatchLeaves = pgTable(
  "receipt_batch_leaves",
  {
    contractAddress: text("contract_address").notNull(),
    batchRoot: text("batch_root").notNull(),
    intentId: text("intent_id")
      .notNull()
      .references(() => intents.intentId),
    intentHash: text("intent_hash").notNull(),
    receiptHash: text("receipt_hash").notNull(),
    leafHash: text("leaf_hash").notNull(),
    /** Sibling hashes from the leaf up to the root (see @relaymesh/core merkle.ts). */
    proof: jsonb("proof").notNull(),
    insertedAt: insertedAt(),
  },
  (t) => [
    // An intent is anchored at most once per contract.
    primaryKey({ name: "receipt_batch_leaves_pkey", columns: [t.contractAddress, t.intentId] }),
    foreignKey({
      name: "receipt_batch_leaves_batch_fk",
      columns: [t.contractAddress, t.batchRoot],
      foreignColumns: [receiptBatches.contractAddress, receiptBatches.root],
    }),
    unique("receipt_batch_leaves_leaf_key").on(t.contractAddress, t.batchRoot, t.leafHash),
    check("receipt_batch_leaves_intent_hash_hex", hex(t.intentHash, 32)),
    check("receipt_batch_leaves_receipt_hash_hex", hex(t.receiptHash, 32)),
    check("receipt_batch_leaves_leaf_hash_hex", hex(t.leafHash, 32)),
    check("receipt_batch_leaves_proof_array", sql`jsonb_typeof(${t.proof}) = 'array'`),
    index("receipt_batch_leaves_intent_id_idx").on(t.intentId),
  ],
);

/**
 * The mined recordBatch transaction of a batch. Inserted only after the transaction is mined, or
 * after the root was read back from the contract and its BatchRecorded event found. Append-only.
 */
export const receiptBatchAnchors = pgTable(
  "receipt_batch_anchors",
  {
    contractAddress: text("contract_address").notNull(),
    root: text("root").notNull(),
    txHash: text("tx_hash").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    insertedAt: insertedAt(),
  },
  (t) => [
    primaryKey({ name: "receipt_batch_anchors_pkey", columns: [t.contractAddress, t.root] }),
    foreignKey({
      name: "receipt_batch_anchors_batch_fk",
      columns: [t.contractAddress, t.root],
      foreignColumns: [receiptBatches.contractAddress, receiptBatches.root],
    }),
    check("receipt_batch_anchors_tx_hash_hex", hex(t.txHash, 32)),
    check("receipt_batch_anchors_block_nonnegative", sql`${t.blockNumber} >= 0`),
  ],
);
