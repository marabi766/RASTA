-- Validates `ck_payment_intent_creator_identity` (added NOT VALID by
-- 20261002100000_payment_intent_creator_identity). On its own, VALIDATE takes only SHARE UPDATE
-- EXCLUSIVE, which lets payment reads and writes through while it scans.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  VALIDATE CONSTRAINT "ck_payment_intent_creator_identity";
