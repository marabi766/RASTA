-- Per-claim token on idempotency_key (follows construction-service's shape).
--
-- complete() and release() used to match a row by (organization, endpoint, key)
-- alone. A claim that expired, was purged and was re-taken by another request
-- could then have its successor's row completed or released by the original
-- owner. The token is minted at claim and required by both; a mismatch is a
-- logged no-op.
--
-- Nullable: rows written before this live at most the retention window and are
-- never matched by a token (they simply expire), and old instances still
-- inserting without a token during a rolling deploy keep working. Metadata-only
-- change, no table rewrite.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key" ADD COLUMN "claim_token" TEXT;

ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_claim_token_not_blank"
  CHECK ("claim_token" IS NULL OR length(btrim("claim_token")) > 0);
