-- Intent shares the placement commit; delivery evidence lives as long as the order.
ALTER TABLE "order"
  ADD COLUMN saga_start_requested_at TIMESTAMP(3),
  ADD COLUMN saga_start_attempted_at TIMESTAMP(3),
  ADD COLUMN saga_start_delivered_at TIMESTAMP(3),
  ADD COLUMN saga_start_next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN saga_start_claim_token UUID,
  ADD COLUMN saga_start_claim_expires_at TIMESTAMP(3),
  ADD CONSTRAINT ck_order_saga_start_claim CHECK (
    (saga_start_claim_token IS NULL) = (saga_start_claim_expires_at IS NULL));
-- The scheduler walks this ordered, partial index, never OFFSET. Retried rows
-- move behind other due rows; old failures cannot starve the rest of the queue.
CREATE INDEX ix_order_saga_start_due ON "order" (saga_start_next_attempt_at, id)
  WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING');
