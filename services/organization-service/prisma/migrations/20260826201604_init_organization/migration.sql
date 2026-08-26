-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('DEHYARI', 'MUNICIPALITY', 'UNION', 'COOPERATIVE', 'COMPANY', 'GOVERNMENT', 'PRIVATE', 'NATIONAL_ORGANIZATION');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('PRIMARY', 'WAREHOUSE', 'BRANCH', 'SITE');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('ADMINISTRATIVE', 'FINANCIAL', 'TECHNICAL', 'EMERGENCY');

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "external_code" TEXT,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "type" "OrganizationType" NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "parent_id" TEXT,
    "path" ltree,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_location" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL DEFAULT 'PRIMARY',
    "address_line" TEXT,
    "city" TEXT,
    "county" TEXT,
    "province" TEXT,
    "postal_code" TEXT,
    "point" geography(Point, 4326),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_policy" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "inheritable" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "organization_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_contact" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_contact_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "organization_external_code_key" ON "organization"("external_code");

-- CreateIndex
CREATE INDEX "organization_parent_id_idx" ON "organization"("parent_id");

-- CreateIndex
CREATE INDEX "organization_type_status_idx" ON "organization"("type", "status");

-- CreateIndex
CREATE INDEX "organization_status_idx" ON "organization"("status");

-- CreateIndex
CREATE INDEX "organization_location_organization_id_idx" ON "organization_location"("organization_id");

-- CreateIndex
CREATE INDEX "organization_policy_organization_id_key_idx" ON "organization_policy"("organization_id", "key");

-- CreateIndex
CREATE INDEX "organization_policy_key_idx" ON "organization_policy"("key");

-- CreateIndex
CREATE UNIQUE INDEX "organization_policy_organization_id_key_effective_from_key" ON "organization_policy"("organization_id", "key", "effective_from");

-- CreateIndex
CREATE INDEX "organization_contact_organization_id_idx" ON "organization_contact"("organization_id");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_location" ADD CONSTRAINT "organization_location_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_policy" ADD CONSTRAINT "organization_policy_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_contact" ADD CONSTRAINT "organization_contact_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
