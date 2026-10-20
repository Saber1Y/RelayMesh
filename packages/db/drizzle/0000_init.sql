CREATE TABLE "idempotency_records" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"intent_id" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_intent_id_unique" UNIQUE("intent_id"),
	CONSTRAINT "idempotency_records_request_hash_hex" CHECK ("idempotency_records"."request_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"intent_hash" text NOT NULL,
	"version" smallint NOT NULL,
	"requester" text NOT NULL,
	"source_chain" text NOT NULL,
	"source_asset" text NOT NULL,
	"source_amount" numeric(78, 0) NOT NULL,
	"destination_chain" text NOT NULL,
	"destination_asset" text NOT NULL,
	"recipient" text NOT NULL,
	"min_output" numeric(78, 0),
	"max_fee" numeric(78, 0),
	"deadline" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"current_status" text NOT NULL,
	"selected_quote_id" text,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_intent_hash_unique" UNIQUE("intent_hash"),
	CONSTRAINT "intents_intent_id_hex" CHECK ("intents"."intent_id" ~ '^0x[0-9a-f]{32}$'),
	CONSTRAINT "intents_intent_hash_hex" CHECK ("intents"."intent_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "intents_source_amount_positive" CHECK ("intents"."source_amount" > 0),
	CONSTRAINT "intents_min_output_nonnegative" CHECK ("intents"."min_output" IS NULL OR "intents"."min_output" >= 0),
	CONSTRAINT "intents_max_fee_nonnegative" CHECK ("intents"."max_fee" IS NULL OR "intents"."max_fee" >= 0),
	CONSTRAINT "intents_deadline_after_creation" CHECK ("intents"."deadline" > "intents"."created_at"),
	CONSTRAINT "intents_current_status_valid" CHECK ("intents"."current_status" IN ('DRAFT', 'QUOTED', 'AWAITING_SIGNATURE', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'DESTINATION_PENDING', 'SETTLED', 'EXPIRED', 'FAILED_BEFORE_SOURCE', 'NEEDS_REVIEW'))
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"quote_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"provider" text NOT NULL,
	"route_id" text NOT NULL,
	"expected_output" numeric(78, 0) NOT NULL,
	"fees" jsonb NOT NULL,
	"retrieved_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"estimated_seconds" integer,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_quote_id_intent_id_key" UNIQUE("quote_id","intent_id"),
	CONSTRAINT "quotes_expected_output_nonnegative" CHECK ("quotes"."expected_output" >= 0),
	CONSTRAINT "quotes_expiry_after_retrieval" CHECK ("quotes"."expires_at" > "quotes"."retrieved_at"),
	CONSTRAINT "quotes_fees_array" CHECK (jsonb_typeof("quotes"."fees") = 'array')
);
--> statement-breakpoint
CREATE TABLE "status_events" (
	"intent_id" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"at" bigint NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb,
	"verification_mode" text,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_events_pkey" PRIMARY KEY("intent_id","seq"),
	CONSTRAINT "status_events_seq_nonnegative" CHECK ("status_events"."seq" >= 0),
	CONSTRAINT "status_events_status_valid" CHECK ("status_events"."status" IN ('DRAFT', 'QUOTED', 'AWAITING_SIGNATURE', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'DESTINATION_PENDING', 'SETTLED', 'EXPIRED', 'FAILED_BEFORE_SOURCE', 'NEEDS_REVIEW')),
	CONSTRAINT "status_events_reason_present" CHECK (length(btrim("status_events"."reason")) > 0),
	CONSTRAINT "status_events_verification_mode_valid" CHECK ("status_events"."verification_mode" IS NULL OR "status_events"."verification_mode" IN ('destination_rpc_state', 'provider_status_plus_destination_rpc', 'provider_report_only'))
);
--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_intent_id_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_selected_quote_fk" FOREIGN KEY ("selected_quote_id","intent_id") REFERENCES "public"."quotes"("quote_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_intent_id_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_events" ADD CONSTRAINT "status_events_intent_id_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intents_current_status_idx" ON "intents" USING btree ("current_status");--> statement-breakpoint
CREATE INDEX "quotes_intent_id_idx" ON "quotes" USING btree ("intent_id");