-- A planned batch, its leaves and proofs, and its mined transaction are written once and never edited.
CREATE TRIGGER receipt_batches_append_only BEFORE UPDATE OR DELETE ON "receipt_batches"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER receipt_batch_leaves_append_only BEFORE UPDATE OR DELETE ON "receipt_batch_leaves"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER receipt_batch_anchors_append_only BEFORE UPDATE OR DELETE ON "receipt_batch_anchors"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
