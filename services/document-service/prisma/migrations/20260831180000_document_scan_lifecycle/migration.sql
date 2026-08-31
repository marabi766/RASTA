-- =============================================================================
-- Asynchronous scan lifecycle for document-service (ADR-049, closes Q-18).
--
-- The init migration recorded a scan verdict. It had nowhere to record the
-- *process* that reaches one: how many attempts a document has cost, when the
-- next may start, which worker holds it, which signature database answered,
-- and what was done about an infection. All of that lived in a synchronous
-- call that ran before the row existed, so none of it needed storing.
--
-- ADR-014 step 4 always specified an asynchronous scan, and a real engine
-- makes that mandatory rather than merely intended: streaming tens of
-- megabytes through clamd inside an HTTP request would tie the caller's
-- connection to the scan queue and make every finalize as slow as the slowest
-- object ahead of it.
--
-- **Nothing here rewrites `20260830215511_init_document`.** Every object it
-- created is left alone except one CHECK constraint that is dropped and
-- re-added by name, so `down.sql` can restore the original wording exactly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Attribution of the verdict
-- ---------------------------------------------------------------------------

-- Which signature database reached the verdict, distinct from the engine
-- version already recorded. A CLEAN from a stale database and a CLEAN from a
-- current one are different claims; without this column they are the same row.
ALTER TABLE "document" ADD COLUMN "scan_signature_version" TEXT;

-- ---------------------------------------------------------------------------
-- 2. Queue bookkeeping
-- ---------------------------------------------------------------------------

ALTER TABLE "document" ADD COLUMN "scan_queued_at" TIMESTAMP(3);
ALTER TABLE "document" ADD COLUMN "scan_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "document" ADD COLUMN "scan_failure_reason" TEXT;
ALTER TABLE "document" ADD COLUMN "scan_next_attempt_at" TIMESTAMP(3);
ALTER TABLE "document" ADD COLUMN "scan_lease_owner" TEXT;
ALTER TABLE "document" ADD COLUMN "scan_lease_expires_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 3. Quarantine
-- ---------------------------------------------------------------------------

ALTER TABLE "document" ADD COLUMN "quarantined_at" TIMESTAMP(3);
ALTER TABLE "document" ADD COLUMN "quarantine_reason" TEXT;

-- ---------------------------------------------------------------------------
-- 4. The worker's claim query
-- ---------------------------------------------------------------------------

-- Every replica polls for claimable work on an interval. Unindexed, that is a
-- sequential scan of the whole table several times a second whose cost grows
-- with the number of documents the platform has ever held rather than with the
-- length of the queue.
CREATE INDEX "ix_document_scan_queue" ON "document"("scan_state", "scan_next_attempt_at");

-- ---------------------------------------------------------------------------
-- 5. Backfill, before the constraints that would otherwise refuse it
--
-- `ck_document_infected_is_quarantined` below is validated against every
-- existing row the moment it is added. The init schema permitted an `INFECTED`
-- document with no quarantine record — nothing produced one, because the only
-- scanner was a stub that inspects nothing, but the schema allowed it and a
-- migration must be safe against the database as defined rather than against
-- the database as expected.
--
-- Without this the migration aborts halfway on any deployment that holds one,
-- leaving the columns added and the constraints missing. Quarantining them is
-- also the right answer on the merits: they are infected, and the policy this
-- migration encodes is that an infection is held.
-- ---------------------------------------------------------------------------

UPDATE "document"
SET "quarantined_at" = COALESCE("scanned_at", "updated_at"),
    "quarantine_reason" = 'Backfilled by 20260831180000_document_scan_lifecycle: '
                          || 'infected before the quarantine record existed'
WHERE "scan_state" = 'INFECTED' AND "quarantined_at" IS NULL;

-- The same problem in the other direction, for the failure-reason rule.
-- A `FAILED` row predating this migration has no reason column to have filled
-- in, and `ck_document_failure_reason_only_when_failed` demands one.
UPDATE "document"
SET "scan_failure_reason" = 'UNRECORDED'
WHERE "scan_state" = 'FAILED' AND "scan_failure_reason" IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Invariants the database enforces itself
--
-- Same reasoning as the init migration: each rule is enforced by the domain
-- too, and repeated here because a CHECK constraint holds against a repair
-- script, a future code path and a mistaken migration — none of which goes
-- through the domain service.
-- ---------------------------------------------------------------------------

