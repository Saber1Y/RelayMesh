CREATE TABLE "bridge_batch_leaves" (
	"contract_address" text NOT NULL,
	"batch_root" text NOT NULL,
	"check_hash" text NOT NULL,
	"leaf_hash" text NOT NULL,
	"proof" jsonb NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_batch_leaves_pkey" PRIMARY KEY("contract_address","check_hash"),
	CONSTRAINT "bridge_batch_leaves_leaf_key" UNIQUE("contract_address","batch_root","leaf_hash"),
	CONSTRAINT "bridge_batch_leaves_leaf_hash_hex" CHECK ("bridge_batch_leaves"."leaf_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "bridge_batch_leaves_proof_array" CHECK (jsonb_typeof("bridge_batch_leaves"."proof") = 'array')
);
--> statement-breakpoint
CREATE TABLE "bridge_checks" (
	"check_hash" text PRIMARY KEY NOT NULL,
	"deposit_id" text NOT NULL,
	"payout_tx_hash" text NOT NULL,
	"facts" jsonb NOT NULL,
	"checked_at" bigint NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_checks_deposit_key" UNIQUE("deposit_id"),
	CONSTRAINT "bridge_checks_check_hash_hex" CHECK ("bridge_checks"."check_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "bridge_checks_payout_tx_hash_hex" CHECK ("bridge_checks"."payout_tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "bridge_checks_deposit_id_format" CHECK ("bridge_checks"."deposit_id" ~ '^[0-9]+-[0-9]+$'),
	CONSTRAINT "bridge_checks_facts_object" CHECK (jsonb_typeof("bridge_checks"."facts") = 'object')
);
--> statement-breakpoint
ALTER TABLE "bridge_batch_leaves" ADD CONSTRAINT "bridge_batch_leaves_check_hash_bridge_checks_check_hash_fk" FOREIGN KEY ("check_hash") REFERENCES "public"."bridge_checks"("check_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_batch_leaves" ADD CONSTRAINT "bridge_batch_leaves_batch_fk" FOREIGN KEY ("contract_address","batch_root") REFERENCES "public"."receipt_batches"("contract_address","root") ON DELETE no action ON UPDATE no action;