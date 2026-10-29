CREATE TABLE "receipt_batch_anchors" (
	"contract_address" text NOT NULL,
	"root" text NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_batch_anchors_pkey" PRIMARY KEY("contract_address","root"),
	CONSTRAINT "receipt_batch_anchors_tx_hash_hex" CHECK ("receipt_batch_anchors"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "receipt_batch_anchors_block_nonnegative" CHECK ("receipt_batch_anchors"."block_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipt_batch_leaves" (
	"contract_address" text NOT NULL,
	"batch_root" text NOT NULL,
	"intent_id" text NOT NULL,
	"intent_hash" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"leaf_hash" text NOT NULL,
	"proof" jsonb NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_batch_leaves_pkey" PRIMARY KEY("contract_address","intent_id"),
	CONSTRAINT "receipt_batch_leaves_leaf_key" UNIQUE("contract_address","batch_root","leaf_hash"),
	CONSTRAINT "receipt_batch_leaves_intent_hash_hex" CHECK ("receipt_batch_leaves"."intent_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "receipt_batch_leaves_receipt_hash_hex" CHECK ("receipt_batch_leaves"."receipt_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "receipt_batch_leaves_leaf_hash_hex" CHECK ("receipt_batch_leaves"."leaf_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "receipt_batch_leaves_proof_array" CHECK (jsonb_typeof("receipt_batch_leaves"."proof") = 'array')
);
--> statement-breakpoint
CREATE TABLE "receipt_batches" (
	"contract_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_batches_pkey" PRIMARY KEY("contract_address","root"),
	CONSTRAINT "receipt_batches_root_hex" CHECK ("receipt_batches"."root" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "receipt_batches_contract_hex" CHECK ("receipt_batches"."contract_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "receipt_batches_leaf_count_positive" CHECK ("receipt_batches"."leaf_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "receipt_batch_anchors" ADD CONSTRAINT "receipt_batch_anchors_batch_fk" FOREIGN KEY ("contract_address","root") REFERENCES "public"."receipt_batches"("contract_address","root") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_batch_leaves" ADD CONSTRAINT "receipt_batch_leaves_intent_id_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_batch_leaves" ADD CONSTRAINT "receipt_batch_leaves_batch_fk" FOREIGN KEY ("contract_address","batch_root") REFERENCES "public"."receipt_batches"("contract_address","root") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_batch_leaves_intent_id_idx" ON "receipt_batch_leaves" USING btree ("intent_id");