-- Which dispute a transaction's recorded resolution decided (Codex on #322
-- round 4, finding 1; docs/23 D-060).
--
-- A row keeps one dispute and one resolution, and they need not be about the
-- same dispute: resolved (A), disputed again (B), then refunded from DISPUTED,
-- it holds B's reason beside A's decision. Readers told them apart by time —
-- a resolution older than `disputed_at` was an earlier dispute's — and time
-- does not establish it: a re-dispute that read its clock before waiting for
-- the row lock, behind a resolution that read its clock later and locked
-- first, records the older instant, and A's decision read as B's.
-- `resolved_dispute_id` names the dispute the resolution decided; a reader
-- compares it with `dispute_id`.
--
-- Assigned here, not by the service, as `dispute_id` is (D-053): the trigger
-- sets it on the one move a resolution makes, DISPUTED -> PENDING_SETTLEMENT,
-- to the identity the row held at that instant, under the lock that write
-- takes, and keeps it on any other write, whatever the UPDATE sets. A pod of
-- the previous release resolves without knowing the column, and its
-- resolution is still attributed.
--
-- Rows resolved before this migration. A row PENDING_SETTLEMENT or SETTLED
-- after a dispute, with no identity yet, has one attribution that is certain:
-- out of DISPUTED a row goes only to PENDING_SETTLEMENT, by a resolution, or
-- to REFUNDED, which it never leaves, and a disputed row never returns to
-- HELD — so its latest dispute was resolved, by the resolution it records,
-- and `dispute_id` is that dispute's (the trigger of 20261016170000 keeps
-- it). The trigger derives exactly that, from the row as it stands
-- under the write's lock, on any write that touches `status` or
-- `resolved_dispute_id`: such a row is attributed when it is settled or
-- disputed again, and the backfill writes the rest. Every other row stays
-- NULL: an open dispute has no resolution of its own yet, and a refunded row
-- may have been refunded from DISPUTED, beside an earlier dispute's
-- resolution — which is the case this column exists for, and nothing on the
-- row says which. Readers keep the time rule for a row with no identity.
--
-- Bounded (Codex on #352, finding 1). This file changes the catalogue and no
-- row: a nullable column with no default (no rewrite), a function and a
-- trigger. It holds the table's ACCESS EXCLUSIVE lock for those three
-- statements — milliseconds, whatever the table's size — and waits for it at
-- most `lock_timeout`; `statement_timeout` (default 5 s, raised for one run by
-- `RASTA_MIGRATION_STATEMENT_TIMEOUT`, which scripts/prisma.mjs passes as
-- `rasta.migration_statement_timeout`, read below) makes anything slower fail
-- the run, with nothing changed, rather than hold the lock. Economic traffic
-- keeps running. The rows are attributed afterwards, outside any migration,
-- by `pnpm --dir services/economic-service db:backfill:resolved-dispute
-- --apply` (src/transaction/resolved-dispute-backfill.ts): batches of a few
-- hundred rows, each its own short transaction holding only those rows'
-- locks, so a concurrent move waits at most one batch; and the value written
-- is the trigger's, derived from the row under its lock, so a move that
-- commits between or during batches cannot be mis-attributed. Until it has
-- run, an unattributed row reads by the time rule, as before this migration.
--
-- Sizing, measured on a development host over 1,000,000 transactions
-- (400,000 attributable): once granted, the lock is held for the three
-- statements, under 10 ms; the one wait seen was autovacuum's, which yields
-- to DDL after `deadlock_timeout` (1 s) — and while ADD COLUMN waits, every
-- query on the table queues behind it, so the window to plan for is the
-- `lock_timeout`, 3 s, not the table's size. The backfill took 56 s: 2,000
-- batches of 500, about 28 ms each, and a move of a row in the batch waits at
-- most that. No maintenance window; run it once after the deploy, sliced with
-- `--max-batches` and resumed with `--after` if wanted (docs/23 D-060).
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "resolved_dispute_id" TEXT;

CREATE OR REPLACE FUNCTION assign_transaction_resolved_dispute() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."resolved_dispute_id" := NULL;
  ELSIF OLD."status" = 'DISPUTED' AND NEW."status" = 'PENDING_SETTLEMENT' THEN
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSIF OLD."resolved_dispute_id" IS NULL
        AND OLD."status" IN ('PENDING_SETTLEMENT', 'SETTLED')
        AND OLD."disputed_at" IS NOT NULL
        AND OLD."dispute_resolved_at" IS NOT NULL THEN
    -- Resolved before this column existed: its latest dispute's.
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSE
    NEW."resolved_dispute_id" := OLD."resolved_dispute_id";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_resolved_dispute"
  BEFORE INSERT OR UPDATE OF "status", "resolved_dispute_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION assign_transaction_resolved_dispute();
