-- ADR-053 § 4 — windowed refusal aggregation (AUD-004 Phase C2).
--
-- "500 probes in one minute become one row with occurrenceCount = 500, not
-- 500 rows." Until now `security_event_outbox` wrote one row per refusal; this
-- migration gives each row an occurrence count and the explicit UTC window it
-- counts over, and lets the database — not the application — decide which
-- row a new refusal belongs to.
--
-- ## The aggregation identity
--
-- A refusal joins an existing row only if every one of these is equal:
--
--   organization_id   the tenant the caller acted for (NULL = platform)
--   actor_type        \
--   actor_id           } who was refused, from the verified token
--   action            \
--   resource_type      } what was refused — fixed per refusal site in code
--   resource_id       /
--   error_code         why
--   window_started_at \  the UTC bucket, chosen by the database clock
--   window_ends_at    /
--
-- Deliberately **not** in it: source ip, user agent, correlation id,
-- traceparent, roles and producer version. The first two are chosen by the
-- caller — keying on them would let a prober defeat aggregation by rotating a
-- header, which is exactly the amplification ADR-053 § 4 closes. The row keeps
-- the first occurrence's values of all six as a representative sample
-- (docs/24-open-questions.md Q-44). Nothing the request body, the URL, the
-- token or an exception message says is a column, so none of it can be a key.
--
-- ## Why a partial unique index is the whole concurrency story
--
-- `ux_security_event_outbox_open_bucket` covers only rows that may still
-- change: unpublished, **never claimed**, below the INTEGER ceiling. A capture
-- is one `INSERT … ON CONFLICT … DO UPDATE` against it, so for concurrent
-- matching refusals PostgreSQL guarantees exactly one row is inserted and every
-- other one increments it. The moment the relay claims a row
-- (`claim_count` 0 → 1) or the count reaches 2147483647, that row leaves the
-- index; the next matching refusal no longer conflicts with it and inserts a
-- successor row instead. A refusal racing a claim waits on the row lock and
-- then lands on one side or the other — included before the claim commits, or
-- in a new row — never lost and never added to a row already in flight.
--
-- The relay claims only rows whose window has closed
-- (`ix_security_event_outbox_closed_windows`), and the trigger below makes the
-- "never mutated once claimed" rule a property of the database rather than of
-- the code that happens to run against it.
--
-- ## Rows written before this migration
--
-- Each is exactly one occurrence at `occurred_at`, so its window is that
-- instant: [occurred_at, occurred_at + 1 ms). A capture never opens a window
-- shorter than one second (the configuration floor), so the index predicate
-- keeps these single-instant rows out — nothing ever aggregates into history,
-- and two such rows can never collide while the index is built.
--
-- Additive: three columns with values for every existing row, five CHECKs,
-- two indexes and one trigger. Nothing existing is rewritten.

SET LOCAL lock_timeout = '3s';

ALTER TABLE "security_event_outbox"
  ADD COLUMN "occurrence_count"  INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN "window_started_at" TIMESTAMP(3),
  ADD COLUMN "window_ends_at"    TIMESTAMP(3);

UPDATE "security_event_outbox"
   SET "window_started_at" = "occurred_at",
       "window_ends_at"    = "occurred_at" + interval '1 millisecond'
 WHERE "window_started_at" IS NULL;

ALTER TABLE "security_event_outbox"
  ALTER COLUMN "window_started_at" SET NOT NULL,
  ALTER COLUMN "window_ends_at"    SET NOT NULL;

-- The contract's `occurrenceCount` is a positive integer, and audit_event
-- stores it as INTEGER: nothing outside [1, 2147483647] may ever be queued.
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_occurrence_count_range"
  CHECK ("occurrence_count" >= 1 AND "occurrence_count" <= 2147483647);

-- A window is a non-empty interval no longer than the configuration ceiling
-- (`SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS` ≤ 3600).
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_window_bounds"
  CHECK ("window_started_at" < "window_ends_at"
         AND "window_ends_at" - "window_started_at" <= interval '1 hour');

-- `occurred_at` is the first occurrence, so it lies inside its own window.
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_occurred_within_window"
  CHECK ("occurred_at" >= "window_started_at" AND "occurred_at" < "window_ends_at");

-- Only a real aggregation window can hold more than one occurrence.
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_aggregate_needs_window"
  CHECK ("occurrence_count" = 1 OR "window_ends_at" - "window_started_at" >= interval '1 second');

-- Publication happens only through a claim (ADR-050), so a published row was
-- claimed — which is what lets `claim_count = 0` mean "never left the queue".
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_published_was_claimed"
  CHECK ("published_at" IS NULL OR "claim_count" >= 1);

-- The capture's conflict arbiter: at most one mutable row per identity and
-- window. NULLS NOT DISTINCT so two platform refusals (NULL tenant) aggregate
-- as the same tenant rather than as two unknowns.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_security_event_outbox_open_bucket"
    ON "security_event_outbox" (
      "organization_id", "actor_type", "actor_id", "action",
      "resource_type", "resource_id", "error_code",
      "window_started_at", "window_ends_at"
    ) NULLS NOT DISTINCT
 WHERE "published_at" IS NULL
   AND "claim_count" = 0
   AND "occurrence_count" < 2147483647
   AND "window_ends_at" - "window_started_at" >= interval '1 second';

-- The claim's eligibility (`window_ends_at <= now`) and its order, and the
-- closed-window backlog gauge, over unpublished rows only.
CREATE INDEX IF NOT EXISTS "ix_security_event_outbox_closed_windows"
    ON "security_event_outbox" ("window_ends_at", "id")
 WHERE "published_at" IS NULL;

-- Evidence is immutable; the count only grows, and only before the first claim.
CREATE FUNCTION "security_event_outbox_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."organization_id", NEW."actor_type", NEW."actor_id", NEW."actor_roles",
         NEW."action", NEW."resource_type", NEW."resource_id", NEW."error_code", NEW."reason",
         NEW."source_ip", NEW."source_user_agent", NEW."correlation_id", NEW."traceparent",
         NEW."producer_version", NEW."occurred_at", NEW."created_at",
         NEW."window_started_at", NEW."window_ends_at")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."organization_id", OLD."actor_type", OLD."actor_id", OLD."actor_roles",
         OLD."action", OLD."resource_type", OLD."resource_id", OLD."error_code", OLD."reason",
         OLD."source_ip", OLD."source_user_agent", OLD."correlation_id", OLD."traceparent",
         OLD."producer_version", OLD."occurred_at", OLD."created_at",
         OLD."window_started_at", OLD."window_ends_at") THEN
    RAISE EXCEPTION 'tg_security_event_outbox_guard: refusal evidence columns are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."claim_count" < OLD."claim_count" THEN
    RAISE EXCEPTION 'tg_security_event_outbox_guard: claim_count never decreases'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."occurrence_count" IS DISTINCT FROM OLD."occurrence_count" THEN
    IF OLD."claim_count" > 0 OR NEW."claim_count" > 0 OR OLD."published_at" IS NOT NULL THEN
      RAISE EXCEPTION 'tg_security_event_outbox_guard: a claimed or published row cannot change its occurrence count'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."occurrence_count" < OLD."occurrence_count" THEN
      RAISE EXCEPTION 'tg_security_event_outbox_guard: occurrence_count never decreases'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "tg_security_event_outbox_guard"
  BEFORE UPDATE ON "security_event_outbox"
  FOR EACH ROW EXECUTE FUNCTION "security_event_outbox_guard"();
