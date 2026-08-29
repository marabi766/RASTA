-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION', 'RECEIPT_CONFIRMED', 'SETTLING', 'COMPLETED', 'DISPUTED', 'CANCELLING', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('GOOD', 'SERVICE');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESOLVED_SETTLE', 'RESOLVED_REFUND');

-- CreateEnum
CREATE TYPE "OrderHistoryKind" AS ENUM ('TRANSITION', 'REMINDER');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL DEFAULT 'GOOD',
    "unit" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "search_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "available_quantity" INTEGER NOT NULL,
    "lead_time_days" INTEGER NOT NULL,
    "minimum_quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_price_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" TEXT NOT NULL,

    CONSTRAINT "offer_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_organization_id" TEXT NOT NULL,
    "placed_by" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "total_amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "economic_transaction_id" TEXT,
    "economic_settlement_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "reminder_count" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),
    "receipt_confirmed_at" TIMESTAMP(3),
    "receipt_confirmed_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "offer_version" INTEGER NOT NULL,
    "product_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "tracking_reference" TEXT,
    "note" TEXT,
    "fulfilled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilled_by" TEXT NOT NULL,
    "fulfilled_by_organization_id" TEXT NOT NULL,

    CONSTRAINT "fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "kind" "OrderHistoryKind" NOT NULL DEFAULT 'TRANSITION',
    "from_status" "OrderStatus" NOT NULL,
    "to_status" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_dispute" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by" TEXT NOT NULL,
    "resolution" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "order_dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "supplier_organization_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" TEXT NOT NULL,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id")
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
    "state" "IdempotencyState" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id","endpoint","key")
);

-- CreateIndex
CREATE INDEX "ix_product_org_status" ON "product"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_product_category" ON "product"("category");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_org_sku" ON "product"("organization_id", "sku");

-- CreateIndex
CREATE INDEX "ix_offer_org_status" ON "offer"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_offer_product_status" ON "offer"("product_id", "status");

-- CreateIndex
CREATE INDEX "ix_offer_status_price" ON "offer"("status", "unit_price_minor");

-- CreateIndex
CREATE INDEX "ix_offer_price_org" ON "offer_price_history"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_offer_price_version" ON "offer_price_history"("offer_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "order_economic_transaction_id_key" ON "order"("economic_transaction_id");

-- CreateIndex
CREATE INDEX "ix_order_org_status" ON "order"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_order_supplier_status" ON "order"("supplier_organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_order_org_created" ON "order"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_order_line_org" ON "order_line"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_line_offer" ON "order_line"("order_id", "offer_id");

-- CreateIndex
CREATE INDEX "ix_fulfillment_order" ON "fulfillment"("order_id");

-- CreateIndex
CREATE INDEX "ix_fulfillment_org" ON "fulfillment"("organization_id");

