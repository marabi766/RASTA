-- The canonical hash of an idempotency record, beside the one the previous
-- release compares (Codex PR-747 r2, F3; docs/06 § 6.8).
--
-- `request_hash` keeps what every release before this one computes: the hash of
-- the body as sent. A record this release writes must still replay on that
-- release — a rolling update, or `helm rollback` (docs/12 § 12.5), can send the
-- client's unchanged retry there — so its canonical hash goes in a column of its
-- own, which that release neither reads nor writes.
--
-- Populated databases: one nullable column with no default — a catalogue change
-- under a brief ACCESS EXCLUSIVE lock, no rewrite, every existing row valid with
-- NULL. A NULL record is one the previous release wrote: it replays its own
-- bytes only, as that release replays it.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  ADD COLUMN IF NOT EXISTS "canonical_hash" TEXT;
