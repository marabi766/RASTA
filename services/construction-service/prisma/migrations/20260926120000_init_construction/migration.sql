-- =============================================================================
-- construction-service — initial schema (CON-001 PR 1, ADR-063)
--
-- Projects and their needs as explicit database state machines, the
-- idempotency store for the two create endpoints, and the platform's outbox at
-- the shape every other service reached (ADR-021, ADR-050, ADR-051 B1).
--
-- The outbox arrives folded into this one migration, as supplier-service's did:
-- there is no earlier deployed state to stay compatible with. Its objects are
-- therefore verified by `scripts/verify-migration-reversible.mjs construction`
-- (EXPECTED.construction), not by the by-name outbox verifiers.
--
-- `geography` is PostGIS, installed by the postgres init script into every
-- service database; this migration does not create extensions.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectNeedStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "scope_of_work" TEXT NOT NULL,
    "location_description" TEXT NOT NULL,
    "area" geography(Polygon, 4326),
    "estimated_cost_minor" BIGINT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMP(3) NOT NULL,
    "status_changed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_need" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "estimated_cost_minor" BIGINT,
    "status" "ProjectNeedStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "withdrawn_at" TIMESTAMP(3),
    "withdrawn_by" TEXT,
    "withdrawal_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "project_need_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "resource_id" TEXT,
    "state" "IdempotencyState" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id","endpoint","key")
);

-- CreateTable
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
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_stream_sequence" (
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic","partition_key")
);

-- CreateTable
CREATE TABLE "processed_event" (
    "event_id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer_name")
);

-- CreateIndex
CREATE INDEX "ix_project_org_status" ON "project"("organization_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_project_org_id" ON "project"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_project_need_org_project_status" ON "project_need"("organization_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "ix_project_need_org_project_id" ON "project_need"("organization_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "ix_idempotency_expires" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "project_need" ADD CONSTRAINT "project_need_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "project"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- project ------------------------------------------------------------------

-- A required text that is only whitespace answers nothing. The DTOs trim and
-- refuse it first; this holds for every other write path.
ALTER TABLE "project" ADD CONSTRAINT "ck_project_text_not_blank"
  CHECK (btrim("title") <> '' AND btrim("operation_type") <> ''
         AND btrim("scope_of_work") <> '' AND btrim("location_description") <> '');

-- Every change names who made it (AGENTS.md S-06).
ALTER TABLE "project" ADD CONSTRAINT "ck_project_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("updated_by") <> ''
         AND btrim("status_changed_by") <> '' AND btrim("created_correlation_id") <> '');

-- Money is never negative here. Whether zero is a meaningful estimate is not
-- this schema's question (Q-68), so zero is allowed.
ALTER TABLE "project" ADD CONSTRAINT "ck_project_estimate_nonneg"
  CHECK ("estimated_cost_minor" IS NULL OR "estimated_cost_minor" >= 0);

-- A cancellation without a reason answers who and when but not why.
ALTER TABLE "project" ADD CONSTRAINT "ck_project_cancellation_has_reason"
  CHECK ("status" <> 'CANCELLED'
         OR ("status_reason" IS NOT NULL AND btrim("status_reason") <> ''));

ALTER TABLE "project" ADD CONSTRAINT "ck_project_version_positive"
  CHECK ("version" >= 1);

-- Nothing about a project predates its creation.
ALTER TABLE "project" ADD CONSTRAINT "ck_project_timestamps_ordered"
  CHECK ("updated_at" >= "created_at" AND "status_changed_at" >= "created_at");

-- An operating area PostGIS itself would call invalid (a self-intersecting
-- ring, a spike) is refused rather than stored and silently mis-measured.
ALTER TABLE "project" ADD CONSTRAINT "ck_project_area_valid"
  CHECK ("area" IS NULL OR ST_IsValid("area"::geometry));

CREATE INDEX "ix_project_area" ON "project" USING GIST ("area");

-- ---- project_need -------------------------------------------------------------

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_text_not_blank"
  CHECK (btrim("title") <> '' AND btrim("description") <> ''
         AND ("unit" IS NULL OR btrim("unit") <> ''));

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("updated_by") <> ''
         AND btrim("created_correlation_id") <> '');

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_quantity_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_estimate_nonneg"
  CHECK ("estimated_cost_minor" IS NULL OR "estimated_cost_minor" >= 0);

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_version_positive"
  CHECK ("version" >= 1);

-- A submission names its actor and its time, both or neither. A SUBMITTED need
-- has one and a DRAFT need has none; a WITHDRAWN need may have either, since a
-- draft can be withdrawn without ever being submitted.
ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_submission_complete"
  CHECK (num_nonnulls("submitted_at", "submitted_by") IN (0, 2)
         AND ("status" <> 'SUBMITTED' OR "submitted_at" IS NOT NULL)
         AND ("status" <> 'DRAFT' OR "submitted_at" IS NULL));

-- A withdrawal names who, when and why — all three exactly when the need is
-- WITHDRAWN.
ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_withdrawal_complete"
  CHECK (num_nonnulls("withdrawn_at", "withdrawn_by", "withdrawal_reason") IN (0, 3)
         AND (("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL))
         AND ("withdrawal_reason" IS NULL OR btrim("withdrawal_reason") <> ''));

ALTER TABLE "project_need" ADD CONSTRAINT "ck_need_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("submitted_at" IS NULL OR "submitted_at" >= "created_at")
         AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "created_at"));

-- ---- Idempotency ------------------------------------------------------------

-- A completed key carries the response it replays and the resource it created.
-- Completion is written in the same transaction as that resource, so a key
-- that says COMPLETED always names something that exists, and a resource
-- created under a key always has its key completed (docs/06 § 6.8).
ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_completed_has_result"
  CHECK ("state" <> 'COMPLETED'
         OR ("response_status" IS NOT NULL
             AND "response_body" IS NOT NULL
             AND "resource_id" IS NOT NULL));

ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_claim_token_not_blank"
  CHECK (length(btrim("claim_token")) > 0);

-- =============================================================================
-- Transactional outbox — the claim and stream objects Prisma cannot declare
-- =============================================================================

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

-- ---- ADR-051 -----------------------------------------------------------------
--
-- The partial unique index and the four head indexes, at the definitions
-- `scripts/verify-outbox-b1-lib.mjs` asserts. The head indexes stay empty:
-- `is_stream_head` is false on every row this service writes (B4 is not merged).

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL. That is a total write outage, and it passes an
-- existence check.
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
