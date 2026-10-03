-- =============================================================================
-- construction-service — the stable identity of the people a later check compares (#188, part B)
--
-- `user_id` is `rasta_uid ?? sub` (AuthGuard), so one person can carry two user ids and
-- pass a separation-of-duties check alone. Beside every user id that a later check compares
-- with another person, the token's verified issuer and subject are now kept:
--
--   tender                  the opening's proposer (bid-opening four eyes, Q-91), the creator and
--                           the publisher (EVALUATOR_NOT_TENDER_AUTHOR), the evaluation's completer
--   approval_policy         the author and the submitter (policy four eyes, Q-70 (7))
--   bid_qualification       who decided on a bid       } the evaluators, whom an awarder is
--   bid_evaluation          who evaluated a bid        } compared with (AWARDER_NOT_EVALUATOR)
--   bid_evaluation_recusal  who stood down from a bid  }
--
-- Every pair is nullable and **not backfilled**: the issuer and subject behind an old user id
-- cannot be known from this service's data (reading identity-service's would break A-01, and
-- would still be a guess). An old row is therefore UNKNOWN, and every check that reads it fails
-- closed (`ACTOR_IDENTITY_UNKNOWN`). The remedies are documented in docs/09 § 9.3: an old
-- opening proposal is withdrawn and proposed again; an old pending or draft policy is withdrawn
-- and a new one written. New writes always fill the pairs (tested; a NOT NULL on new rows alone
-- cannot be expressed without breaking the old ones).
--
-- Adding nullable columns rewrites no row and fires no row trigger, so the append-only tables
-- (`bid_append_only`) accept this migration unchanged.
-- =============================================================================

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "created_by_issuer" TEXT,
ADD COLUMN "created_by_subject" TEXT,
ADD COLUMN "published_by_issuer" TEXT,
ADD COLUMN "published_by_subject" TEXT,
ADD COLUMN "evaluated_by_issuer" TEXT,
ADD COLUMN "evaluated_by_subject" TEXT,
ADD COLUMN "opening_proposed_by_issuer" TEXT,
ADD COLUMN "opening_proposed_by_subject" TEXT;

-- AlterTable
ALTER TABLE "approval_policy" ADD COLUMN "created_by_issuer" TEXT,
ADD COLUMN "created_by_subject" TEXT,
ADD COLUMN "submitted_by_issuer" TEXT,
ADD COLUMN "submitted_by_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_qualification" ADD COLUMN "decided_by_issuer" TEXT,
ADD COLUMN "decided_by_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_evaluation" ADD COLUMN "evaluator_issuer" TEXT,
ADD COLUMN "evaluator_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_evaluation_recusal" ADD COLUMN "evaluator_issuer" TEXT,
ADD COLUMN "evaluator_subject" TEXT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Each pair is both or neither, never blank, and only beside the user id it describes: half a
-- pair proves nothing about who someone is, and an identity with no actor names nobody.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_created_by_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL
              OR (btrim("created_by_issuer") <> '' AND btrim("created_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_published_by_identity"
  CHECK (num_nonnulls("published_by_issuer", "published_by_subject") IN (0, 2)
         AND ("published_by_issuer" IS NULL
              OR ("published_by" IS NOT NULL
                  AND btrim("published_by_issuer") <> '' AND btrim("published_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_evaluated_by_identity"
  CHECK (num_nonnulls("evaluated_by_issuer", "evaluated_by_subject") IN (0, 2)
         AND ("evaluated_by_issuer" IS NULL
              OR ("evaluated_by" IS NOT NULL
                  AND btrim("evaluated_by_issuer") <> '' AND btrim("evaluated_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_opening_proposed_by_identity"
  CHECK (num_nonnulls("opening_proposed_by_issuer", "opening_proposed_by_subject") IN (0, 2)
         AND ("opening_proposed_by_issuer" IS NULL
              OR ("opening_proposed_by" IS NOT NULL
                  AND btrim("opening_proposed_by_issuer") <> ''
                  AND btrim("opening_proposed_by_subject") <> '')));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_created_by_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL
              OR (btrim("created_by_issuer") <> '' AND btrim("created_by_subject") <> '')));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_submitted_by_identity"
  CHECK (num_nonnulls("submitted_by_issuer", "submitted_by_subject") IN (0, 2)
         AND ("submitted_by_issuer" IS NULL
              OR ("submitted_by" IS NOT NULL
                  AND btrim("submitted_by_issuer") <> '' AND btrim("submitted_by_subject") <> '')));

ALTER TABLE "bid_qualification" ADD CONSTRAINT "ck_bid_qualification_decided_by_identity"
  CHECK (num_nonnulls("decided_by_issuer", "decided_by_subject") IN (0, 2)
         AND ("decided_by_issuer" IS NULL
              OR (btrim("decided_by_issuer") <> '' AND btrim("decided_by_subject") <> '')));

ALTER TABLE "bid_evaluation" ADD CONSTRAINT "ck_bid_evaluation_evaluator_identity"
  CHECK (num_nonnulls("evaluator_issuer", "evaluator_subject") IN (0, 2)
         AND ("evaluator_issuer" IS NULL
              OR (btrim("evaluator_issuer") <> '' AND btrim("evaluator_subject") <> '')));

ALTER TABLE "bid_evaluation_recusal" ADD CONSTRAINT "ck_bid_recusal_evaluator_identity"
  CHECK (num_nonnulls("evaluator_issuer", "evaluator_subject") IN (0, 2)
         AND ("evaluator_issuer" IS NULL
              OR (btrim("evaluator_issuer") <> '' AND btrim("evaluator_subject") <> '')));
