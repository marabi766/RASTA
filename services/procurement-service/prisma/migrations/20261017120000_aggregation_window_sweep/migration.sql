-- =============================================================================
-- procurement-service — the end of the aggregation window on time, and its
-- cancellation (COM-007 PR 2; ADR-070 § 2, plan PR 2).
--
-- 1. The sweeper's bookkeeping on the window row, the shape construction-service's
--    tender close sweeper keeps on `tender` (ADR-065 § 3): a lease and a fencing
--    token, and a failed attempt's count and backoff. A claim is not a change of
--    the aggregation: it moves neither `version` nor `updated_at`.
-- 2. `demands_to_follow`: the live demands of a window that ended REFERRED or
--    LAPSED which have not yet followed it. The end moves at most a bounded batch
--    of demands in its own transaction (PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE), so
--    ending a window costs the same whatever it holds; the sweeper moves the rest,
--    one bounded batch per transaction, and the count comes down to 0.
-- 3. READY → CANCELLED: who, when and why, all three and only on a cancelled
--    aggregation (the reason stays here; the event never carries it).
-- 4. The digest of the demands a window ended with (`demand_ids_sha256`, the
--    value its end event carries), built in bounded batches (PR-338 r1 F1): the end
--    leaves OPEN at once and stores a resumable SHA-256 state; each later batch
--    feeds the next ids in byte order (`end_digest_cursor`) and stores the state
--    again; the transaction that feeds the last one writes the digest, clears the
--    state and enqueues the end's one event. The demand set is frozen from the end
--    on, so the batches read one set. `ix_demand_request_window_ids` keeps each
--    batch an index range, whatever the window holds.
-- 5. `demand_aggregation_guard` admits the new kinds of change and keeps every
--    old rule: the bookkeeping alone may change without a version, the count of
--    demands to follow is set only by the end and only ever comes down, the digest
--    is begun only by the end, only moves forward and is written once, and the
--    cancellation is written only by READY → CANCELLED.
-- =============================================================================

ALTER TABLE "demand_aggregation"
  ADD COLUMN "demands_to_follow" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sweep_lease_until" TIMESTAMPTZ(3),
  ADD COLUMN "sweep_fence" TEXT,
  ADD COLUMN "sweep_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sweep_next_attempt_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancelled_by" TEXT,
  ADD COLUMN "cancel_reason" TEXT,
  ADD COLUMN "demand_ids_sha256" TEXT,
  ADD COLUMN "end_digest_state" BYTEA,
  ADD COLUMN "end_digest_cursor" TEXT,
  ADD COLUMN "end_digest_counted" INTEGER NOT NULL DEFAULT 0;

-- Only a window that ended REFERRED or LAPSED has demands still to follow it, and never more than
-- it holds.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_follow"
  CHECK ("demands_to_follow" BETWEEN 0 AND "demand_count"
         AND ("demands_to_follow" = 0 OR "status" IN ('REFERRED', 'LAPSED')));

-- A claim is a lease and its fence together, or neither; attempts are counted from zero.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_sweep_claim"
  CHECK ((("sweep_lease_until" IS NULL) = ("sweep_fence" IS NULL))
         AND ("sweep_fence" IS NULL OR btrim("sweep_fence") <> '')
         AND "sweep_attempts" >= 0);

