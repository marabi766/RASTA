-- Whom a settlement was made for (docs/23 D-054; review of #287 r4, F3).
--
-- A platform administrator acting for organization A may settle B's
-- transaction to C. The settlement is on B's books — its row, its journal —
-- and the request's idempotency key is A's. `settled_by` already says who
-- acted; `acting_organization_id` says for whom, so the record of a settlement
-- made across the tenant boundary names the acting organization as well as the
-- books it was posted on. For every other settlement it is the payer itself.
--
-- Populated databases: one nullable column with no default — a catalogue
-- change under a brief ACCESS EXCLUSIVE lock, no rewrite, every existing row
-- valid with NULL. NULL means "settled before this migration": nobody can say
-- for whom, and nothing is backfilled that was never recorded.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "settlement"
  ADD COLUMN IF NOT EXISTS "acting_organization_id" TEXT;
