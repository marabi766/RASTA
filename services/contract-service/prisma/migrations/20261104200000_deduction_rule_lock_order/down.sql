-- =============================================================================
-- Reverse of `migration.sql` (20261104200000_deduction_rule_lock_order, FU-060). Restores the two
-- trigger bodies of 20261104100000, deadlock included. It changes no row, so it refuses nothing.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "deduction_rule_change_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'PENDING_APPROVAL' OR NEW."version" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ck_deduction_rule_change_born_pending: a change is born PENDING_APPROVAL at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RETIRE' THEN
    PERFORM 1 FROM "deduction_rule"
      WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id"
        AND "retired_at" IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_rule_in_force: only a rule of this organization in force can be retired'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "deduction_rule_change_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."rate_bp" IS DISTINCT FROM OLD."rate_bp"
       OR NEW."base" IS DISTINCT FROM OLD."base"
       OR NEW."deduction_rule_id" IS DISTINCT FROM OLD."deduction_rule_id"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."proposed_at" IS DISTINCT FROM OLD."proposed_at"
       OR NEW."proposed_by" IS DISTINCT FROM OLD."proposed_by"
       OR NEW."proposed_by_issuer" IS DISTINCT FROM OLD."proposed_by_issuer"
       OR NEW."proposed_by_subject" IS DISTINCT FROM OLD."proposed_by_subject"
    THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_immutable: what was proposed, and by whom, never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_transition: a change cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_version_step: every move takes the version up by one'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Lock order: the rule, then the change's move. A proposal holding FOR SHARE on the rule meets
    -- this change still live in the pending index and is refused at once instead of waiting on us.
    -- NO KEY: a statement naming the rule (a foreign key's KEY SHARE) is not held up.
    IF NEW."status" = 'APPROVED' AND NEW."kind" = 'RETIRE' THEN
      PERFORM 1 FROM "deduction_rule"
        WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id"
        FOR NO KEY UPDATE;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_deduction_rule_change_not_erasable: a change is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104200000_deduction_rule_lock_order';

COMMIT;
