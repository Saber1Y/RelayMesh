CREATE TABLE "registry_anchors" (
	"intent_id" text NOT NULL,
	"step" text NOT NULL,
	"value_hash" text NOT NULL,
	"contract_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_anchors_pkey" PRIMARY KEY("intent_id","step"),
	CONSTRAINT "registry_anchors_step_valid" CHECK ("registry_anchors"."step" IN ('intent', 'receipt')),
	CONSTRAINT "registry_anchors_value_hash_hex" CHECK ("registry_anchors"."value_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "registry_anchors_tx_hash_hex" CHECK ("registry_anchors"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "registry_anchors_contract_hex" CHECK ("registry_anchors"."contract_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "watcher_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watcher_cursors_block_nonnegative" CHECK ("watcher_cursors"."block_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "registry_anchors" ADD CONSTRAINT "registry_anchors_intent_id_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("intent_id") ON DELETE no action ON UPDATE no action;