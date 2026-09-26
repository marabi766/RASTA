-- One reward evaluation per source fact (PR #110 reviews #1 and round 2).
--
-- processed_event is keyed by event id, and reward is unique on (rule_id,
-- source_reference). Neither stopped a fact from being evaluated twice: a
-- usage record consumed while no rule could pay, or before a second rule
-- existed, and re-emitted later under a new event id after a rule was
-- activated with a valid_from over it, would pay. This table records that a
-- fact has been evaluated, paid or not; the reward consumer claims the row
-- before any grant and refuses any other event id for the same fact.
--
-- Additive: two new tables and a backfill, nothing altered or dropped.
-- Wrapped in an explicit transaction so the tables, the backfill and the
-- cutover land together or not at all, however the script is run.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "reward_source_evaluation" (
    "organization_id"  TEXT         NOT NULL,
    "trigger_event"    TEXT         NOT NULL,
    "source_reference" TEXT         NOT NULL,
    -- EVENT: decided by a consumed event, which alone may resume it after a
    -- crash. BACKFILL: derived below from rewards granted before this table
    -- existed; terminal, never resumable. Kept out of the event-id namespace
    -- entirely (round 2 #1): a sentinel like 'BACKFILL' in event_id is a
    -- value any envelope may carry.
    "origin"           TEXT         NOT NULL,
    "event_id"         TEXT,
    "outcome"          TEXT         NOT NULL,
    -- The rules the first evaluation found applicable. A redelivery after a
    -- crash evaluates only these, so a rule activated in the crash window
    -- cannot pay (round 2 #2). Empty for NO_RULE and NO_SUBJECT.
    "rule_ids"         TEXT[]       NOT NULL DEFAULT '{}',
    "evaluated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_source_evaluation_pkey"
        PRIMARY KEY ("organization_id", "trigger_event", "source_reference"),
    CONSTRAINT "ck_reward_source_evaluation_outcome"
        CHECK ("outcome" IN ('NO_RULE', 'NO_SUBJECT', 'EVALUATED')),
    CONSTRAINT "ck_reward_source_evaluation_origin"
        CHECK ("origin" IN ('EVENT', 'BACKFILL')),
    CONSTRAINT "ck_reward_source_evaluation_event_id"
        CHECK (("origin" = 'EVENT') = ("event_id" IS NOT NULL))
);

-- Facts that were already paid are already evaluated. Without this, a rule
-- activated after deployment could pay a fact a different rule paid before
-- it, when the fact is re-emitted under a new event id.
INSERT INTO "reward_source_evaluation"
       ("organization_id", "trigger_event", "source_reference", "origin", "event_id",
        "outcome", "rule_ids", "evaluated_at")
SELECT "organization_id", "trigger_event", "source_reference", 'BACKFILL', NULL,
       'EVALUATED', array_agg(DISTINCT "rule_id" ORDER BY "rule_id"), min("granted_at")
  FROM "reward"
 GROUP BY "organization_id", "trigger_event", "source_reference";

-- The evaluation cutover (round 2 #3). Facts consumed with no rule before
-- this migration left no source reference behind (only an event id in
-- processed_event), so they cannot be backfilled above. Instead: a fact that
-- occurred before this instant and has no evaluation row is refused by the
-- consumer (dead-lettered BACKFILL_REQUIRED) and can only be evaluated by an
-- authorised backfill. One row, platform-wide; set to when this migration
-- ran. It is data, not code: an operator who knows the history better (a
-- tenant that never consumed anything before a later date) may move it, and
-- the consumer reads it on every evaluation.
CREATE TABLE "reward_evaluation_cutover" (
    "singleton"  BOOLEAN      NOT NULL DEFAULT TRUE,
    "cutover_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_evaluation_cutover_pkey" PRIMARY KEY ("singleton"),
    CONSTRAINT "ck_reward_evaluation_cutover_singleton" CHECK ("singleton")
);

INSERT INTO "reward_evaluation_cutover" ("singleton", "cutover_at")
VALUES (TRUE, CURRENT_TIMESTAMP);

COMMIT;
