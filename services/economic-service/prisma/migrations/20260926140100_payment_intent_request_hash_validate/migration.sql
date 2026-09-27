-- Validates ck_payment_intent_request_hash, which 20260926140000 added NOT
-- VALID (Codex round 4 on #121).
--
-- A file of its own, so its transaction holds only the SHARE UPDATE EXCLUSIVE
-- lock VALIDATE CONSTRAINT takes: the scan runs while payments are still read
-- and written. Every existing row passes: the column was added NULL, and
-- every row written since was checked by the constraint on write.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  VALIDATE CONSTRAINT "ck_payment_intent_request_hash";
