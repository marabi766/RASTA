-- =============================================================================
-- Reverse of `migration.sql` (20261007100000_amendments_milestones, CON-003 PR 3).
--
-- Restores `contract_guard` to what the sign-and-cancel migration made it, drops the milestones,
-- the amendments with their signatures and reviews, the two counters on `contract`, and the enum.
-- Roll the code back first: it reads and writes all of these.
--
-- **Refuses, and changes nothing, once any of this has been used.** An amendment is the record of
-- a change to what a contract is worth and of who agreed to it, a milestone is a plan a statement
-- may rest on, and `amendments_total_minor` is part of the price the cap is judged against;
-- dropping any of them would leave a contract worth something its records no longer explain. So
-- this script stops, with a message, when any amendment, amendment signature, authority review or
-- milestone exists, or any contract carries a non-zero amendments or approved total. On a database
-- where none of it was used it restores the previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all — run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it (a
-- refusal aborts the transaction either way). The `_prisma_migrations` row is removed last so the
-- forward migration can be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the drops.
LOCK TABLE "amendment_signature_review", "amendment_signature", "amendment", "milestone", "contract"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_amendments$
DECLARE
  amendments integer;
  signatures integer;
  reviews integer;
  milestones integer;
  counted integer;
BEGIN
  SELECT count(*) INTO amendments FROM "amendment";
  SELECT count(*) INTO signatures FROM "amendment_signature";
  SELECT count(*) INTO reviews FROM "amendment_signature_review";
  SELECT count(*) INTO milestones FROM "milestone";
  SELECT count(*) INTO counted FROM "contract"
   WHERE "amendments_total_minor" <> 0 OR "approved_total_minor" <> 0;
  IF amendments > 0 OR signatures > 0 OR reviews > 0 OR milestones > 0 OR counted > 0 THEN
    RAISE EXCEPTION 'down refused: % amendment(s), % amendment signature(s), % authority review(s), % milestone(s) and % contract(s) with a non-zero amount counter exist; nothing was changed', amendments, signatures, reviews, milestones, counted
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_amendments$;

DROP TRIGGER IF EXISTS "tg_amendment_signature_review_no_truncate" ON "amendment_signature_review";
DROP TRIGGER IF EXISTS "tg_amendment_signature_review_immutable" ON "amendment_signature_review";
DROP TABLE IF EXISTS "amendment_signature_review";
DROP FUNCTION IF EXISTS "amendment_signature_review_guard"();

DROP TRIGGER IF EXISTS "tg_milestone_no_truncate" ON "milestone";
DROP TRIGGER IF EXISTS "tg_milestone_guard" ON "milestone";
DROP TABLE IF EXISTS "milestone";
DROP FUNCTION IF EXISTS "milestone_guard"();

DROP TRIGGER IF EXISTS "tg_amendment_signature_no_truncate" ON "amendment_signature";
DROP TRIGGER IF EXISTS "tg_amendment_signature_immutable" ON "amendment_signature";
DROP TRIGGER IF EXISTS "tg_amendment_signature_insert" ON "amendment_signature";
DROP TABLE IF EXISTS "amendment_signature";
DROP FUNCTION IF EXISTS "amendment_signature_guard"();

DROP TRIGGER IF EXISTS "tg_amendment_total_consistent" ON "amendment";
DROP TRIGGER IF EXISTS "tg_amendment_no_truncate" ON "amendment";
DROP TRIGGER IF EXISTS "tg_amendment_guard" ON "amendment";
DROP TABLE IF EXISTS "amendment";
DROP FUNCTION IF EXISTS "amendment_total_consistent"();
DROP FUNCTION IF EXISTS "amendment_guard"();

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A cancelled or settled contract is history: nothing about it changes again.
    IF OLD."status" IN ('CANCELLED', 'SETTLED') THEN
      RAISE EXCEPTION 'ck_contract_final: a % contract never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SIGNED', 'CANCELLED'))
              OR (OLD."status" = 'SIGNED' AND NEW."status" = 'COMPLETED')
              OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'SETTLED')) THEN
        RAISE EXCEPTION 'ck_contract_transition: a contract cannot move from % to %', OLD."status", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Both parties have accepted, or the contract is not signed (Q-95 (1)).
      IF NEW."status" = 'SIGNED' THEN
        SELECT count(DISTINCT "side") INTO sides FROM "contract_signature"
         WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id";
        IF sides <> 2 THEN
          RAISE EXCEPTION 'ck_contract_signed_by_both: a contract is signed only when both sides have signed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    IF OLD."cancel_reason_code" IS NOT NULL
       AND (NEW."cancel_reason_code" IS DISTINCT FROM OLD."cancel_reason_code"
            OR NEW."cancel_note" IS DISTINCT FROM OLD."cancel_note") THEN
      RAISE EXCEPTION 'ck_contract_cancellation_immutable: the reason a contract was cancelled never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "contract" DROP CONSTRAINT IF EXISTS "ck_contract_approved_cap";
ALTER TABLE "contract" DROP CONSTRAINT IF EXISTS "ck_contract_amount_total_bound";
ALTER TABLE "contract"
  DROP COLUMN IF EXISTS "approved_total_minor",
  DROP COLUMN IF EXISTS "amendments_total_minor";

DROP TYPE IF EXISTS "AmendmentStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261007100000_amendments_milestones';

COMMIT;
