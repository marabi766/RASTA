-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'CORRECTIVE');

-- CreateEnum
CREATE TYPE "ScheduleRecurrence" AS ENUM ('RECURRING', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MaintenanceRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BreakdownSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RepairOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartSource" AS ENUM ('INVENTORY', 'MARKETPLACE', 'WORKSHOP_SUPPLIED', 'OTHER');

-- CreateEnum
CREATE TYPE "MaintenanceCostCategory" AS ENUM ('PART', 'LABOUR', 'SERVICE', 'EXTERNAL_REPAIR', 'OTHER');

-- CreateTable
CREATE TABLE "maintenance_schedule" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "maintenance_type" "MaintenanceType" NOT NULL DEFAULT 'PREVENTIVE',
    "recurrence" "ScheduleRecurrence" NOT NULL DEFAULT 'RECURRING',
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "interval_days" INTEGER,
    "interval_hours" DECIMAL(10,2),
    "interval_kilometres" DECIMAL(12,2),
    "lead_days" INTEGER,
    "lead_hours" DECIMAL(10,2),
    "lead_kilometres" DECIMAL(12,2),
    "last_serviced_at" TIMESTAMP(3),
    "last_serviced_hour_meter" DECIMAL(12,2),
    "last_serviced_odometer" DECIMAL(12,2),
    "last_service_request_id" TEXT,
    "due_announced_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "maintenance_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "type" "MaintenanceType" NOT NULL,
    "status" "MaintenanceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "BreakdownSeverity",
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reported_at" TIMESTAMP(3) NOT NULL,
    "reported_by" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "out_of_service_at" TIMESTAMP(3),
    "returned_to_service_at" TIMESTAMP(3),
    "downtime_minutes" INTEGER,
    "started_at" TIMESTAMP(3),
    "started_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approval_notes" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancellation_reason" TEXT,
    "total_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_order" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "maintenance_request_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "workshop_organization_id" TEXT NOT NULL,
    "workshop_name" TEXT,
    "status" "RepairOrderStatus" NOT NULL DEFAULT 'OPEN',
    "work_summary" TEXT,
    "work_performed" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "started_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancellation_reason" TEXT,
    "parts_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "labour_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "other_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "total_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_usage" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repair_order_id" TEXT NOT NULL,
    "part_reference" TEXT,
    "part_name" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_cost_minor" BIGINT NOT NULL,
    "total_cost_minor" BIGINT NOT NULL,
    "source" "PartSource" NOT NULL DEFAULT 'WORKSHOP_SUPPLIED',
    "source_reference" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "part_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labor_entry" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repair_order_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "technician" TEXT,
    "hours" DECIMAL(8,2) NOT NULL,
    "hourly_rate_minor" BIGINT NOT NULL,
    "total_cost_minor" BIGINT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "labor_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_cost" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repair_order_id" TEXT NOT NULL,
    "maintenance_request_id" TEXT NOT NULL,
    "category" "MaintenanceCostCategory" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "description" TEXT,
    "part_usage_id" TEXT,
    "labor_entry_id" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "maintenance_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_ref" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT,
    "asset_type" TEXT,
    "asset_tag" TEXT,
    "status" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "source_event" TEXT NOT NULL,

    CONSTRAINT "asset_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_usage_meter" (
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "hour_meter" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "odometer" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "last_usage_record_id" TEXT,
    "last_period_end" TIMESTAMP(3),
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_usage_meter_pkey" PRIMARY KEY ("asset_id")
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
CREATE INDEX "maintenance_schedule_organization_id_status_asset_id_idx" ON "maintenance_schedule"("organization_id", "status", "asset_id");

-- CreateIndex
CREATE INDEX "maintenance_schedule_organization_id_asset_id_idx" ON "maintenance_schedule"("organization_id", "asset_id");

-- CreateIndex
CREATE INDEX "maintenance_request_organization_id_status_due_date_idx" ON "maintenance_request"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "maintenance_request_organization_id_asset_id_reported_at_idx" ON "maintenance_request"("organization_id", "asset_id", "reported_at" DESC);

-- CreateIndex
CREATE INDEX "maintenance_request_organization_id_reported_by_reported_at_idx" ON "maintenance_request"("organization_id", "reported_by", "reported_at" DESC);

-- CreateIndex
CREATE INDEX "repair_order_organization_id_status_idx" ON "repair_order"("organization_id", "status");

-- CreateIndex
CREATE INDEX "repair_order_organization_id_workshop_organization_id_statu_idx" ON "repair_order"("organization_id", "workshop_organization_id", "status");

-- CreateIndex
CREATE INDEX "repair_order_maintenance_request_id_idx" ON "repair_order"("maintenance_request_id");

-- CreateIndex
CREATE INDEX "part_usage_organization_id_repair_order_id_idx" ON "part_usage"("organization_id", "repair_order_id");

-- CreateIndex
CREATE INDEX "labor_entry_organization_id_repair_order_id_idx" ON "labor_entry"("organization_id", "repair_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_cost_part_usage_id_key" ON "maintenance_cost"("part_usage_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_cost_labor_entry_id_key" ON "maintenance_cost"("labor_entry_id");

-- CreateIndex
CREATE INDEX "maintenance_cost_organization_id_repair_order_id_idx" ON "maintenance_cost"("organization_id", "repair_order_id");

-- CreateIndex
CREATE INDEX "maintenance_cost_organization_id_maintenance_request_id_idx" ON "maintenance_cost"("organization_id", "maintenance_request_id");

-- CreateIndex
CREATE INDEX "asset_ref_organization_id_status_idx" ON "asset_ref"("organization_id", "status");

-- CreateIndex
CREATE INDEX "asset_usage_meter_organization_id_idx" ON "asset_usage_meter"("organization_id");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- AddForeignKey
ALTER TABLE "maintenance_request" ADD CONSTRAINT "maintenance_request_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order" ADD CONSTRAINT "repair_order_maintenance_request_id_fkey" FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_usage" ADD CONSTRAINT "part_usage_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labor_entry" ADD CONSTRAINT "labor_entry_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_cost" ADD CONSTRAINT "maintenance_cost_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_cost" ADD CONSTRAINT "maintenance_cost_maintenance_request_id_fkey" FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_cost" ADD CONSTRAINT "maintenance_cost_part_usage_id_fkey" FOREIGN KEY ("part_usage_id") REFERENCES "part_usage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_cost" ADD CONSTRAINT "maintenance_cost_labor_entry_id_fkey" FOREIGN KEY ("labor_entry_id") REFERENCES "labor_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Invariants Prisma cannot express
--
-- Partial unique indexes and CHECK constraints have no schema.prisma syntax, so
-- they live here, hand-written, at the end of the migration.
--
-- WARNING for whoever runs `prisma migrate dev` next: the generated diff will
-- propose DROPping every object below, because Prisma introspects the database,
-- does not find them in the schema, and concludes they are drift. They are not.
-- **Reject those hunks.** The schema file and the running database get these
-- objects from this very file — the generated diff simply cannot see why they
-- are wanted.
--
-- The names are mirrored in src/maintenance/*.ts, where the code that turns a
-- violation into a business error matches on them.
-- =============================================================================

-- One open request per machine, per kind of work.
--
-- The product document's duplicate-report control — "جلوگیری از ثبت درخواست
-- تکراری" (docs/17) — specified by docs/05 § 5.5 verbatim as
-- UNIQUE (asset_id, type) WHERE status IN ('OPEN','IN_PROGRESS').
--
-- Written exactly as specified, without organization_id. Asset ids are issued
-- by asset-service and are globally unique, so the tenant is implied by the
-- asset; adding the column would widen the index without narrowing what it
-- prevents. The application also checks first, but only to produce a readable
-- error: between reading "no open request" and writing one, a concurrent
-- request does exactly the same, and this index is what actually holds the line.
CREATE UNIQUE INDEX "ux_request_open_per_asset"
  ON "maintenance_request" ("asset_id", "type")
  WHERE "status" IN ('OPEN', 'IN_PROGRESS');

-- One live referral per request.
--
-- Re-referring a job after a workshop turns it down is legitimate; two
-- workshops holding the same job at once is not. Only the database can tell two
-- concurrent referrals apart.
CREATE UNIQUE INDEX "ux_repair_order_live_per_request"
  ON "repair_order" ("maintenance_request_id")
  WHERE "status" <> 'CANCELLED';

-- One live schedule per machine per title.
--
-- Well-formedness rather than business policy: two rows both called "تعویض
-- روغن موتور" on one grader make "when is the oil due" unanswerable.
CREATE UNIQUE INDEX "ux_schedule_live_per_asset_title"
  ON "maintenance_schedule" ("organization_id", "asset_id", "title")
  WHERE "status" <> 'ARCHIVED';

-- A schedule must be able to come due.
--
-- Checked in the DTO too, for a readable error. Here as well because a
-- corrective script or a future code path would bypass that check, and a
-- schedule with no interval is worse than no schedule: it looks like coverage.
ALTER TABLE "maintenance_schedule"
  ADD CONSTRAINT "ck_schedule_has_interval"
  CHECK (
    "interval_days" IS NOT NULL OR
    "interval_hours" IS NOT NULL OR
    "interval_kilometres" IS NOT NULL
  );

-- Intervals are positive and leads are not negative.
--
-- A zero or negative interval would put the next service in the past for ever;
-- a negative lead would warn after the deadline.
ALTER TABLE "maintenance_schedule"
  ADD CONSTRAINT "ck_schedule_intervals_positive"
  CHECK (
    ("interval_days" IS NULL OR "interval_days" > 0) AND
    ("interval_hours" IS NULL OR "interval_hours" > 0) AND
    ("interval_kilometres" IS NULL OR "interval_kilometres" > 0) AND
    ("lead_days" IS NULL OR "lead_days" >= 0) AND
    ("lead_hours" IS NULL OR "lead_hours" >= 0) AND
    ("lead_kilometres" IS NULL OR "lead_kilometres" >= 0)
  );

-- Meter anchors are never negative. A machine cannot have run backwards.
ALTER TABLE "maintenance_schedule"
  ADD CONSTRAINT "ck_schedule_anchors_non_negative"
  CHECK (
    ("last_serviced_hour_meter" IS NULL OR "last_serviced_hour_meter" >= 0) AND
    ("last_serviced_odometer" IS NULL OR "last_serviced_odometer" >= 0)
  );

-- A repair cannot finish before it started, and a machine cannot go back into
-- service before the repair finished.
--
-- Both sides of every comparison below are written by the application, never
-- defaulted by the database. That is deliberate and it is the lesson
-- fleet-service paid for: PostgreSQL runs in a WSL2 VM on the development
-- machine and measured 14–56 ms ahead of the host, so a row with one column
-- from now() and another from new Date() violated its own constraint for no
-- reason a reader could ever guess.
ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "ck_request_period"
  CHECK (
    ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at") AND
    ("returned_to_service_at" IS NULL OR "completed_at" IS NULL OR "returned_to_service_at" >= "completed_at")
  );

-- Downtime is never negative, and never recorded without the moment it is
-- measured from.
ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "ck_request_downtime"
  CHECK (
    "downtime_minutes" IS NULL OR
    ("downtime_minutes" >= 0 AND "out_of_service_at" IS NOT NULL)
  );

-- A corrective request records a failure, so it states how bad it was;
-- a preventive one describes planned work, where severity means nothing.
ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "ck_request_severity_matches_type"
  CHECK (
    ("type" = 'CORRECTIVE' AND "severity" IS NOT NULL) OR
    ("type" = 'PREVENTIVE' AND "severity" IS NULL)
  );

-- A terminal request says who ended it and why.
--
-- AGENTS.md S-06 asks every state change to record who did what and why, and
-- an approval with no approver is the one record in this domain that authorises
-- money to move.
ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "ck_request_terminal_attribution"
  CHECK (
    ("status" <> 'APPROVED' OR ("approved_at" IS NOT NULL AND "approved_by" IS NOT NULL)) AND
    ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL))
  );

-- A total is never negative.
ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "ck_request_total_non_negative"
  CHECK ("total_cost_minor" >= 0);

-- The same period rule for a repair order.
ALTER TABLE "repair_order"
  ADD CONSTRAINT "ck_repair_order_period"
  CHECK (
    ("started_at" IS NULL OR "started_at" >= "assigned_at") AND
    ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at")
  );

-- Category totals are non-negative and add up to the total.
--
-- The application recomputes all four from the cost lines in one transaction,
-- under a row lock. This constraint is what catches the day someone adds a
-- fifth category and forgets the sum — the failure mode where a repair order
-- and its own lines quietly disagree.
ALTER TABLE "repair_order"
  ADD CONSTRAINT "ck_repair_order_totals"
  CHECK (
    "parts_cost_minor" >= 0 AND
    "labour_cost_minor" >= 0 AND
    "other_cost_minor" >= 0 AND
    "total_cost_minor" = "parts_cost_minor" + "labour_cost_minor" + "other_cost_minor"
  );

-- A cancelled repair order says why.
ALTER TABLE "repair_order"
  ADD CONSTRAINT "ck_repair_order_cancellation"
  CHECK (
    "status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
  );

-- A part records a real quantity at a real price, and the line total is the
-- product of the two.
--
-- The total is stored rather than derived so the arithmetic that produced an
-- approved figure is fixed at the moment it was approved. Storing it means it
-- can disagree with its inputs, so the database checks it — with a tolerance of
-- one minor unit, because the application rounds the product half-up once and
-- rounding is exactly what this constraint must not fight.
ALTER TABLE "part_usage"
  ADD CONSTRAINT "ck_part_usage_amounts"
  CHECK (
    "quantity" > 0 AND
    "unit_cost_minor" >= 0 AND
    "total_cost_minor" >= 0 AND
    ABS("total_cost_minor" - ROUND("quantity" * "unit_cost_minor")) <= 1
  );

-- The same, for labour.
ALTER TABLE "labor_entry"
  ADD CONSTRAINT "ck_labor_entry_amounts"
  CHECK (
    "hours" > 0 AND
    "hourly_rate_minor" >= 0 AND
    "total_cost_minor" >= 0 AND
    ABS("total_cost_minor" - ROUND("hours" * "hourly_rate_minor")) <= 1
  );

-- Every cost line has provenance, and it is the provenance its category claims.
--
-- This is the constraint the economic seam rests on (ADR-028). A PART cost that
-- names no part, or a LABOUR cost that names no labour entry, would be an
-- amount economic-service could not audit — and the direct-entry route exists
-- precisely so that a cost with no work behind it has to say so by carrying
-- neither reference and a category that admits it.
ALTER TABLE "maintenance_cost"
  ADD CONSTRAINT "ck_cost_provenance"
  CHECK (
    "amount_minor" >= 0 AND
    NOT ("part_usage_id" IS NOT NULL AND "labor_entry_id" IS NOT NULL) AND
    ("category" <> 'PART' OR "part_usage_id" IS NOT NULL) AND
    ("category" <> 'LABOUR' OR "labor_entry_id" IS NOT NULL) AND
    ("category" IN ('PART', 'LABOUR') OR
      ("part_usage_id" IS NULL AND "labor_entry_id" IS NULL))
  );

-- The usage meter only ever holds non-negative readings.
--
-- The fold that maintains it takes GREATEST of the instrument and the running
-- total, so it cannot decrease; this makes that property enforceable rather
-- than merely intended.
ALTER TABLE "asset_usage_meter"
  ADD CONSTRAINT "ck_usage_meter_non_negative"
  CHECK ("hour_meter" >= 0 AND "odometer" >= 0 AND "record_count" >= 0);
