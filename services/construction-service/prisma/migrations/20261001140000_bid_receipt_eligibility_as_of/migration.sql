-- =============================================================================
-- construction-service — the eligibility decision's effective instant, per bid revision
-- (CON-002 PR 6, ADR-067)
--
-- Eligibility to bid is decided by supplier-service at submit time (not from the read
-- model), and that read is not held in a transaction with the bid's commit: a contractor
-- suspended between the two is not stopped. The MVP ruling is that the decision's
-- effective instant is the supplier check, recorded here with the revision's append-only
-- receipt; the award step re-checks current standing and refuses an award to a contractor
-- suspended at award time.
--
-- Existing rows (none outside a development database) take the instant they were
-- received; new rows must state it.
-- =============================================================================

ALTER TABLE "bid_receipt" ADD COLUMN "eligible_as_of" TIMESTAMP(3) NOT NULL DEFAULT now();
ALTER TABLE "bid_receipt" ALTER COLUMN "eligible_as_of" DROP DEFAULT;
