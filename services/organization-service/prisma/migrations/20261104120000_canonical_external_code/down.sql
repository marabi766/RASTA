-- Reverses 20261104120000_canonical_external_code. Restores the byte index; it cannot fail, since
-- every pair of codes distinct by key is distinct by bytes.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_organization_external_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "organization_external_code_key" ON "organization"("external_code");
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "ck_organization_external_code_canonical";
DROP FUNCTION IF EXISTS "organization_text_key"(TEXT);
DROP FUNCTION IF EXISTS "organization_text_is_canonical"(TEXT);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104120000_canonical_external_code';