-- CreateIndex
CREATE INDEX "ix_order_history_order" ON "order_status_history"("order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_order_history_org" ON "order_status_history"("organization_id");

-- CreateIndex
CREATE INDEX "ix_dispute_order" ON "order_dispute"("order_id");

-- CreateIndex
CREATE INDEX "ix_dispute_org_status" ON "order_dispute"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_order_id_key" ON "review"("order_id");

-- CreateIndex
CREATE INDEX "ix_review_supplier" ON "review"("supplier_organization_id");

-- CreateIndex
CREATE INDEX "ix_review_org" ON "review"("organization_id");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_price_history" ADD CONSTRAINT "offer_price_history_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment" ADD CONSTRAINT "fulfillment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_dispute" ADD CONSTRAINT "order_dispute_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants the database enforces, not the code
--
-- Every rule below is one a service bug could otherwise violate silently. A
-- CHECK is cheap and cannot be forgotten by a new code path; a rule that lives
-- only in TypeScript is a rule one refactor away from being gone.
-- ---------------------------------------------------------------------------

-- Money is positive. A zero-value order would create a zero-value obligation,
-- and economic-service refuses a journal with no amount.
ALTER TABLE "offer"
  ADD CONSTRAINT "ck_offer_price_positive" CHECK ("unit_price_minor" > 0);
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_total_positive" CHECK ("total_amount_minor" > 0);
ALTER TABLE "order_line"
  ADD CONSTRAINT "ck_order_line_price_positive" CHECK ("unit_price_minor" > 0);
ALTER TABLE "order_line"
  ADD CONSTRAINT "ck_order_line_total_positive" CHECK ("line_total_minor" > 0);

-- The line total is the product of its own two factors. Without this, a bug
-- in pricing produces an order whose total does not equal its lines and
-- nobody notices until an auditor adds them up.
ALTER TABLE "order_line"
  ADD CONSTRAINT "ck_order_line_total_consistent"
  CHECK ("line_total_minor" = "unit_price_minor" * "quantity");

-- Quantities. `available_quantity` reaching zero is normal; going below it is
-- overselling, which is what the row lock in placeOrder exists to prevent —
-- this is the second line of defence that makes the claim provable.
ALTER TABLE "offer"
  ADD CONSTRAINT "ck_offer_available_non_negative" CHECK ("available_quantity" >= 0);
ALTER TABLE "offer"
  ADD CONSTRAINT "ck_offer_minimum_positive" CHECK ("minimum_quantity" > 0);
ALTER TABLE "offer"
  ADD CONSTRAINT "ck_offer_lead_time_non_negative" CHECK ("lead_time_days" >= 0);
ALTER TABLE "order_line"
  ADD CONSTRAINT "ck_order_line_quantity_positive" CHECK ("quantity" > 0);

-- A review is a score out of five in the product document, and a rating
-- outside that range is not a smaller problem than a missing one.
ALTER TABLE "review"
  ADD CONSTRAINT "ck_review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- An order's two parties must be different organizations. Selling to yourself
-- would create an economic transaction whose payer and payee are the same
-- wallet, which is a journal that balances by doing nothing.
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_parties_distinct"
  CHECK ("organization_id" <> "supplier_organization_id");

-- A terminal order carries the evidence of how it ended (ADR-038 § 4).
--
-- Not merely tidiness: `completed_at` is what an operator uses to tell an
-- order that finished from one whose saga stopped halfway, and an order that
-- claims COMPLETED without a settlement id cannot be reconciled against the
-- ledger at all.
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_completed_has_settlement"
  CHECK ("status" <> 'COMPLETED' OR ("completed_at" IS NOT NULL AND "economic_settlement_id" IS NOT NULL));

ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_cancelled_has_reason"
  CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL));

ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_failed_has_reason"
  CHECK ("status" <> 'FAILED' OR "failure_reason" IS NOT NULL);

-- Settlement cannot be reached without a recorded confirmation.
--
-- The state machine already refuses the transition; this says the same thing
-- about the resulting row, so a direct write — a repair script, a future code
-- path — cannot produce an order that settled without anyone confirming
-- receipt. It is the single most consequential rule in this service.
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_settled_after_receipt"
  CHECK (
    "status" NOT IN ('SETTLING', 'COMPLETED')
    OR ("receipt_confirmed_at" IS NOT NULL AND "receipt_confirmed_by" IS NOT NULL)
  );

-- Money is only held once there is an obligation to hold it against.
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_held_has_transaction"
  CHECK (
    "status" IN ('PENDING', 'FAILED')
    OR "economic_transaction_id" IS NOT NULL
  );

-- A reminder is not a transition (ADR-043). Recording one as a state change
-- would claim something happened that did not.
ALTER TABLE "order_status_history"
  ADD CONSTRAINT "ck_history_reminder_is_not_a_transition"
  CHECK (
    ("kind" = 'REMINDER' AND "from_status" = "to_status")
    OR ("kind" = 'TRANSITION' AND "from_status" <> "to_status")
  );

-- A published offer has a publication time; an unpublished one has none.
ALTER TABLE "offer"
  ADD CONSTRAINT "ck_offer_published_has_timestamp"
  CHECK (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL));

-- A resolved dispute records who resolved it and how (S-06).
ALTER TABLE "order_dispute"
  ADD CONSTRAINT "ck_dispute_resolution_complete"
  CHECK (
    "status" = 'OPEN'
    OR ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL AND "resolution" IS NOT NULL)
  );

-- An idempotency record must expire after it was created, or the window is
-- meaningless and every key is instantly stale.
ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_expiry" CHECK ("expires_at" > "created_at");

-- ---------------------------------------------------------------------------
-- Partial unique indexes
-- ---------------------------------------------------------------------------

-- One open dispute per order. A second concurrent RaiseDispute is refused by
-- the database rather than by a check two requests can both pass.
CREATE UNIQUE INDEX "uq_dispute_one_open_per_order"
  ON "order_dispute" ("order_id")
  WHERE "status" = 'OPEN';

-- ---------------------------------------------------------------------------
-- Search (ADR-042)
--
-- pg_trgm is installed into template1 by the platform's bootstrap script, so
-- CREATE EXTENSION here is a no-op on a provisioned cluster and a safety net
-- on one that was not.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "ix_product_search" ON "product" USING gin ("search_text" gin_trgm_ops);
