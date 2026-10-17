-- Reverse of `migration.sql` (20261016190000_participation_rule).
--
-- Run with the previous release deployed: it neither writes the two columns
-- nor reads the rule table. Refused, before anything changes, while a
-- participation rule exists: a version is the audited record of what was in
-- force (ADR-047 § 3), and dropping it would erase that. The subject columns
-- go without a refusal: they repeat what each fact's owner holds, and a
-- re-apply leaves earlier facts counting for nobody, which is the safe side.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('participation_rule') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "participation_rule") THEN
    RAISE EXCEPTION 'participation_rule holds versions; refusing to drop the record of what was in force'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP TABLE IF EXISTS "participation_rule";
DROP FUNCTION IF EXISTS reject_participation_rule_mutation();

DROP INDEX IF EXISTS "ix_reward_source_evaluation_subject";
ALTER TABLE "reward_source_evaluation" DROP CONSTRAINT IF EXISTS "ck_reward_source_evaluation_subject";
ALTER TABLE "reward_source_evaluation"
  DROP COLUMN IF EXISTS "subject_user_id",
  DROP COLUMN IF EXISTS "occurred_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016190000_participation_rule';

COMMIT;
