-- Evidence and audit rows are never rewritten. Corrections are new status events, not edits.
CREATE FUNCTION relaymesh_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'relaymesh: % on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER status_events_append_only BEFORE UPDATE OR DELETE ON "status_events"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER quotes_append_only BEFORE UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER idempotency_records_append_only BEFORE UPDATE OR DELETE ON "idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
-- An intent's terms are fixed once hashed. Only the status projection and quote selection may change,
-- and intents are never deleted.
CREATE FUNCTION relaymesh_guard_intent_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'relaymesh: DELETE on intents is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.intent_id, NEW.intent_hash, NEW.version, NEW.requester, NEW.source_chain, NEW.source_asset,
      NEW.source_amount, NEW.destination_chain, NEW.destination_asset, NEW.recipient, NEW.min_output,
      NEW.max_fee, NEW.deadline, NEW.created_at, NEW.inserted_at)
     IS DISTINCT FROM
     (OLD.intent_id, OLD.intent_hash, OLD.version, OLD.requester, OLD.source_chain, OLD.source_asset,
      OLD.source_amount, OLD.destination_chain, OLD.destination_asset, OLD.recipient, OLD.min_output,
      OLD.max_fee, OLD.deadline, OLD.created_at, OLD.inserted_at) THEN
    RAISE EXCEPTION 'relaymesh: intent terms are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intents_guard_update BEFORE UPDATE OR DELETE ON "intents"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_guard_intent_update();
