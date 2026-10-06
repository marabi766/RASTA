-- Idempotency-Key on POST /v1/fleet/availability (EXP-002 slice 7, docs/06 § 6.8).
--
-- A declaration supersedes the machine's previous one, so a retried old request
-- (a lost response, a browser retry) can silently undo a newer declaration. One
-- row per (organization, endpoint, key): claimed IN_PROGRESS in its own committed
-- statement before the work runs, completed with the original response in the
-- work's own transaction, or deleted when the work fails. `claim_token` is minted
-- per claim, and the work and its completion match on it, so a claim that lapsed
-- and was re-taken can neither finish nor free its successor's row. Kept for
-- FLEET_IDEMPOTENCY_TTL_HOURS (24 by default), then purged by age.
--
-- The shape asset-service and maintenance-service use. A new, empty table:
-- nothing existing is read or rewritten. Timestamps are TIMESTAMPTZ: the store
-- compares `expires_at` with the clock in raw SQL, which must not depend on the
-- session's TimeZone.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "idempotency_key" (
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id", "endpoint", "key"),
    CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
    CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
    CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
    -- A completed row always carries the response it replays.
    CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
      "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
    )
);

-- The purge removes expired rows of every tenant by age alone.
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key" ("expires_at");

COMMIT;
