-- =============================================================================
-- supplier-service — initial schema.
--
-- Creates the whole database in one migration because there is no previous
-- state to be compatible with: this service has never been deployed, so the
-- rolling-compatibility discipline the eight existing services follow (add a
-- nullable column, backfill, then constrain) buys nothing here and would only
-- split one reviewable object into five.
--
-- The outbox arrives already at the shape the platform reached through four
-- separate migrations (ADR-050, then ADR-051 Phase B1's three files). It is
-- reproduced here in full — every column, every CHECK, every index, by the same
-- names and the same definitions — because `scripts/verify-outbox-claim-migration.mjs`
-- and `scripts/verify-outbox-b1-lib.mjs` assert those objects **by definition
-- rather than by name**, and a service whose outbox merely looks similar would
-- pass an existence check and fail the real one.
--
-- ADR-051 Phase B2 adds no schema: it is a backfill tool for rows written
-- before sequencing existed. This database has no such rows, so B2 is a no-op
-- here and `stream_seq` is created nullable exactly as B1 leaves it elsewhere.
-- Nothing in this service allocates a sequence or maintains a head flag; B3-B6
-- are not merged and must not be anticipated.
--
-- Business logic never lives in a migration (AGENTS.md § 3). Every CHECK below
-- is a structural invariant — "a decision names its actor", "an evidence
-- reference is not an empty string" — not a policy about who may decide what.
-- =============================================================================

-- Fail fast rather than queue behind a long transaction.
SET LOCAL lock_timeout = '3s';

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "SupplierCapabilityKind" AS ENUM ('GOODS_SUPPLY', 'WORKSHOP_SERVICE', 'CONTRACTING');

CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TYPE "QualificationState" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- -----------------------------------------------------------------------------
-- supplier
-- -----------------------------------------------------------------------------

CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "registered_by" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "registered_correlation_id" TEXT NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- One profile per organization. Two would make ListQualifiedFor answer the same
-- question twice with different answers.
CREATE UNIQUE INDEX "supplier_organization_id_key" ON "supplier"("organization_id");

CREATE INDEX "ix_supplier_status" ON "supplier"("status");

-- A name made of spaces satisfies NOT NULL and is not a name. The DTO refuses
-- it too; this is what makes the refusal true for every future write path.
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_display_name_not_blank"
  CHECK (length(btrim("display_name")) > 0);

-- Provenance is not optional (AGENTS.md S-06). A row that cannot say who
-- created it or under which correlation id is not auditable.
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_actor_recorded"
  CHECK (length(btrim("registered_by")) > 0 AND length(btrim("registered_correlation_id")) > 0);

-- -----------------------------------------------------------------------------
-- supplier_capability
-- -----------------------------------------------------------------------------

CREATE TABLE "supplier_capability" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "capability" "SupplierCapabilityKind" NOT NULL,
    "declared_by" TEXT NOT NULL,
    "declared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_capability_pkey" PRIMARY KEY ("id")
);

-- "Duplicate capabilities for one supplier are impossible" — asserted here, so
-- it holds against a future write path that forgets to deduplicate, and not
-- only against the DTO that guards today's.
CREATE UNIQUE INDEX "ux_supplier_capability" ON "supplier_capability"("supplier_id", "capability");

CREATE INDEX "ix_supplier_capability_kind" ON "supplier_capability"("capability");

ALTER TABLE "supplier_capability" ADD CONSTRAINT "ck_supplier_capability_actor_recorded"
  CHECK (length(btrim("declared_by")) > 0);

-- -----------------------------------------------------------------------------
-- qualification
-- -----------------------------------------------------------------------------

CREATE TABLE "qualification" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "capability" "SupplierCapabilityKind" NOT NULL,
    "state" "QualificationState" NOT NULL DEFAULT 'SUBMITTED',
    "statement" TEXT,
    "submitted_by" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_correlation_id" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_correlation_id" TEXT,
    "decision_note" TEXT,

    CONSTRAINT "qualification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_qualification_supplier_state" ON "qualification"("supplier_id", "state");
CREATE INDEX "ix_qualification_review_queue" ON "qualification"("state", "capability");
CREATE INDEX "ix_qualification_org_state" ON "qualification"("organization_id", "state");

