-- Reverses 20260925150000_policy_timeline_and_primary_contact.
--
-- Roll the code back first or not at all: the service's per-key and per-kind
-- locks keep the invariants on their own, and these constraints only back
-- them. Removing them loses nothing that is already in the tables.
--
-- btree_gist is left installed. The migration created it only if it was
-- missing (the bootstrap installs it too), so dropping it here could remove an
-- extension this migration did not add; an unused extension changes nothing.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_contact_primary_per_kind";
ALTER TABLE "organization_policy" DROP CONSTRAINT IF EXISTS "ex_policy_no_overlap";
ALTER TABLE "organization_policy" DROP CONSTRAINT IF EXISTS "ck_policy_effective_range";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925150000_policy_timeline_and_primary_contact';
