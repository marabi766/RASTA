-- NTF-003 — notification preferences and the precedence ladder (ADR-054 § 5).
--
-- One row is one person's choice about one channel at one level of
-- specificity. The resolver reads at most one row per layer, narrowest first.
--
-- Two things are enforced here rather than in a DTO, because a DTO protects the
-- API and this table is also written by tests, fixtures and any future admin
-- path:
--
--   * `scope_key` is null exactly when the scope is GLOBAL. A GLOBAL row with a
--     key, or a RULE row without one, would sit in the unique index under a
--     shape the resolver never looks for — present in the table, invisible to
--     the ladder, and impossible to explain to the person who set it.
--   * The unique key includes `scope_key`, and PostgreSQL treats NULLs as
--     distinct in a unique index. Two GLOBAL rows for the same channel would
--     therefore both be allowed, and the winning layer would depend on row
--     order. `ux_preference_global_channel` closes that with a partial unique
--     index on the GLOBAL rows alone.

CREATE TYPE "preference_scope" AS ENUM ('GLOBAL', 'CATEGORY', 'RULE');

CREATE TABLE "notification_preference" (
    "id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128) NOT NULL,
    "scope" "preference_scope" NOT NULL,
    "scope_key" VARCHAR(128),
    "channel" "notification_channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(128) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_preference"
  ADD CONSTRAINT "ck_preference_scope_key_shape"
  CHECK (("scope" = 'GLOBAL' AND "scope_key" IS NULL)
      OR ("scope" <> 'GLOBAL' AND "scope_key" IS NOT NULL AND length(btrim("scope_key")) > 0));

CREATE UNIQUE INDEX "ux_preference_owner_scope_channel"
    ON "notification_preference" ("user_id", "organization_id", "scope", "scope_key", "channel");

-- The GLOBAL half of the same rule, because NULL is distinct in a unique index.
CREATE UNIQUE INDEX "ux_preference_global_channel"
    ON "notification_preference" ("user_id", "organization_id", "channel")
 WHERE "scope" = 'GLOBAL';

CREATE INDEX "ix_preference_owner"
    ON "notification_preference" ("organization_id", "user_id");
