-- Reverses 20261015120000_insurance_claim_document (docs/24 Q-128).
--
-- Roll the code back first: the claim service reads and writes this table.
-- The references are lost by design (the files themselves stay in
-- document-service); the claim rows are untouched.
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "insurance_claim_document";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_insurance_claim_document';

COMMIT;