-- The state machine, as a constraint rather than as a hope.
--
-- SUBMITTED means nobody has decided: all three decision columns are null.
-- APPROVED and REJECTED mean somebody did: all three are present. There is no
-- third shape, so "only submitted qualifications may be approved or rejected"
-- and "decision records cannot omit actor or timestamp" are both properties of
-- the table. A decided row can never be read as still open, which is what makes
-- "a rejected qualification cannot be reported as qualified" structural.
ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_decision_complete"
  CHECK (
    ("state" = 'SUBMITTED'
       AND "decided_by" IS NULL AND "decided_at" IS NULL AND "decided_correlation_id" IS NULL)
    OR
    ("state" IN ('APPROVED', 'REJECTED')
       AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
       AND "decided_correlation_id" IS NOT NULL)
  );

-- A decision cannot predate the submission it decides.
ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_decided_after_submitted"
  CHECK ("decided_at" IS NULL OR "decided_at" >= "submitted_at");

-- A note is the reviewer's account of a decision; without a decision there is
-- nothing for it to be about.
ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_note_requires_decision"
  CHECK ("decision_note" IS NULL OR "decided_at" IS NOT NULL);

ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_text_not_blank"
  CHECK (
    length(btrim("submitted_by")) > 0
    AND length(btrim("submitted_correlation_id")) > 0
    AND ("statement" IS NULL OR length(btrim("statement")) > 0)
    AND ("decided_by" IS NULL OR length(btrim("decided_by")) > 0)
    AND ("decision_note" IS NULL OR length(btrim("decision_note")) > 0)
  );

-- At most one open submission per (supplier, capability).
--
-- Without it, two submissions could sit in SUBMITTED for the same capability
-- and two reviewers could decide them differently — the supplier would then be
-- both approved and rejected for one thing, and ListQualifiedFor would have to
-- pick one arbitrarily.
CREATE UNIQUE INDEX "ux_qualification_open"
    ON "qualification"("supplier_id", "capability")
 WHERE "state" = 'SUBMITTED';

-- At most one approval per (supplier, capability).
--
-- This is what "only currently approved qualification satisfies
-- ListQualifiedFor" rests on: the query joins one row, not an arbitrary member
-- of a set. Rejections are deliberately not constrained — a supplier may be
-- refused repeatedly, and each refusal is its own auditable record.
CREATE UNIQUE INDEX "ux_qualification_approved"
    ON "qualification"("supplier_id", "capability")
 WHERE "state" = 'APPROVED';

-- -----------------------------------------------------------------------------
-- qualification_evidence
-- -----------------------------------------------------------------------------

CREATE TABLE "qualification_evidence" (
    "id" TEXT NOT NULL,
    "qualification_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "label" TEXT,
    "attached_by" TEXT NOT NULL,
    "attached_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qualification_evidence_pkey" PRIMARY KEY ("id")
);

-- The same document attached twice to one submission is a duplicate, not two
-- pieces of evidence.
CREATE UNIQUE INDEX "ux_qualification_evidence_document"
    ON "qualification_evidence"("qualification_id", "document_id");

-- "Evidence references cannot be empty strings." An empty document id is a
-- reference to nothing that still counts as an attachment when somebody reads
-- the row, which is worse than no attachment at all.
ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_document_id_not_blank"
  CHECK (length(btrim("document_id")) > 0);

ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_text_not_blank"
  CHECK (
    length(btrim("attached_by")) > 0
    AND ("label" IS NULL OR length(btrim("label")) > 0)
  );

-- -----------------------------------------------------------------------------
-- suspension
-- -----------------------------------------------------------------------------

CREATE TABLE "suspension" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suspended_by" TEXT NOT NULL,
    "suspended_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspended_correlation_id" TEXT NOT NULL,
    "reinstated_by" TEXT,
    "reinstated_at" TIMESTAMP(3),
    "reinstated_correlation_id" TEXT,
    "reinstatement_note" TEXT,

    CONSTRAINT "suspension_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_suspension_supplier" ON "suspension"("supplier_id", "suspended_at");

-- At most one open episode per supplier. A second open row would make "is this
-- supplier suspended, and by whom" a question with two answers, and reinstating
-- would close only one of them.
CREATE UNIQUE INDEX "ux_suspension_open"
    ON "suspension"("supplier_id")
 WHERE "reinstated_at" IS NULL;

