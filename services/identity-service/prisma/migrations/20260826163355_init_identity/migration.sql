-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ScopeLevel" AS ENUM ('PLATFORM', 'ORGANIZATION', 'SUPPLIER', 'PROVINCE');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "keycloak_id" TEXT,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "active_organization_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "roles" TEXT[],
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope_level" "ScopeLevel" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_name" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_name","permission_id")
);

-- CreateTable
CREATE TABLE "registration_request" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "requested_organization_id" TEXT NOT NULL,
    "requested_roles" TEXT[],
    "justification" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "document_refs" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_request_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "user_keycloak_id_key" ON "user"("keycloak_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_status_idx" ON "user"("status");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user"("email");

-- CreateIndex
CREATE INDEX "membership_organization_id_status_idx" ON "membership"("organization_id", "status");

-- CreateIndex
CREATE INDEX "membership_user_id_status_idx" ON "membership"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "membership_user_id_organization_id_deleted_at_key" ON "membership"("user_id", "organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "permission_resource_idx" ON "permission"("resource");

-- CreateIndex
CREATE UNIQUE INDEX "permission_resource_action_key" ON "permission"("resource", "action");

-- CreateIndex
CREATE INDEX "registration_request_status_created_at_idx" ON "registration_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "registration_request_requested_organization_id_status_idx" ON "registration_request"("requested_organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_name_fkey" FOREIGN KEY ("role_name") REFERENCES "role"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_request" ADD CONSTRAINT "registration_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
