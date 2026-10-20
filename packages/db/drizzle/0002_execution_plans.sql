CREATE TABLE "execution_plans" (
	"plan_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"kind" text NOT NULL,
	"chain" text NOT NULL,
	"signer" text NOT NULL,
	"call_hex" text NOT NULL,
	"destination_account" text NOT NULL,
	"estimated_fee" numeric(78, 0) NOT NULL,
	"submit_before" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_plans_kind_valid" CHECK ("execution_plans"."kind" IN ('substrate_call')),
	CONSTRAINT "execution_plans_call_hex" CHECK ("execution_plans"."call_hex" ~ '^0x([0-9a-f]{2})+$'),
	CONSTRAINT "execution_plans_fee_nonnegative" CHECK ("execution_plans"."estimated_fee" >= 0)
);
--> statement-breakpoint
ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_quote_fk" FOREIGN KEY ("quote_id","intent_id") REFERENCES "public"."quotes"("quote_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_plans_intent_id_idx" ON "execution_plans" USING btree ("intent_id");