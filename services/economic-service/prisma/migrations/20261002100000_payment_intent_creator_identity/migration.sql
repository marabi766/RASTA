-- Who created a payment intent, as a STABLE identity (ADR-064 § 6; Codex
-- round 2 on #175, HIGH).
--
-- `created_by` holds the creator's platform user id. One person can carry
-- two of those — the auth guard falls back to the IdP subject when a token
-- has no `rasta_uid`, and a later token may carry another — so separation of
-- duties on the operator path cannot rest on it alone. The token's issuer and
-- subject are recorded beside it, for every intent created from here on.
--
-- Populated databases: two nullable columns with no default — a catalogue
-- change; every existing row stays valid with NULLs. An intent without a
-- recorded creator identity is never approved on the operator path: it fails
-- closed with CREATOR_IDENTITY_UNKNOWN (docs/runbooks/payment-refund-stuck.md).
--
-- Both or neither, and never blank. Added NOT VALID — catalogue-only under
-- this file's lock — and validated by the next migration, under SHARE UPDATE
-- EXCLUSIVE only (the 20260926140000/140100 pattern).
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  ADD COLUMN IF NOT EXISTS "created_by_issuer" TEXT,
  ADD COLUMN IF NOT EXISTS "created_by_subject" TEXT;

ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_creator_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL OR btrim("created_by_issuer") <> '')
         AND ("created_by_subject" IS NULL OR btrim("created_by_subject") <> ''))
  NOT VALID;
