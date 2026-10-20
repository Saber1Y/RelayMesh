-- Plans are evidence of what the user was asked to sign; they are never edited.
CREATE TRIGGER execution_plans_append_only BEFORE UPDATE OR DELETE ON "execution_plans"
  FOR EACH ROW EXECUTE FUNCTION relaymesh_reject_mutation();
