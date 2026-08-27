-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('GRADER', 'LOADER', 'EXCAVATOR', 'BULLDOZER', 'TRUCK', 'LIGHT_TRUCK', 'TRACTOR', 'WATER_TANKER', 'WASTE_COLLECTOR', 'EMERGENCY_VEHICLE', 'PASSENGER_VEHICLE', 'FIXED_EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "OperationalStatus" AS ENUM ('REGISTERED', 'ACTIVE', 'ASSIGNED', 'IDLE', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('MANUAL', 'TELEMATICS', 'IMPORTED');

-- CreateEnum
CREATE TYPE "AssetDocumentKind" AS ENUM ('OWNERSHIP_TITLE', 'REGISTRATION_CARD', 'INSURANCE_POLICY', 'TECHNICAL_INSPECTION', 'PURCHASE_INVOICE', 'MANUAL', 'PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "InsuranceCoverage" AS ENUM ('THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASSED', 'CONDITIONAL', 'FAILED');

-- CreateEnum
CREATE TYPE "TimelineCategory" AS ENUM ('LIFECYCLE', 'USAGE', 'MAINTENANCE', 'INSURANCE', 'INSPECTION', 'DOCUMENT', 'COST', 'PROJECT', 'TRANSFER');

-- CreateTable
CREATE TABLE "asset" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_tag" TEXT,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "manufacture_year" INTEGER,
    "status" "OperationalStatus" NOT NULL DEFAULT 'REGISTERED',
    "commissioned_at" TIMESTAMP(3),
    "decommissioned_at" TIMESTAMP(3),
    "decommissioned_reason" TEXT,
    "specifications" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_transfer" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "from_organization_id" TEXT NOT NULL,
    "to_organization_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reference_no" TEXT,
    "transferred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transferred_by" TEXT NOT NULL,

    CONSTRAINT "asset_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_location" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "point" geography(Point, 4326),
    "address_line" TEXT,
    "site_name" TEXT,
    "source" "LocationSource" NOT NULL DEFAULT 'MANUAL',
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "asset_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_document_ref" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "kind" "AssetDocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "asset_document_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policy" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_number" TEXT NOT NULL,
    "insurer_name" TEXT NOT NULL,
    "coverage" "InsuranceCoverage" NOT NULL,
    "premium_minor" BIGINT,
    "insured_value_minor" BIGINT,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "insurance_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claim" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "claim_number" TEXT,
    "description" TEXT NOT NULL,
    "incident_at" TIMESTAMP(3) NOT NULL,
    "claimed_amount_minor" BIGINT,
    "approved_amount_minor" BIGINT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "insurance_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technical_inspection" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "certificate_no" TEXT NOT NULL,
    "center_name" TEXT,
    "inspected_at" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "result" "InspectionResult" NOT NULL,
    "notes" TEXT,
    "document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "technical_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_timeline_entry" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "source_service" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "category" "TimelineCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount_minor" BIGINT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_timeline_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_ref" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "source_event" TEXT NOT NULL,

    CONSTRAINT "organization_ref_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id","endpoint","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_serial_number_key" ON "asset"("serial_number");

-- CreateIndex
CREATE INDEX "asset_organization_id_status_idx" ON "asset"("organization_id", "status");

-- CreateIndex
CREATE INDEX "asset_organization_id_type_idx" ON "asset"("organization_id", "type");

-- CreateIndex
CREATE INDEX "asset_status_idx" ON "asset"("status");

-- CreateIndex
CREATE UNIQUE INDEX "asset_organization_id_asset_tag_deleted_at_key" ON "asset"("organization_id", "asset_tag", "deleted_at");

-- CreateIndex
CREATE INDEX "asset_transfer_asset_id_transferred_at_idx" ON "asset_transfer"("asset_id", "transferred_at");

-- CreateIndex
CREATE INDEX "asset_transfer_organization_id_idx" ON "asset_transfer"("organization_id");

-- CreateIndex
CREATE INDEX "asset_location_asset_id_recorded_at_idx" ON "asset_location"("asset_id", "recorded_at");

-- CreateIndex
CREATE INDEX "asset_location_organization_id_idx" ON "asset_location"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_location_asset_id_is_current_key" ON "asset_location"("asset_id", "is_current");

-- CreateIndex
CREATE INDEX "asset_document_ref_asset_id_kind_idx" ON "asset_document_ref"("asset_id", "kind");

-- CreateIndex
CREATE INDEX "asset_document_ref_organization_id_idx" ON "asset_document_ref"("organization_id");

-- CreateIndex
CREATE INDEX "asset_document_ref_expires_at_idx" ON "asset_document_ref"("expires_at");

-- CreateIndex
CREATE INDEX "insurance_policy_valid_to_status_idx" ON "insurance_policy"("valid_to", "status");

-- CreateIndex
CREATE INDEX "insurance_policy_asset_id_status_idx" ON "insurance_policy"("asset_id", "status");

-- CreateIndex
CREATE INDEX "insurance_policy_organization_id_status_idx" ON "insurance_policy"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_policy_policy_number_insurer_name_deleted_at_key" ON "insurance_policy"("policy_number", "insurer_name", "deleted_at");

-- CreateIndex
CREATE INDEX "insurance_claim_policy_id_idx" ON "insurance_claim"("policy_id");

-- CreateIndex
CREATE INDEX "insurance_claim_organization_id_status_idx" ON "insurance_claim"("organization_id", "status");

-- CreateIndex
CREATE INDEX "technical_inspection_valid_to_idx" ON "technical_inspection"("valid_to");

-- CreateIndex
CREATE INDEX "technical_inspection_asset_id_inspected_at_idx" ON "technical_inspection"("asset_id", "inspected_at");

-- CreateIndex
CREATE INDEX "technical_inspection_organization_id_idx" ON "technical_inspection"("organization_id");

-- CreateIndex
CREATE INDEX "asset_timeline_entry_asset_id_occurred_at_idx" ON "asset_timeline_entry"("asset_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "asset_timeline_entry_organization_id_occurred_at_idx" ON "asset_timeline_entry"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "asset_timeline_entry_category_idx" ON "asset_timeline_entry"("category");

-- CreateIndex
CREATE UNIQUE INDEX "asset_timeline_entry_source_event_id_asset_id_key" ON "asset_timeline_entry"("source_event_id", "asset_id");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_location" ADD CONSTRAINT "asset_location_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_document_ref" ADD CONSTRAINT "asset_document_ref_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policy" ADD CONSTRAINT "insurance_policy_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technical_inspection" ADD CONSTRAINT "technical_inspection_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_timeline_entry" ADD CONSTRAINT "asset_timeline_entry_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
