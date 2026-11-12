-- Reverse of `migration.sql` (20261109130000_payment_intent_terms_fixed).
--
-- Drops the triggers, their functions and the two evidence tables. Refused while either table
-- holds a row: they are the only record of what the provider answered and how each task was
-- decided. Nothing was rewritten going up, so nothing is put back; the service writes both
-- tables, so the release is rolled back first.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE outcome_count BIGINT;
DECLARE decision_count BIGINT;
BEGIN
  LOCK TABLE payment_provider_outcome IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE payment_reconciliation_decision IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO outcome_count FROM payment_provider_outcome;
  SELECT count(*) INTO decision_count FROM payment_reconciliation_decision;
  IF outcome_count > 0 OR decision_count > 0 THEN
    RAISE EXCEPTION 'payment evidence holds % provider answer(s) and % task decision(s); refusing to drop it',
      outcome_count, decision_count;
  END IF;
END
$$;

DROP TRIGGER "trg_payment_intent_evidenced" ON "payment_intent";
DROP TRIGGER "trg_payment_intent_no_truncate" ON "payment_intent";
DROP TRIGGER "trg_payment_intent_terms_fixed" ON "payment_intent";
DROP TRIGGER "trg_payment_reconciliation_task_decided" ON "payment_reconciliation_task";
DROP TABLE "payment_reconciliation_decision";
DROP TABLE "payment_provider_outcome";
DROP FUNCTION assert_payment_intent_evidenced();
DROP FUNCTION guard_payment_reconciliation_task();
DROP FUNCTION finish_payment_reconciliation_task();
DROP FUNCTION record_payment_provider_outcome();
DROP FUNCTION reject_payment_intent_rewrite();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109130000_payment_intent_terms_fixed';

COMMIT;
