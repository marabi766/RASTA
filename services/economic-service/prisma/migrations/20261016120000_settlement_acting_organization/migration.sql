-- Whom a settlement was made for (docs/23 D-054; review of #287 r4, F3).
--
-- A system administrator acting for organization A may settle B's
-- transaction to C (`SYSTEM_ADMIN` only; a `UNION_ADMIN` is refused until
-- docs/24 Q-136 decides). The settlement is on B's books — its row, its
-- journal — and the request's idempotency key is A's. `settled_by` already
-- says who acted; `acting_organization_id` says for whom, so the record of a
-- settlement made across the tenant boundary names the acting organization as
-- well as the books it was posted on. For every other settlement it is the
-- payer itself.
--
-- Populated databases: one nullable column with no default — a catalogue
-- change under a brief ACCESS EXCLUSIVE lock, no rewrite, every existing row
-- valid with NULL. NULL means "settled before this migration": nobody can say
-- for whom, and nothing is backfilled that was never recorded.
--
-- Rollback (approved, docs/23 D-054): roll back the APPLICATION and keep this
-- column. The previous release never names it — its client reads and writes
-- `settlement` without it, new rows take NULL — and its `migrate deploy` finds
-- nothing pending. `down.sql` is for a database where no settlement was made
-- for another organization: once one exists it refuses, because the column is
-- that settlement's only record of whom it was made for.
-- (test/settlement-acting-organization-rollback.int-spec.ts holds both.)
SET LOCAL lock_timeout = '3s';

ALTER TABLE "settlement"
  ADD COLUMN IF NOT EXISTS "acting_organization_id" TEXT;
