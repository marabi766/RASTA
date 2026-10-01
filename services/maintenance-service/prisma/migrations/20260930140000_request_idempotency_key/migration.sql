-- Idempotency-Key on POST /v1/maintenance-requests (#157, docs/06 § 6.8).
--
-- The gateway already forwards the header; until now the create path ignored
-- it, so a client retry after a lost response raised the work twice. One row
-- per (organization, endpoint, key): claimed IN_PROGRESS in its own committed
-- statement before the work runs, completed with the original 201 body, or
-- deleted when the work fails. `claim_token` is minted per claim, and
-- complete/release match on it, so a claim that expired and was re-taken can
-- neither finish nor free its successor's row. Kept for
-- MAINTENANCE_IDEMPOTENCY_TTL_HOURS (24 by default), then purged by age.
--
-- A new, empty table: nothing existing is read or rewritten.
SET LOCAL lock_timeout = '3s';

CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

CREATE TABLE "idempotency_key" (
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id", "endpoint", "key"),
    CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
    CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
    -- A completed row always carries the response it replays.
    CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
      "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
    )
);

-- The purge removes expired rows of every tenant by age alone.
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key" ("expires_at");
