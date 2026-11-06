-- =============================================================================
-- contract-service — one lock per rule for everything that changes it (FU-060, #677 r2 F2).
--
-- A proposal took the rule FOR SHARE and its approval then asked for NO KEY UPDATE: an upgrade. Two
-- sessions could both hold the share, the second waiting on the pending index for the first and the
-- first waiting on the second's share: PostgreSQL aborted one (40P01). A withdrawal or a rejection
-- took no lock at all, so a proposal could hold the rule and wait on that move's transaction, which
-- then needed the rule.
--
-- Now there is one lock, in one mode: **a RETIRE's proposal and each of its moves take its rule FOR NO
-- KEY UPDATE before they write.** Nothing is upgraded, and whoever holds the rule is the only one
-- writing a RETIRE of it, so nobody can wait on the pending index for another holder. A move has
-- already locked its change when its trigger runs, so a move's order is the change, then the rule; a
-- proposal holding the rule never waits for that change, since a change still pending is a unique
-- violation at once, not a wait. Who waits for the rule then finds it as committed: retired (`404`),
-- or with a RETIRE pending (`409`).
--
-- NO KEY: a statement naming the rule (a foreign key's KEY SHARE) is not held up.
--
-- A CREATE has no rule to lock and holds no row lock: two of one name wait on the pending index, one
-- way only. A transaction that spans several rules, or a RETIRE and a CREATE of one name, takes its
-- locks in its own order and may still be aborted by PostgreSQL. No route does either: each command
-- is one change, in one transaction (`test/deduction-rule-lock-order.int-spec.ts` holds the rest).
--
-- Trigger bodies only: no row, column or index changes.
-- =============================================================================

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
      FOR NO KEY UPDATE;
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
    -- Every move of a RETIRE, not only its approval: see the head of 20261104200000.
    IF NEW."kind" = 'RETIRE' THEN
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
