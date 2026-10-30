-- A verified bridge check and its batch leaf are written once and never edited.
CREATE TRIGGER bridge_checks_append_only BEFORE UPDATE OR DELETE ON "bridge_checks"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER bridge_batch_leaves_append_only BEFORE UPDATE OR DELETE ON "bridge_batch_leaves"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
