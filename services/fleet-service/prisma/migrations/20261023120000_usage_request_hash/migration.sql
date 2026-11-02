-- The request a usage record's `client_reference` is bound to (ADR-073 plan,
-- PR 1 "fleet A").
--
-- Until now a submission whose reference was already taken got the stored
-- record back whatever it carried: a resend with another body was told its new
-- reading was saved, and any user of the organization could read a colleague's
-- record by sending its reference. `request_hash` is SHA-256 over the caller
-- and the canonical body of the request that created the row; a resubmission
-- replays the row only when its own hash is equal, and is refused with
-- `409 IDEMPOTENCY_KEY_REUSED` otherwise.
--
-- Nullable, with no backfill: an existing row's caller and body were never
-- stored, so no hash can be reconstructed for it. A row left NULL replays only
-- to the user in its `recorded_by` sending a request whose fields equal its
-- columns one by one; a row a service recorded, or any other request, is
-- refused like any other mismatch.
-- Adding a nullable column with no default is a catalogue change only (no
-- table rewrite).
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "usage_record" ADD COLUMN "request_hash" TEXT;

COMMIT;
