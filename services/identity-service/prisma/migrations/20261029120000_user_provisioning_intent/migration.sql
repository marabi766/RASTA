-- Task 117, audit F6 -- a direct provisioning's intent, durable before Keycloak.
--
-- Additive only: a new table, nothing existing is altered.
--
-- `POST /v1/users` creates a disabled Keycloak account and then commits the user
-- row. When that transaction failed, the account stayed and nothing on the
-- platform named it: a retry minted a new user id, Keycloak answered 409 for
-- the username, and it did so forever. This row is written and committed
-- before the account is created and carries the user id the account is
-- created with (`rasta_user_id`), so a retry creates under the same id, or
-- adopts the account an earlier attempt created -- only when that account's
-- provenance names this row's user, never anybody else's.
--
-- ## What binds a retry to the row
--
-- The verified actor and the Idempotency-Key they chose (the key), the
-- organization they acted for, and a SHA-256 of the normalised request body
-- (never the body). A retry adopts or replays only when all four match; the
-- same key with another body or another acting organization is refused,
-- 409 IDEMPOTENCY_KEY_REUSED. Concurrent retries take this row's lock and run
-- one after the other.
--
-- ## Completion
--
-- `completed_at` and `response_body` are written in the transaction that
-- commits the user, so a retry after a lost answer replays it (docs/06 § 6.8)
-- and creates nothing. Never both null-and-set: the CHECK below.
--
-- ## Retention
--
-- None, like `audit_correction_command`: one row per provisioned user (and per
-- failed attempt), and the only record tying an account in Keycloak to the
-- request that created it.
CREATE TABLE "user_provisioning_intent" (
    "actor_id" VARCHAR(256) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "acting_organization_id" VARCHAR(64),
    "request_hash" CHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "membership_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "response_body" JSONB,

    CONSTRAINT "user_provisioning_intent_pkey" PRIMARY KEY ("actor_id", "idempotency_key"),
    CONSTRAINT "ck_user_provisioning_intent_completion"
        CHECK (("completed_at" IS NULL) = ("response_body" IS NULL))
);

-- One intent per user id: the id an account's provenance names is never shared.
CREATE UNIQUE INDEX "ux_user_provisioning_intent_user" ON "user_provisioning_intent" ("user_id");
