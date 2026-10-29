-- Reverses 20261029130000_registration_intake.
--
-- Destructive for submissions not yet handled: run it only with the worker
-- stopped and the table empty (`SELECT count(*) FROM registration_intake`),
-- and only together with the code that writes the request synchronously --
-- otherwise those applicants' requests are lost (each was answered 202).
DROP TABLE IF EXISTS "registration_intake";

-- Prisma will not re-apply a migration whose row is still in its ledger.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029130000_registration_intake';
