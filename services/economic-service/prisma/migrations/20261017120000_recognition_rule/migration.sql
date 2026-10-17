-- Levels and badges as versioned configuration (COM-012 criterion 2,
-- ADR-047 § 1).
--
-- A version names its basis — what every threshold in it is measured on:
-- `REWARD_POINTS_CUMULATIVE` (the person's reward points, which only grow) or
-- `PARTICIPATION_SCORE` (the rolling participation score). ADR-047 requires
-- the basis "explicit in the rule version", so it is a column of the version
-- and not a choice in code. Which basis, which thresholds and which names are
-- docs/24 Q-140, and none is seeded.
--
-- Governance configuration, as `participation_rule`: platform-wide, the
-- highest version in force from its creation, never edited or deleted. A
-- change is a new version, and the old one stays as the record of what was in
-- force. The trigger below refuses UPDATE, DELETE and TRUNCATE.
--
-- Nothing per person is stored: a level or badge is held while the basis
-- meets its threshold, read when asked. There is no benefit column (Q-13,
-- Q-31).
--
-- Populated databases: a new empty table; nothing else changes.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "recognition_rule" (
    -- `RCR_<ULID>`.
    "id"         TEXT         NOT NULL,
    -- 1, 2, 3 … in creation order; the highest is in force.
    "version"    INTEGER      NOT NULL,
    "basis"      TEXT         NOT NULL,
    -- [{ "rank": 1, "name": "…", "threshold": 0 }, …], thresholds rising.
    "levels"     JSONB        NOT NULL,
    -- [{ "code": "…", "name": "…", "threshold": 0 }, …].
    -- Validated by the service; the database holds the shape that matters.
    "badges"     JSONB        NOT NULL,
    "label"      TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT         NOT NULL,

    CONSTRAINT "recognition_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ux_recognition_rule_version" UNIQUE ("version"),
    CONSTRAINT "ck_recognition_rule_version" CHECK ("version" > 0),
    CONSTRAINT "ck_recognition_rule_basis"
        CHECK ("basis" IN ('REWARD_POINTS_CUMULATIVE', 'PARTICIPATION_SCORE')),
    -- Two arrays, and a version that names neither a level nor a badge
    -- recognises nothing.
    CONSTRAINT "ck_recognition_rule_terms"
        CHECK (jsonb_typeof("levels") = 'array' AND jsonb_typeof("badges") = 'array'
               AND jsonb_array_length("levels") + jsonb_array_length("badges") > 0)
);

CREATE OR REPLACE FUNCTION reject_recognition_rule_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'recognition_rule is append-only. New levels or badges are a new version, never an UPDATE/DELETE.'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_recognition_rule_append_only"
  BEFORE UPDATE OR DELETE ON "recognition_rule"
  FOR EACH ROW EXECUTE FUNCTION reject_recognition_rule_mutation();

CREATE TRIGGER "trg_recognition_rule_no_truncate"
  BEFORE TRUNCATE ON "recognition_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_recognition_rule_mutation();

COMMIT;
