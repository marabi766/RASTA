-- The participation score, apart from reward points (ADR-047 § 1, COM-012).
--
-- Two things, both additive.
--
-- 1. Who did a verified fact, and when. `reward_source_evaluation` already
--    holds one row per fact the reward consumer confirmed with its owner
--    (ADR-061 § 4), whether or not any rule paid; it did not say whose
--    behaviour the fact was. `subject_user_id` and `occurred_at` are the
--    owner's own values (`recordedBy` / `completedBy` and the instant), written
--    with the claim. They are what a participation score counts. Rows written
--    before this migration, and backfilled rows, stay NULL and count for
--    nobody: the owner was not asked who they were.
--
-- 2. The participation rule, versioned. Which verified facts count, with what
--    weight, at most how many per window, and the window: governance numbers,
--    so a table and not an environment variable (economic env.ts header,
--    ADR-023), and none is seeded (docs/24 Q-139). A rule is never edited or
--    deleted: a change is a new version, in force from its creation, and the
--    old one stays as the record of what was in force before. The trigger
--    below refuses UPDATE, DELETE and TRUNCATE.
--
-- Populated databases: two nullable columns with no default, a partial index
-- over rows that have neither filled yet (none), and a new empty table.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "reward_source_evaluation"
  ADD COLUMN "subject_user_id" TEXT,
  ADD COLUMN "occurred_at" TIMESTAMP(3);

-- A subject is a person whose fact happened at an instant; a fact recorded by
-- no user (NO_SUBJECT) has no subject to name.
ALTER TABLE "reward_source_evaluation"
  ADD CONSTRAINT "ck_reward_source_evaluation_subject"
  CHECK ("subject_user_id" IS NULL
         OR ("subject_user_id" <> '' AND "occurred_at" IS NOT NULL AND "outcome" <> 'NO_SUBJECT'));

-- One person's verified facts in one organization over a window: the
-- breakdown's only access path, tenant first.
CREATE INDEX "ix_reward_source_evaluation_subject"
  ON "reward_source_evaluation" ("organization_id", "subject_user_id", "occurred_at")
  WHERE "subject_user_id" IS NOT NULL;

CREATE TABLE "participation_rule" (
    -- `PRL_<ULID>`.
    "id"            TEXT         NOT NULL,
    -- 1, 2, 3 … in creation order; the highest is in force.
    "version"       INTEGER      NOT NULL,
    "window_days"   INTEGER      NOT NULL,
    -- [{ "triggerEvent": "USAGE_RECORDED", "weight": 1, "maxPerWindow": 30 }, …]
    -- Validated by the service; the database holds that it is a non-empty array.
    "contributions" JSONB        NOT NULL,
    "label"         TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by"    TEXT         NOT NULL,

    CONSTRAINT "participation_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ux_participation_rule_version" UNIQUE ("version"),
    CONSTRAINT "ck_participation_rule_version" CHECK ("version" > 0),
    CONSTRAINT "ck_participation_rule_window" CHECK ("window_days" BETWEEN 1 AND 366),
    CONSTRAINT "ck_participation_rule_contributions"
        CHECK (jsonb_typeof("contributions") = 'array' AND jsonb_array_length("contributions") > 0)
);

CREATE OR REPLACE FUNCTION reject_participation_rule_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'participation_rule is append-only. A new rule is a new version, never an UPDATE/DELETE.'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_participation_rule_append_only"
  BEFORE UPDATE OR DELETE ON "participation_rule"
  FOR EACH ROW EXECUTE FUNCTION reject_participation_rule_mutation();

CREATE TRIGGER "trg_participation_rule_no_truncate"
  BEFORE TRUNCATE ON "participation_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_participation_rule_mutation();

COMMIT;
