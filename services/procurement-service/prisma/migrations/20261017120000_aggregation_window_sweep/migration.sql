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
--    demands to follow is set only by the end and only ever comes down, and the
--    cancellation is written only by READY → CANCELLED. The digest's progress
--    moves phase by phase only (PR-338 r2 F1): none on an OPEN window; begun by
--    the end from nothing (the empty SHA-256, no id taken); each batch exactly the
--    ids after the last one taken, as many as it counts, their bytes in the
--    state; written by the batch that takes the last id, the count then the
--    window's; never changed after. The database recomputes all of it but the
--    eight SHA-256 working words (`demand_aggregation_digest_range` reads the
--    batch's ids again: one range, as the batch's own read).
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

-- The ids of a window's demands that count after `p_after` (NULL: from the first) up to `p_upto`
-- (NULL: to the last), in byte order, at most `p_limit` of them: how many, the last, and the bytes
-- the digest takes of them (joined by a newline). One range of `ix_demand_request_window_ids`, with
-- sorting off as for the batch's own read (`DemandRepository.nextDemandIds`), so the guard's check
-- of a batch costs the batch's, whatever the window holds.
CREATE FUNCTION "demand_aggregation_digest_range"(
    p_organization_id TEXT, p_aggregation_id TEXT, p_after TEXT, p_upto TEXT, p_limit INTEGER,
    OUT taken INTEGER, OUT last_id TEXT, OUT joined BYTEA)
AS $$
BEGIN
  IF p_upto IS NULL THEN
    SELECT count(*), max(b."id" COLLATE "C"),
           convert_to(coalesce(string_agg(b."id", E'\n' ORDER BY b."id" COLLATE "C"), ''), 'UTF8')
      INTO taken, last_id, joined
      FROM (SELECT d."id" FROM "demand_request" AS d
             WHERE d."organization_id" = p_organization_id AND d."aggregation_id" = p_aggregation_id
               AND d."status" <> 'WITHDRAWN' AND d."id" COLLATE "C" > coalesce(p_after, '')
             ORDER BY d."id" COLLATE "C" LIMIT p_limit) AS b;
  ELSE
    SELECT count(*), max(b."id" COLLATE "C"),
           convert_to(coalesce(string_agg(b."id", E'\n' ORDER BY b."id" COLLATE "C"), ''), 'UTF8')
      INTO taken, last_id, joined
      FROM (SELECT d."id" FROM "demand_request" AS d
             WHERE d."organization_id" = p_organization_id AND d."aggregation_id" = p_aggregation_id
               AND d."status" <> 'WITHDRAWN' AND d."id" COLLATE "C" > coalesce(p_after, '')
               AND d."id" COLLATE "C" <= p_upto
             ORDER BY d."id" COLLATE "C" LIMIT p_limit) AS b;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SET enable_sort = off;

-- The guard calls it as the writer — the runtime role. PUBLIC has no EXECUTE on what the migrator
-- creates (service-privilege-split.bash); it is SECURITY INVOKER.
GRANT EXECUTE ON FUNCTION "demand_aggregation_digest_range"(TEXT, TEXT, TEXT, TEXT, INTEGER) TO rasta_procurement;

