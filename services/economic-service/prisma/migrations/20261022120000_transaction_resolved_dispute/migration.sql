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
-- Populated databases: a nullable column with no default, then one UPDATE of
-- the rows whose attribution is certain — PENDING_SETTLEMENT or SETTLED after
-- a dispute. Out of DISPUTED a row goes only to PENDING_SETTLEMENT, by a
-- resolution, or to REFUNDED, which it never leaves; so such a row's latest
-- dispute was resolved, by the resolution it records, and `dispute_id` is
-- that dispute's (the trigger of 20261016170000 keeps it). Every other row
-- stays NULL: an open dispute has no resolution of its own yet, and a
-- refunded row may have been refunded from DISPUTED, beside an earlier
-- dispute's resolution — which is the case this column exists for, and
-- nothing on the row says which. Readers keep the time rule for a row with no
-- identity. ADD COLUMN holds the table's ACCESS EXCLUSIVE lock to the end of
-- this migration, so no resolution can commit between the backfill and the
-- trigger; the trigger is created after the backfill, which it would
-- otherwise undo.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "resolved_dispute_id" TEXT;

UPDATE "transaction"
   SET "resolved_dispute_id" = "dispute_id"
 WHERE "status" IN ('PENDING_SETTLEMENT', 'SETTLED')
   AND "disputed_at" IS NOT NULL
   AND "dispute_resolved_at" IS NOT NULL
   AND "dispute_id" IS NOT NULL
   AND "resolved_dispute_id" IS NULL;

CREATE OR REPLACE FUNCTION assign_transaction_resolved_dispute() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."resolved_dispute_id" := NULL;
  ELSIF OLD."status" = 'DISPUTED' AND NEW."status" = 'PENDING_SETTLEMENT' THEN
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSE
    NEW."resolved_dispute_id" := OLD."resolved_dispute_id";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_resolved_dispute"
  BEFORE INSERT OR UPDATE OF "status", "resolved_dispute_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION assign_transaction_resolved_dispute();
