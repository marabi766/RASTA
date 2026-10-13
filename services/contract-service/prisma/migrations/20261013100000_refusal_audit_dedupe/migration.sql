-- =============================================================================
-- contract-service — durable de-duplication of refusal audit events (#243 round 2).
--
-- A contract-service refusal is not terminal (docs/06 § 6.8): its idempotency claim is released
-- so a request that could succeed on retry can. The audit of the refusal must still not repeat
-- when the same request is refused again for the same reason. `refusal_audit_dedupe` holds one
-- row per (tenant, user, idempotency key, request hash, reason), inserted in the same transaction
-- as the refusal's event: a repeat finds the row and writes no event; a different reason is a
-- different row and a new event. Rows expire with the idempotency retention and are purged by
-- the same upkeep timer.
-- =============================================================================

-- CreateTable
CREATE TABLE "refusal_audit_dedupe" (
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refusal_audit_dedupe_pkey" PRIMARY KEY ("organization_id", "user_id", "key", "request_hash", "reason")
);

-- CreateIndex
CREATE INDEX "refusal_audit_dedupe_expires_at_idx" ON "refusal_audit_dedupe"("expires_at");

ALTER TABLE "refusal_audit_dedupe"
  ADD CONSTRAINT "ck_refusal_audit_dedupe_not_blank" CHECK (
    length(btrim("user_id")) > 0 AND length(btrim("key")) > 0 AND length(btrim("reason")) > 0
  );
