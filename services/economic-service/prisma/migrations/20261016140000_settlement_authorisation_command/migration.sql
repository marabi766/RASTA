-- Which service command authorised a transaction for settlement (Codex on
-- #287 round 4, finding 2; docs/23 D-053).
--
-- `settlement_authorised_by` names a person, or `economic-service` for every
-- service caller alike, so it cannot say which service asked. The order saga
-- needs exactly that: its authorisation commits, its answer and its own record
-- are lost, someone disputes the transaction here, and its retry arrives after
-- the stored answer has expired. The retry is refused for the state, and
-- DISPUTED alone proves nothing — a dispute starts from HELD too. These two
-- columns are the durable proof that the saga's own command took effect:
--
-- `settlement_authorised_service`: the calling service of a service-token
-- authorisation (the signed claim, never a header). NULL for a person.
-- `settlement_authorisation_key`: that command's Idempotency-Key. NULL for a
-- person: their key belongs to their client and is not shown to the payee.
--
-- Populated databases: two nullable columns with no default — a catalogue
-- change under a brief ACCESS EXCLUSIVE lock, no rewrite, every existing row
-- valid with NULLs. A transaction authorised before this has no proof, and a
-- saga retry that finds it disputed is refused as before.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  ADD COLUMN IF NOT EXISTS "settlement_authorised_service" TEXT,
  ADD COLUMN IF NOT EXISTS "settlement_authorisation_key" TEXT;
