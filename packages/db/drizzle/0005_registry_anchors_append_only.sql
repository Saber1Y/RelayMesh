-- Anchors are written once the registry transaction is confirmed; they are never edited.
CREATE TRIGGER registry_anchors_append_only BEFORE UPDATE OR DELETE ON "registry_anchors"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