-- A cancellation names when, who and why — all three, only on a CANCELLED aggregation, after the
-- window ended.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_cancelled"
  CHECK ((("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL))
         AND num_nonnulls("cancelled_at", "cancelled_by", "cancel_reason") IN (0, 3)
         AND ("cancelled_by" IS NULL OR btrim("cancelled_by") <> '')
         AND ("cancel_reason" IS NULL OR char_length(btrim("cancel_reason")) BETWEEN 8 AND 500)
         AND ("cancelled_at" IS NULL OR "cancelled_at" >= "closed_at"));

-- The sweeper's two queues, each partial so it holds only what is due or pending: an OPEN window
-- by its end, and an ended one whose demands are still following it.
CREATE INDEX "ix_demand_aggregation_sweep_open"
    ON "demand_aggregation" ("closes_at", "id")
 WHERE "status" = 'OPEN';

CREATE INDEX "ix_demand_aggregation_sweep_follow"
    ON "demand_aggregation" ("closes_at", "id")
 WHERE "demands_to_follow" > 0 OR "end_digest_state" IS NOT NULL;

-- A window's demands that count, in byte order: one batch of the end's digest is one range of it.
CREATE INDEX "ix_demand_request_window_ids"
    ON "demand_request" ("organization_id", "aggregation_id", "id" COLLATE "C")
 WHERE "status" <> 'WITHDRAWN';

CREATE OR REPLACE FUNCTION "demand_aggregation_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The demands still to follow an ended window: set by the end itself (OPEN → REFERRED or
    -- LAPSED, from 0), and afterwards only ever fewer.
    IF NEW."demands_to_follow" <> OLD."demands_to_follow" AND NOT (
         (OLD."status" = 'OPEN' AND NEW."status" IN ('REFERRED', 'LAPSED')
          AND OLD."demands_to_follow" = 0)
      OR (NEW."status" = OLD."status" AND NEW."demands_to_follow" < OLD."demands_to_follow")
    ) THEN
      RAISE EXCEPTION 'ck_demand_aggregation_follow: the demands to follow a window are set by its end and only ever fewer'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The digest of the demands a window ended with: written once, never changed after.
    IF OLD."demand_ids_sha256" IS NOT NULL
       AND (NEW."demand_ids_sha256" IS DISTINCT FROM OLD."demand_ids_sha256"
            OR NEW."end_digest_state" IS NOT NULL)
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_digest: the digest of a window''s demands is written once'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Begun by the end itself (OPEN → READY, REFERRED or LAPSED), and by nothing else.
    IF OLD."end_digest_state" IS NULL AND NEW."end_digest_state" IS NOT NULL
       AND NOT (OLD."status" = 'OPEN' AND NEW."status" IN ('READY', 'REFERRED', 'LAPSED'))
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest is begun only by the window''s end'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Each batch takes more ids, past the last one taken: a digest never starts over or goes back.
    IF OLD."end_digest_state" IS NOT NULL AND NEW."end_digest_state" IS NOT NULL
       AND (NEW."end_digest_state" IS DISTINCT FROM OLD."end_digest_state"
            OR NEW."end_digest_cursor" IS DISTINCT FROM OLD."end_digest_cursor"
            OR NEW."end_digest_counted" <> OLD."end_digest_counted")
       AND NOT (NEW."end_digest_counted" > OLD."end_digest_counted"
                AND NEW."end_digest_cursor" IS NOT NULL
                AND (OLD."end_digest_cursor" IS NULL
                     OR NEW."end_digest_cursor" COLLATE "C" > OLD."end_digest_cursor" COLLATE "C"))
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest only moves forward'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The sweeper's bookkeeping alone — a claim, its release, a failed attempt, a batch of
    -- demands that followed, a batch of the digest — is not a change of the aggregation: no
    -- version, no updated_at.
    IF (to_jsonb(NEW) - ARRAY['demands_to_follow', 'sweep_lease_until', 'sweep_fence',
                              'sweep_attempts', 'sweep_next_attempt_at', 'demand_ids_sha256',
                              'end_digest_state', 'end_digest_cursor', 'end_digest_counted'])
       = (to_jsonb(OLD) - ARRAY['demands_to_follow', 'sweep_lease_until', 'sweep_fence',
                                'sweep_attempts', 'sweep_next_attempt_at', 'demand_ids_sha256',
                                'end_digest_state', 'end_digest_cursor', 'end_digest_counted'])
    THEN
      RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
       OR NEW."window_hours" IS DISTINCT FROM OLD."window_hours"
       OR NEW."min_quantity" IS DISTINCT FROM OLD."min_quantity"
       OR NEW."shortfall_policy" IS DISTINCT FROM OLD."shortfall_policy"
       OR NEW."setting_version" IS DISTINCT FROM OLD."setting_version"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_origin_immutable: what a window was opened with never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Only an OPEN window changes without leaving its status (a demand joins or leaves, the
    -- window is extended); a window that ended is history.
    IF NEW."status" = OLD."status" AND OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'ck_demand_aggregation_transition: a % aggregation does not change', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'OPEN' AND NEW."status" IN ('READY', 'REFERRED', 'LAPSED'))
      OR (OLD."status" = 'READY' AND NEW."status" IN ('RFQ_ISSUED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'ck_demand_aggregation_transition: % -> % is not a transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- The window's contents are frozen once it ended (ADR-070 § 2): the demand set is final, and
    -- so is the instant it ended.
    IF OLD."status" <> 'OPEN'
       AND (NEW."total_quantity" IS DISTINCT FROM OLD."total_quantity"
            OR NEW."demand_count" IS DISTINCT FROM OLD."demand_count"
            OR NEW."closes_at" IS DISTINCT FROM OLD."closes_at"
            OR NEW."extension_count" IS DISTINCT FROM OLD."extension_count"
            OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at")
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_frozen: a window that ended keeps its contents'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A cancellation is written by READY → CANCELLED and by nothing else.
    IF (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
        OR NEW."cancelled_by" IS DISTINCT FROM OLD."cancelled_by"
        OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason")
       AND NOT (OLD."status" = 'READY' AND NEW."status" = 'CANCELLED')
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_cancelled: a cancellation is written only by READY -> CANCELLED'
        USING ERRCODE = 'check_violation';
    END IF;
    -- An extension only moves the end forward, one counted window at a time or more.
    IF NEW."closes_at" < OLD."closes_at" OR NEW."extension_count" < OLD."extension_count"
       OR ((NEW."closes_at" > OLD."closes_at") <> (NEW."extension_count" > OLD."extension_count"))
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_extension: a window is only ever extended, and every extension is counted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_demand_aggregation_version: every change moves the version by one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_demand_aggregation_not_erasable: an aggregation is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- A window that ended under PR 1 had its end's event written with this same digest, in one
-- statement (PR 1 holds a window to at most 10,000 live demands): it is stored with the window.
UPDATE "demand_aggregation" AS a
   SET "demand_ids_sha256" = (
         SELECT encode(sha256(convert_to(
                  coalesce(string_agg(d."id", E'\n' ORDER BY d."id" COLLATE "C"), ''), 'UTF8')), 'hex')
           FROM "demand_request" AS d
          WHERE d."organization_id" = a."organization_id" AND d."aggregation_id" = a."id"
            AND d."status" <> 'WITHDRAWN'),
       "end_digest_counted" = a."demand_count"
 WHERE a."status" <> 'OPEN';

-- An OPEN window has no digest. An ended one has its digest, or the state of the one being built
-- (READY, REFERRED or LAPSED only: nothing moves a window on before its end's event is out) —
-- one or the other, never both.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_digest"
  CHECK (("demand_ids_sha256" IS NULL OR "demand_ids_sha256" ~ '^[0-9a-f]{64}$')
         AND (CASE WHEN "status" = 'OPEN'
                   THEN "demand_ids_sha256" IS NULL AND "end_digest_state" IS NULL
                   WHEN "status" IN ('READY', 'REFERRED', 'LAPSED', 'RFQ_ISSUED', 'CANCELLED')
                   THEN ("demand_ids_sha256" IS NULL) <> ("end_digest_state" IS NULL)
                   -- Any other status is ck_demand_aggregation_status's to refuse.
                   ELSE TRUE END)
         AND ("end_digest_state" IS NULL OR "status" IN ('READY', 'REFERRED', 'LAPSED'))
         AND ("end_digest_state" IS NOT NULL OR "end_digest_cursor" IS NULL)
         AND "end_digest_counted" BETWEEN 0 AND "demand_count");
