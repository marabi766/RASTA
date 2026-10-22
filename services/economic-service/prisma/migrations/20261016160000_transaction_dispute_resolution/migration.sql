-- The resolution of a transaction's dispute, in a column of its own
-- (docs/23 D-060).
--
-- `resolve-dispute` wrote the resolution over `dispute_reason`, so a resolved
-- transaction no longer said what the dispute had been about. It now writes
-- `dispute_resolution` and leaves the reason alone.
--
-- Existing rows are NOT backfilled. A row resolved before this migration
-- holds the resolution text in `dispute_reason` — unless it was disputed
-- again afterwards, when it holds the new reason — and this migration does
-- not guess which: every row keeps `dispute_reason` exactly as it is and gets
-- `dispute_resolution` NULL. What the API says about them is in docs/23 D-060.
--
-- Populated databases: a nullable column with no default and no constraint,
-- so every existing row stays valid and the ALTER is a catalogue change only.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "dispute_resolution" TEXT;
