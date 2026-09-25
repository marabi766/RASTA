-- One reward evaluation per source fact (PR #110 review #1).
--
-- processed_event is keyed by event id, and reward is unique on (rule_id,
-- source_reference). Neither stopped a fact from being evaluated twice: a
-- usage record consumed while no rule could pay, or before a second rule
-- existed, and re-emitted later under a new event id after a rule was
-- activated with a valid_from over it, would pay. This table records that a
-- fact has been evaluated, paid or not; the reward consumer claims the row
-- before any grant and refuses any other event id for the same fact.
--
-- Additive: a new table and a backfill, nothing altered or dropped.
-- Wrapped in an explicit transaction so the table and its backfill land
-- together or not at all, however the script is run.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "reward_source_evaluation" (
    "organization_id"  TEXT         NOT NULL,
    "trigger_event"    TEXT         NOT NULL,
    "source_reference" TEXT         NOT NULL,
    "event_id"         TEXT         NOT NULL,
    "outcome"          TEXT         NOT NULL,
    "evaluated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_source_evaluation_pkey"
        PRIMARY KEY ("organization_id", "trigger_event", "source_reference"),
    CONSTRAINT "ck_reward_source_evaluation_outcome"
        CHECK ("outcome" IN ('NO_RULE', 'NO_SUBJECT', 'EVALUATED'))
);

-- Facts that were already paid are already evaluated. Without this, a rule
-- activated after deployment could pay a fact a different rule paid before
-- it, when the fact is re-emitted under a new event id. Facts consumed with
-- no rule before this migration left no source reference behind (only an
-- event id in processed_event), so they cannot be backfilled; see the PR.
INSERT INTO "reward_source_evaluation"
       ("organization_id", "trigger_event", "source_reference", "event_id", "outcome", "evaluated_at")
SELECT "organization_id", "trigger_event", "source_reference", 'BACKFILL', 'EVALUATED', min("granted_at")
  FROM "reward"
 GROUP BY "organization_id", "trigger_event", "source_reference";

COMMIT;
