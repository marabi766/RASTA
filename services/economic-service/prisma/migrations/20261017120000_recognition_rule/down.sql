-- Reverse of `migration.sql` (20261017120000_recognition_rule).
--
-- Run with the previous release deployed: it never reads the table. Refused,
-- before anything changes, while a version exists: a version is the audited
-- record of which levels and badges were in force (ADR-047 § 3), and dropping
-- it would erase that.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('recognition_rule') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "recognition_rule") THEN
    RAISE EXCEPTION 'recognition_rule holds versions; refusing to drop the record of what was in force'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP TABLE IF EXISTS "recognition_rule";
DROP FUNCTION IF EXISTS reject_recognition_rule_mutation();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017120000_recognition_rule';

COMMIT;