CREATE OR REPLACE FUNCTION "demand_aggregation_guard"() RETURNS trigger AS $$
DECLARE
  -- A saved SHA-256 state (`ResumableSha256`): 8 words, the bytes taken (uint64, big-endian), the
  -- incomplete block's bytes. The empty one is the initial words and nothing taken.
  fresh CONSTANT BYTEA := '\x6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd190000000000000000';
  batch RECORD;
  fed BYTEA;
  old_length BIGINT;
  new_length BIGINT;
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
    -- The digest of the demands a window ended with moves phase by phase, and in no other way
    -- (PR-338 r2 F1): what one phase leaves is all the next one starts from, so nothing written
    -- beside them — a count, a cursor, a state — can make the end's event carry a digest of fewer
    -- ids than the window ended with.
    IF OLD."end_digest_state" IS NULL AND NEW."end_digest_state" IS NULL THEN
      -- None being built (an OPEN window, or one whose digest is written): nothing of it moves.
      IF NEW."demand_ids_sha256" IS DISTINCT FROM OLD."demand_ids_sha256"
         OR NEW."end_digest_cursor" IS DISTINCT FROM OLD."end_digest_cursor"
         OR NEW."end_digest_counted" <> OLD."end_digest_counted"
      THEN
        RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest''s progress moves only while it is built, and its value is written once'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."end_digest_state" IS NULL THEN
      -- Begun: by the end itself (OPEN → READY, REFERRED or LAPSED), from nothing — the empty
      -- SHA-256, no id taken, no cursor.
      IF NOT (OLD."status" = 'OPEN' AND NEW."status" IN ('READY', 'REFERRED', 'LAPSED')
              AND NEW."end_digest_state" = fresh AND NEW."end_digest_counted" = 0
              AND NEW."end_digest_cursor" IS NULL AND NEW."demand_ids_sha256" IS NULL)
      THEN
        RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest is begun only by the window''s end, from nothing'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."end_digest_state" IS NOT NULL THEN
      -- A batch: the ids after the last one taken up to the new cursor, exactly as many as it
      -- counts more, their bytes taken by the state and its incomplete block their last bytes; the
      -- words move only when a block was completed. Never back, never again from the start.
      IF NEW."end_digest_state" IS DISTINCT FROM OLD."end_digest_state"
         OR NEW."end_digest_cursor" IS DISTINCT FROM OLD."end_digest_cursor"
         OR NEW."end_digest_counted" <> OLD."end_digest_counted"
      THEN
        IF NEW."status" <> OLD."status" OR NEW."end_digest_counted" <= OLD."end_digest_counted"
           OR NEW."end_digest_cursor" IS NULL
           OR NEW."end_digest_cursor" COLLATE "C" <= coalesce(OLD."end_digest_cursor", '') COLLATE "C"
        THEN
          RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest only moves forward'
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO batch FROM "demand_aggregation_digest_range"(
          NEW."organization_id", NEW."id", OLD."end_digest_cursor", NEW."end_digest_cursor",
          NEW."end_digest_counted" - OLD."end_digest_counted" + 1);
        fed := CASE WHEN OLD."end_digest_counted" = 0 THEN ''::bytea ELSE '\x0a'::bytea END
               || batch.joined;
        old_length := ('x' || encode(substring(OLD."end_digest_state" FROM 33 FOR 8), 'hex'))::bit(64)::bigint;
        new_length := ('x' || encode(substring(NEW."end_digest_state" FROM 33 FOR 8), 'hex'))::bit(64)::bigint;
        IF batch.taken <> NEW."end_digest_counted" - OLD."end_digest_counted"
           OR batch.last_id IS DISTINCT FROM NEW."end_digest_cursor"
           OR new_length <> old_length + octet_length(fed)
           OR substring(NEW."end_digest_state" FROM 41)
              <> substring(substring(OLD."end_digest_state" FROM 41) || fed
                           FROM octet_length(OLD."end_digest_state") - 40 + octet_length(fed)
                                - (new_length % 64)::integer + 1)
           OR (new_length / 64 = old_length / 64
               AND substring(NEW."end_digest_state" FOR 32) <> substring(OLD."end_digest_state" FOR 32))
        THEN
          RAISE EXCEPTION 'ck_demand_aggregation_digest: a batch of a digest takes exactly the ids it counts, after the last one taken'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSE
      -- Written: by the batch that takes the last id — every id after the last one taken, the
      -- count then the window's — and the state cleared with it.
      SELECT * INTO batch FROM "demand_aggregation_digest_range"(
        NEW."organization_id", NEW."id", OLD."end_digest_cursor", NULL,
        NEW."demand_count" - OLD."end_digest_counted" + 1);
      IF NEW."status" <> OLD."status" OR NEW."demand_ids_sha256" IS NULL
         OR NEW."end_digest_counted" <> NEW."demand_count"
         OR batch.taken <> NEW."demand_count" - OLD."end_digest_counted"
      THEN
        RAISE EXCEPTION 'ck_demand_aggregation_digest: a digest is written only by the batch that takes its last id'
          USING ERRCODE = 'check_violation';
      END IF;
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
-- The guard admits a digest only from the batches that build it, and these windows ended before
-- there were any, so it is lifted for this one statement (the owner alone can), and the totals
-- check the statement queued runs before it is put back.
ALTER TABLE "demand_aggregation" DISABLE TRIGGER "tg_demand_aggregation_guard";
UPDATE "demand_aggregation" AS a
   SET "demand_ids_sha256" = (
         SELECT encode(sha256(convert_to(
                  coalesce(string_agg(d."id", E'\n' ORDER BY d."id" COLLATE "C"), ''), 'UTF8')), 'hex')
           FROM "demand_request" AS d
          WHERE d."organization_id" = a."organization_id" AND d."aggregation_id" = a."id"
            AND d."status" <> 'WITHDRAWN'),
       "end_digest_counted" = a."demand_count"
 WHERE a."status" <> 'OPEN';
SET CONSTRAINTS "tg_demand_aggregation_totals_check" IMMEDIATE;
SET CONSTRAINTS "tg_demand_aggregation_totals_check" DEFERRED;
ALTER TABLE "demand_aggregation" ENABLE TRIGGER "tg_demand_aggregation_guard";

-- An OPEN window has no digest and no progress of one: nothing taken, no cursor, no state. An
-- ended one has its digest, or the state of the one being built (READY, REFERRED or LAPSED only:
-- nothing moves a window on before its end's event is out) — one or the other, never both; a
-- written digest took every id the window ended with.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_digest"
  CHECK (("demand_ids_sha256" IS NULL OR "demand_ids_sha256" ~ '^[0-9a-f]{64}$')
         AND (CASE WHEN "status" = 'OPEN'
                   THEN "demand_ids_sha256" IS NULL AND "end_digest_state" IS NULL
                        AND "end_digest_counted" = 0
                   WHEN "status" IN ('READY', 'REFERRED', 'LAPSED', 'RFQ_ISSUED', 'CANCELLED')
                   THEN ("demand_ids_sha256" IS NULL) <> ("end_digest_state" IS NULL)
                   -- Any other status is ck_demand_aggregation_status's to refuse.
                   ELSE TRUE END)
         AND ("end_digest_state" IS NULL OR "status" IN ('READY', 'REFERRED', 'LAPSED'))
         AND ("end_digest_state" IS NOT NULL OR "end_digest_cursor" IS NULL)
         AND ("demand_ids_sha256" IS NULL OR "end_digest_counted" = "demand_count")
         AND "end_digest_counted" BETWEEN 0 AND "demand_count");
