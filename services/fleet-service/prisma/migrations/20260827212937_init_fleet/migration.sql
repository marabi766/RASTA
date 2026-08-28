-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AssignmentEndReason" AS ENUM ('COMPLETED', 'CANCELLED', 'DRIVER_UNAVAILABLE', 'ASSET_UNAVAILABLE', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "UsageSource" AS ENUM ('MANUAL', 'TELEMATICS', 'IMPORTED');

-- CreateTable
CREATE TABLE "driver" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "employee_no" TEXT,
    "licence_number" TEXT,
    "licence_class" TEXT,
    "licence_valid_to" TIMESTAMP(3),
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "purpose" TEXT,
    "end_reason" "AssignmentEndReason",
    "end_notes" TEXT,
    "assigned_by" TEXT NOT NULL,
    "ended_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_record" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "assignment_id" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(10,2),
    "kilometres" DECIMAL(12,2),
    "hour_meter" DECIMAL(12,2),
    "odometer" DECIMAL(12,2),
    "source" "UsageSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "client_reference" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "usage_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_window" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL,
    "to_at" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "availability_window_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_ref" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT,
    "asset_type" TEXT,
    "asset_tag" TEXT,
    "status" TEXT NOT NULL,
    "in_maintenance" BOOLEAN NOT NULL DEFAULT false,
    "dispatch_blocked_reason" TEXT,
    "dispatch_blocked_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL,
    "source_event" TEXT NOT NULL,

    CONSTRAINT "asset_ref_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_event" (
    "event_id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer_name")
);

-- CreateIndex
CREATE INDEX "driver_organization_id_status_idx" ON "driver"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "driver_organization_id_user_id_key" ON "driver"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "assignment_organization_id_driver_id_started_at_idx" ON "assignment"("organization_id", "driver_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "assignment_organization_id_asset_id_started_at_idx" ON "assignment"("organization_id", "asset_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "assignment_organization_id_ended_at_idx" ON "assignment"("organization_id", "ended_at");

-- CreateIndex
CREATE INDEX "usage_record_organization_id_asset_id_period_end_idx" ON "usage_record"("organization_id", "asset_id", "period_end" DESC);

-- CreateIndex
CREATE INDEX "usage_record_organization_id_driver_id_period_end_idx" ON "usage_record"("organization_id", "driver_id", "period_end" DESC);

-- CreateIndex
CREATE INDEX "usage_record_assignment_id_idx" ON "usage_record"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_record_organization_id_client_reference_key" ON "usage_record"("organization_id", "client_reference");

-- CreateIndex
CREATE INDEX "availability_window_organization_id_asset_id_from_at_idx" ON "availability_window"("organization_id", "asset_id", "from_at");

-- CreateIndex
CREATE INDEX "availability_window_organization_id_revoked_at_to_at_idx" ON "availability_window"("organization_id", "revoked_at", "to_at");

-- CreateIndex
CREATE INDEX "asset_ref_organization_id_status_idx" ON "asset_ref"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Invariants Prisma cannot express
--
-- Everything below is hand-written and must be preserved. Prisma's schema
-- language has no syntax for a partial index or a CHECK constraint, so it does
-- not know these exist. The consequence to watch for: a future
-- `prisma migrate dev` diffs schema.prisma against the database and may
-- propose DROPping them. Reject that hunk. There is no drift here — the shadow
-- database gets these objects from this very file — but the generated diff
-- cannot see why they are wanted.
--
-- The names are mirrored in src/fleet/constraints.ts, where the code that
-- turns a violation into a business error matches on them.
-- =============================================================================

-- One active assignment per driver.
--
-- The invariant docs/03 § 3.3 and docs/05 § 5.5 both specify, verbatim:
-- UNIQUE (driver_id) WHERE ended_at IS NULL. An application-level
-- check-then-insert cannot enforce it — two concurrent requests both read
-- "no active assignment" and both insert. This index is what actually holds
-- the line.
CREATE UNIQUE INDEX "ux_assignment_active_driver"
  ON "assignment" ("driver_id")
  WHERE "ended_at" IS NULL;

-- One active assignment per asset.
--
-- Decided in ADR-025, not inherited from a document. The reasoning: asset
-- lifecycle state is single-valued (asset-service's OperationalStatus), so two
-- concurrent assignments would make an asset's status — and the "which
-- machines are free" answer the product document promises — meaningless.
--
-- If multi-shift crewing is later adopted, this index is what must be dropped,
-- and dropping it requires answering how an asset reports its status when two
-- drivers hold it. Tracked as docs/24 Q-23.
CREATE UNIQUE INDEX "ux_assignment_active_asset"
  ON "assignment" ("asset_id")
  WHERE "ended_at" IS NULL;

-- An assignment cannot end before it started.
--
-- Checked in the domain service too, for a readable error. Here as well
-- because a corrective script or a future code path would bypass that check,
-- and a negative-duration assignment silently corrupts every utilization
-- figure computed from it.
ALTER TABLE "assignment"
  ADD CONSTRAINT "ck_assignment_period"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- A usage period cannot end before it started, for the same reason.
ALTER TABLE "usage_record"
  ADD CONSTRAINT "ck_usage_period"
  CHECK ("period_end" > "period_start");

-- A usage record must measure something.
--
-- A row with neither hours nor kilometres records that a machine was used for
-- an unknown amount, which is worse than no row at all: it inflates the record
-- count that "we have no readings" is distinguished from.
ALTER TABLE "usage_record"
  ADD CONSTRAINT "ck_usage_has_measure"
  CHECK ("hours" IS NOT NULL OR "kilometres" IS NOT NULL);

-- Quantities are never negative. A machine cannot travel backwards, and a
-- negative reading would subtract from a maintenance schedule's accumulated
-- total — deferring a service that is actually due.
ALTER TABLE "usage_record"
  ADD CONSTRAINT "ck_usage_non_negative"
  CHECK (
    ("hours" IS NULL OR "hours" >= 0) AND
    ("kilometres" IS NULL OR "kilometres" >= 0) AND
    ("hour_meter" IS NULL OR "hour_meter" >= 0) AND
    ("odometer" IS NULL OR "odometer" >= 0)
  );

-- An availability window cannot end before it starts.
ALTER TABLE "availability_window"
  ADD CONSTRAINT "ck_availability_period"
  CHECK ("to_at" IS NULL OR "to_at" > "from_at");

-- A driver that is not ACTIVE must say why.
--
-- AGENTS.md S-06 asks every state change to record who did what and why. A
-- suspension with no reason is a decision nobody can review later.
ALTER TABLE "driver"
  ADD CONSTRAINT "ck_driver_status_reason"
  CHECK ("status" = 'ACTIVE' OR "status_reason" IS NOT NULL);
