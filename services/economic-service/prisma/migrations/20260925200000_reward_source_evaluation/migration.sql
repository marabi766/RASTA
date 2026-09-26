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
-- Additive: two new tables, a trigger and a backfill, nothing altered or
-- dropped. Wrapped in an explicit transaction so they land together or not
-- at all, however the script is run.
--
-- Edited in place across review rounds 1-3 (PR #110 round 3 #5). That is
-- safe only because this file has never been on main and no persistent
-- environment has applied an earlier version: CI and development databases
-- are disposable. A database that applied an earlier version must be reset
-- (down.sql, then deploy), never patched.

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

-- The evaluation cutover (round 2 #3, round 3 #1 and #2). Facts consumed
-- with no rule before this table existed left no source reference behind
-- (only an event id in processed_event), so they cannot be backfilled above.
-- Instead: a fact that occurred before the cutover and has no evaluation row
-- is refused by the consumer (dead-lettered BACKFILL_REQUIRED) and can only
-- be evaluated by an authorised backfill. One row, platform-wide.
--
-- Deliberately NOT set here. During a rolling deploy the old consumer keeps
-- consuming facts, without evaluations, after this migration has run; a
-- cutover stamped now would admit them as never evaluated. The operator
-- records it once every old reward consumer is stopped
-- (docs/runbooks/reward-evaluation-cutover.md); until then the new consumer
-- fails closed and evaluates nothing.
CREATE TABLE "reward_evaluation_cutover" (
    "singleton"  BOOLEAN      NOT NULL DEFAULT TRUE,
    "cutover_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_evaluation_cutover_pkey" PRIMARY KEY ("singleton"),
    CONSTRAINT "ck_reward_evaluation_cutover_singleton" CHECK ("singleton")
);

-- It never moves backward, and it is never removed. Lowering it would admit
-- the history between the two instants, every tenant's at once, as never
-- evaluated: the replay the table exists to close. Admitting a tenant's
-- history is an authorised per-tenant backfill (ADR-061 § 4.2), not an edit
-- of this row. Moving it forward only refuses more, so an operator who
-- recorded it before the drain finished may correct it.
CREATE FUNCTION "reward_evaluation_cutover_forward_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."cutover_at" >= OLD."cutover_at" THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'reward_evaluation_cutover may only move forward (% refused)', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "reward_evaluation_cutover_forward_only"
    BEFORE UPDATE OR DELETE ON "reward_evaluation_cutover"
    FOR EACH ROW EXECUTE FUNCTION "reward_evaluation_cutover_forward_only"();

CREATE TRIGGER "reward_evaluation_cutover_no_truncate"
    BEFORE TRUNCATE ON "reward_evaluation_cutover"
    FOR EACH STATEMENT EXECUTE FUNCTION "reward_evaluation_cutover_forward_only"();

COMMIT;
