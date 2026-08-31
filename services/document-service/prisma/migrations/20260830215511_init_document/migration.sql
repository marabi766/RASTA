-- CreateEnum
CREATE TYPE "DocumentClass" AS ENUM ('CONTRACT', 'INSURANCE_POLICY', 'TENDER_DOCUMENT', 'STATEMENT', 'SUPPLIER_CREDENTIAL', 'INSPECTION_REPORT', 'DAMAGE_PHOTO', 'PROGRESS_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('REGISTERED', 'DELETED');

-- CreateEnum
CREATE TYPE "ScanState" AS ENUM ('PENDING', 'NOT_SCANNED', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "UploadIntentState" AS ENUM ('ISSUED', 'CONSUMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "upload_intent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_class" "DocumentClass" NOT NULL,
    "declared_content_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "declared_filename" TEXT NOT NULL,
    "state" "UploadIntentState" NOT NULL DEFAULT 'ISSUED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "consumed_document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "upload_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_class" "DocumentClass" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'REGISTERED',
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "checksum" TEXT,
    "scan_state" "ScanState" NOT NULL DEFAULT 'PENDING',
    "scan_engine" TEXT,
    "scan_version" TEXT,
    "scan_signature" TEXT,
    "scanned_at" TIMESTAMP(3),
    "owner_resource_type" TEXT,
    "owner_resource_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "deletion_reason" TEXT,
    "upload_intent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grant" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "upload_intent_object_key_key" ON "upload_intent"("object_key");

-- CreateIndex
CREATE INDEX "ix_upload_intent_org_state" ON "upload_intent"("organization_id", "state");

-- CreateIndex
CREATE INDEX "ix_upload_intent_expiry" ON "upload_intent"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_object_key_key" ON "document"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_upload_intent_id_key" ON "document"("upload_intent_id");

-- CreateIndex
CREATE INDEX "ix_document_org_status" ON "document"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_document_org_class" ON "document"("organization_id", "document_class");

-- CreateIndex
CREATE INDEX "ix_document_owner_resource" ON "document"("owner_resource_type", "owner_resource_id");

-- CreateIndex
CREATE INDEX "ix_grant_org_subject" ON "access_grant"("organization_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_grant_document_subject" ON "access_grant"("document_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Invariants the database enforces itself.
--
-- Every rule below is one the domain also enforces. They are repeated here
-- because a CHECK constraint holds against a repair script, a future code path
-- and a mistaken migration, none of which go through the domain service — and
-- a document whose row says "deleted" with no deleter is an audit gap that
-- cannot be reconstructed later.
-- ===========================================================================

-- An upload intent must expire after it was created. A row that expired before
-- it existed could only come from a clock error or a hand-written insert, and
-- it would be redeemable forever or never depending on which way the skew ran.
ALTER TABLE "upload_intent"
  ADD CONSTRAINT "ck_upload_intent_expiry"
  CHECK ("expires_at" > "created_at");

-- A declared size must be positive. Zero would mean permission to upload an
-- empty object, which the finalize step refuses anyway.
ALTER TABLE "upload_intent"
  ADD CONSTRAINT "ck_upload_intent_size_positive"
  CHECK ("declared_size_bytes" > 0);

-- A consumed intent names when and what it produced; an unconsumed one names
-- neither. Without this, a replay check that reads `consumed_at` could pass
-- while `consumed_document_id` was never written.
ALTER TABLE "upload_intent"
  ADD CONSTRAINT "ck_upload_intent_consumed_complete"
  CHECK (
    ("state" <> 'CONSUMED' AND "consumed_at" IS NULL AND "consumed_document_id" IS NULL)
    OR ("state" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "consumed_document_id" IS NOT NULL)
  );

-- A registered document has real bytes behind it. An object of length zero is
-- not a document, and the empty-file refusal exists at three layers precisely
-- because an empty PDF passes a naive extension check.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_size_positive"
  CHECK ("size_bytes" > 0);

-- Deletion is a tombstone, and a tombstone with no actor, time or reason is
-- not an audit record. This is what makes "do not silently erase audit
-- evidence" true of the row rather than only of the code path.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_deleted_has_actor"
  CHECK (
    "status" <> 'DELETED'
    OR ("deleted_at" IS NOT NULL AND "deleted_by" IS NOT NULL AND "deletion_reason" IS NOT NULL)
  );

-- A scan that reached a verdict says which engine reached it. `PENDING` is the
-- only state allowed to have no engine — anything else is a claim about
-- provenance that nobody can check.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_scan_attributable"
  CHECK (
    "scan_state" = 'PENDING'
    OR ("scan_engine" IS NOT NULL AND "scanned_at" IS NOT NULL)
  );

-- Only an infection carries a signature. A signature on a clean document would
-- be a contradiction that a consumer filtering on it would act upon.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_signature_only_when_infected"
  CHECK ("scan_signature" IS NULL OR "scan_state" = 'INFECTED');

-- An owner reference is both parts or neither. A dangling type with no id
-- names nothing, and an id with no type cannot be resolved by the service that
-- owns it.
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_owner_reference_complete"
  CHECK (
    ("owner_resource_type" IS NULL AND "owner_resource_id" IS NULL)
    OR ("owner_resource_type" IS NOT NULL AND "owner_resource_id" IS NOT NULL)
  );

-- A grant names a subject kind this service understands. `ROLE` and `USER` are
-- the two the platform's tokens carry; anything else would be a grant nobody
-- evaluates.
ALTER TABLE "access_grant"
  ADD CONSTRAINT "ck_grant_subject_type"
  CHECK ("subject_type" IN ('USER', 'ROLE'));

-- A revoked grant records who revoked it, for the same reason a deleted
-- document does.
ALTER TABLE "access_grant"
  ADD CONSTRAINT "ck_grant_revoked_has_actor"
  CHECK (
    ("revoked_at" IS NULL AND "revoked_by" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
  );
