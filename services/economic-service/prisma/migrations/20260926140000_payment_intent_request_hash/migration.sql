-- The request a payment intent was created for (Codex round 3 on #121, H2).
--
-- A same-key top-up retry resumes the intent the first attempt left, and the
-- API's idempotency record is gone by then (a failed attempt releases it). So
-- the intent keeps the SHA-256 of its own canonical request — wallet, amount,
-- currency, instrument — and a retry that differs in any of them is refused
-- instead of resuming someone else's capture.
--
-- Populated databases: a nullable column with no default, so the ALTER is a
-- catalogue change and every existing row stays valid. Existing rows keep
-- NULL: their request was never recorded, and an intent without one is never
-- resumed. The CHECK only admits a lowercase hex SHA-256, and NULL.
--
-- The CHECK is added NOT VALID (Codex round 4 on #121). A plain ADD CONSTRAINT
-- scans every row while holding the ACCESS EXCLUSIVE lock this ALTER takes,
-- which blocks every payment read and write for as long as the scan lasts.
-- NOT VALID is catalogue-only; new and updated rows are checked from here on.
-- Validating is the next migration, 20260926140100, on purpose: prisma migrate
-- deploy runs one file as one transaction, so a VALIDATE in this file would
-- still scan under this file's ACCESS EXCLUSIVE lock. On its own it takes only
-- SHARE UPDATE EXCLUSIVE, which lets reads and writes through.
--
-- Edited in place, before it reached any deployed environment: a database
-- that already applied the earlier text (CI and local test databases only)
-- has a different checksum on record for it; reset such a database rather
-- than migrating it.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  ADD COLUMN IF NOT EXISTS "request_hash" TEXT;

ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_request_hash"
  CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$')
  NOT VALID;
