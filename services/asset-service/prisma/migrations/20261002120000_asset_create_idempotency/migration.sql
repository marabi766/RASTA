-- Idempotency-Key on POST /v1/assets (#169, docs/06 § 6.8).
--
-- `idempotency_key` has existed since the initial schema and no code has ever
-- written it: a registration submitted twice (lost response, retry) created two
-- assets. This migration readies it for the create path's claim store, the
-- shape maintenance-service uses (#171, #187):
--
--   * `claim_token` — minted per claim. The create's transaction locks the row
--     by it before inserting the asset and stores the response on it, so a
--     claim that lapsed and was re-taken by a retry commits nothing.
--   * `state` closed to IN_PROGRESS / COMPLETED, and a completed row always
--     carries the response it replays.
--   * timestamps in TIMESTAMPTZ: the store compares `expires_at` with the
--     clock in raw SQL, which must not depend on the session's TimeZone. The
--     stored values are UTC (Prisma writes UTC), so the conversion keeps them.
--
-- The primary key already leads with organization_id. Rows a previous release
-- could have left cannot exist (nothing wrote the table); were there any, each
-- receives a fresh token, and a state outside the two stops the migration at
-- the CHECK rather than being guessed at.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  ADD COLUMN "claim_token" TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';

UPDATE "idempotency_key" SET "claim_token" = gen_random_uuid()::text WHERE "claim_token" IS NULL;

ALTER TABLE "idempotency_key"
  ALTER COLUMN "claim_token" SET NOT NULL,
  ADD CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
  ADD CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
  ADD CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
  ADD CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
    "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  );

COMMIT;
