-- A submission's (or an exemption's) repository and checkpoint must belong to
-- the same assignment. The CHECKs of 0019 only guarantee one owner per row;
-- this is the cross-table half, which no foreign key can express. See
-- `submissions` in db/schema.ts.
CREATE FUNCTION entregas_same_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_repo_id IS NOT NULL THEN
    PERFORM 1 FROM checkpoints c
      JOIN assignment_repos r ON r.assignment_id = c.assignment_id
      WHERE c.id = NEW.checkpoint_id AND r.id = NEW.assignment_repo_id;
  ELSE
    PERFORM 1 FROM checkpoints c
      JOIN group_assignment_repos r ON r.group_assignment_id = c.group_assignment_id
      WHERE c.id = NEW.checkpoint_id AND r.id = NEW.group_assignment_repo_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the repository and the checkpoint of this % row belong to different assignments', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER submissions_same_assignment
  BEFORE INSERT OR UPDATE OF checkpoint_id, assignment_repo_id, group_assignment_repo_id ON submissions
  FOR EACH ROW EXECUTE FUNCTION entregas_same_assignment();
--> statement-breakpoint
CREATE TRIGGER submission_exemptions_same_assignment
  BEFORE INSERT OR UPDATE OF checkpoint_id, assignment_repo_id, group_assignment_repo_id ON submission_exemptions
  FOR EACH ROW EXECUTE FUNCTION entregas_same_assignment();