-- A quarantine record is both parts or neither, and only an infection is
-- quarantined.
--
-- The second half is the load-bearing one. Quarantine is what makes "infected
-- documents are held" a fact about the row rather than a promise in a
-- document, and a quarantine record on a row whose state says CLEAN would be a
-- held document that is downloadable.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_quarantine_complete"
  CHECK (
    ("quarantined_at" IS NULL AND "quarantine_reason" IS NULL)
    OR ("quarantined_at" IS NOT NULL AND "quarantine_reason" IS NOT NULL
        AND "scan_state" = 'INFECTED')
  );

-- Every infection is quarantined, with no window in between.
--
-- The converse of the rule above, and the one that actually protects the
-- policy: without it a row could be INFECTED and unquarantined, which is what
-- a partial write or a hand-run UPDATE would leave behind, and it would look
-- like a document nobody had decided about yet.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_infected_is_quarantined"
  CHECK ("scan_state" <> 'INFECTED' OR "quarantined_at" IS NOT NULL);

-- A failure reason belongs to a failure.
--
-- Both directions. A FAILED row with no reason is a scan nobody can diagnose
-- and cannot re-drive selectively; a reason on a CLEAN row is a contradiction
-- an operator filtering for problems would act on.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_failure_reason_only_when_failed"
  CHECK (
    ("scan_state" = 'FAILED' AND "scan_failure_reason" IS NOT NULL)
    OR ("scan_state" <> 'FAILED' AND "scan_failure_reason" IS NULL)
  );

-- Attempts are counted, never decremented into meaninglessness.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_scan_attempts_non_negative"
  CHECK ("scan_attempts" >= 0);

-- A lease names its holder and its expiry together.
--
-- A lease with an owner and no expiry never expires, so a worker that died
-- holding it would park that document forever — the failure mode a lease
-- exists to prevent, reintroduced by a half-written row.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_scan_lease_complete"
  CHECK (
    ("scan_lease_owner" IS NULL AND "scan_lease_expires_at" IS NULL)
    OR ("scan_lease_owner" IS NOT NULL AND "scan_lease_expires_at" IS NOT NULL)
  );

-- Only a document still waiting may be leased.
--
-- A lease surviving on a document that already reached CLEAN or INFECTED would
-- be claimable-looking work whose verdict is already written, and a worker
-- picking it up would be racing a decision that is over.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_scan_lease_only_when_pending"
  CHECK ("scan_lease_owner" IS NULL OR "scan_state" = 'PENDING');

-- A signature belongs to an infection.
--
-- Unchanged in meaning from the init migration, and restated only because the
-- quarantine rules above depend on the same INFECTED row carrying it: the two
-- must not be able to drift into disagreeing about where a signature lives.
ALTER TABLE "document" DROP CONSTRAINT "ck_document_signature_only_when_infected";
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_signature_only_when_infected"
  CHECK ("scan_signature" IS NULL OR "scan_state" = 'INFECTED');

-- ---------------------------------------------------------------------------
-- 7. Existing rows
--
-- Documents registered before this migration hold whatever the synchronous
-- path recorded: `NOT_SCANNED` from the stub, or `PENDING` from a finalize
-- that never reached a scanner. Neither is downloadable and neither verdict is
-- touched — `NOT_SCANNED` must keep saying that nothing looked at those bytes
-- (Q-18), and rewriting it to `PENDING` would erase the distinction the whole
-- open question turned on. Re-examining them is a backfill an operator runs
-- deliberately, described in `docs/runbooks`, not something a migration does
-- to a table while nobody is watching.
--
-- The one thing they need is a queue timestamp, so a `PENDING` row written
-- before the worker existed is claimable rather than invisible to it.
-- Backfilled from `created_at`, which is when it genuinely entered the queue.
-- ---------------------------------------------------------------------------

UPDATE "document"
SET "scan_queued_at" = "created_at"
WHERE "scan_state" = 'PENDING' AND "scan_queued_at" IS NULL;
