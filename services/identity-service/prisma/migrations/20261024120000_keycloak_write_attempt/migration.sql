-- The durable in-flight fence of every Keycloak write (ADR-060, write-ahead
-- addendum, D-069), and the expiry sweep's durable retry state (#402 r1 F2).
--
-- keycloak_write_attempt: one row per PUT to a user's Keycloak account that may
-- still land. Inserted and committed — in its own short transaction, on its own
-- connection pool — BEFORE the PUT is sent, so neither a rollback of the
-- business transaction nor a process exit can remove it. Deleted only by the
-- attempt that owns it, once its outcome is confirmed and Keycloak holds the
-- committed state, or by a confirmed re-assertion of the committed state after
-- takeover_at (deadline_at + KEYCLOAK_WRITE_SETTLE_SECONDS). While a row of a
-- user is live (takeover_at in the future), a narrowing change of that user is
-- refused (503 KEYCLOAK_WRITE_SETTLING).
--
-- No foreign key to "user", on purpose: a foreign key check takes FOR KEY SHARE
-- on the user row, which the business transaction holds FOR UPDATE while it
-- inserts the fence on another connection — the insert would wait on the very
-- transaction it serves. No trigger, for the same reason.
CREATE TABLE "keycloak_write_attempt" (
    "attempt_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "keycloak_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "takeover_at" TIMESTAMP(3) NOT NULL,
    "reassert_failures" INTEGER NOT NULL DEFAULT 0,
    "next_reassert_at" TIMESTAMP(3) NOT NULL,
    "account_missing_at" TIMESTAMP(3),

    CONSTRAINT "keycloak_write_attempt_pkey" PRIMARY KEY ("attempt_id"),
    CONSTRAINT "keycloak_write_attempt_operation_check"
        CHECK ("operation" IN ('replace_attributes', 'activate', 'disable')),
    CONSTRAINT "keycloak_write_attempt_window_check"
        CHECK ("deadline_at" >= "started_at" AND "takeover_at" >= "deadline_at")
);

CREATE INDEX "keycloak_write_attempt_user_id_idx" ON "keycloak_write_attempt"("user_id");

-- The re-assertion sweep's input: users with a fence past takeover and due for
-- another try, walked by user id (a cursor that continues across passes).
CREATE INDEX "keycloak_write_attempt_reassert_idx" ON "keycloak_write_attempt"("user_id", "next_reassert_at")
    WHERE "account_missing_at" IS NULL;

-- The expiry sweep's retry state, per lapse. Additive, defaulted: a catalogue
-- change, no table rewrite (PostgreSQL 11+ stores a constant default).
ALTER TABLE "membership" ADD COLUMN "lapse_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "membership" ADD COLUMN "lapse_retry_at" TIMESTAMP(3);
