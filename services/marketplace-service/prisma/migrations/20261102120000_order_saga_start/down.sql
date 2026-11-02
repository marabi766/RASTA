DROP INDEX ix_order_saga_start_due;
ALTER TABLE "order" DROP CONSTRAINT ck_order_saga_start_claim,
  DROP COLUMN saga_start_requested_at, DROP COLUMN saga_start_attempted_at,
  DROP COLUMN saga_start_delivered_at, DROP COLUMN saga_start_next_attempt_at,
  DROP COLUMN saga_start_claim_token, DROP COLUMN saga_start_claim_expires_at;