-- A reinstatement carries all three parts or none, for the same reason a
-- qualification decision does: two of three is a record that cannot say who
-- lifted the suspension, or when.
ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_reinstatement_complete"
  CHECK (num_nonnulls("reinstated_by", "reinstated_at", "reinstated_correlation_id") IN (0, 3));

ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_reinstated_after_suspended"
  CHECK ("reinstated_at" IS NULL OR "reinstated_at" >= "suspended_at");

ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_note_requires_reinstatement"
  CHECK ("reinstatement_note" IS NULL OR "reinstated_at" IS NOT NULL);

ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_text_not_blank"
  CHECK (
    length(btrim("reason")) > 0
    AND length(btrim("suspended_by")) > 0
    AND length(btrim("suspended_correlation_id")) > 0
    AND ("reinstated_by" IS NULL OR length(btrim("reinstated_by")) > 0)
    AND ("reinstatement_note" IS NULL OR length(btrim("reinstatement_note")) > 0)
  );

-- -----------------------------------------------------------------------------
-- Foreign keys — RESTRICT everywhere, deliberately.
--
-- "No destructive cascade may erase qualification or suspension history
-- accidentally." ON DELETE CASCADE on any of these would mean one DELETE on
-- `supplier` silently removes every decision anybody ever recorded about it —
-- the exact records an audit exists to read. RESTRICT turns that into a foreign
-- key violation, which is a conversation rather than a loss.
-- -----------------------------------------------------------------------------

ALTER TABLE "supplier_capability"
  ADD CONSTRAINT "supplier_capability_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "qualification"
  ADD CONSTRAINT "qualification_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "qualification_evidence"
  ADD CONSTRAINT "qualification_evidence_qualification_id_fkey"
  FOREIGN KEY ("qualification_id") REFERENCES "qualification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "suspension"
  ADD CONSTRAINT "suspension_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Transactional outbox (ADR-021, ADR-050, ADR-051 Phase B1)
-- =============================================================================

CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "organization_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    -- ADR-050 durable claim.
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),

    -- ADR-051 Phase B1. Inert: nothing in this service writes either column.
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- ---- ADR-050 CHECK constraints ----------------------------------------------

-- An active claim carries all three parts or none. Two of three describes a row
-- that has no fence, or no expiry, or looks unowned to the metrics while
-- somebody is publishing it.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- A published row holds no claim metadata and no scheduled retry. This is also
-- what makes `purgePublished` safe: it can never delete a row some worker still
-- holds a live lease on.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

-- `next_attempt_at` only means something for an unpublished row that has
-- already failed at least once.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- ---- ADR-050 claim indexes --------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_outbox_claimable"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_claim_expiry"
    ON "outbox_message" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_next_attempt"
    ON "outbox_message" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-050 eligibility-stream indexes -------------------------------------
--
-- The four streams `claimPendingSql` selects from. `now()` is stable rather
-- than immutable, so the planner cannot estimate `<= now()` and falls back to
-- 33% selectivity; these remove the estimate from the decision by making each
-- stream's eligibility test either statically true or a range on that index's
-- own leading column.

CREATE INDEX IF NOT EXISTS "ix_outbox_due_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-051 Phase B1 -------------------------------------------------------
--
-- The counter table, the partial unique index and the four head indexes, at the
-- definitions `scripts/verify-outbox-b1-lib.mjs` asserts. Every one is inert:
-- `is_stream_head` is false on every row this service writes, so all four head
-- indexes stay empty and no query references them.

CREATE TABLE IF NOT EXISTS "outbox_stream_sequence" (
    "topic"         TEXT   NOT NULL,
    "partition_key" TEXT   NOT NULL,
    "next_seq"      BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic", "partition_key")
);

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL — which, since nothing allocates one in this
-- service, is every row after the first per stream. That is a total write
-- outage, and it passes an existence check.
--
-- Not declared in schema.prisma: Prisma has no syntax for an index predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_outbox_stream_seq"
    ON "outbox_message" ("topic", "partition_key", "stream_seq")
 WHERE "stream_seq" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_head_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";

-- =============================================================================
-- processed_event (A-09)
--
-- Created with no handler registered. See the model comment in schema.prisma:
-- every event docs/04 lists for this service feeds the performance score, which
-- Q-12 has not defined, and an empty handler that wrote a row here would look
-- like the event was processed (ADR-032).
-- =============================================================================

CREATE TABLE "processed_event" (
    "event_id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id", "consumer_name")
);
