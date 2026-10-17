-- =============================================================================
-- procurement-service — initial migration (COM-007 PR 1, ADR-070).
--
-- An organization's demand requests and the demand aggregation each joins, the
-- service's own idempotency store, and the platform's outbox. The outbox arrives
-- folded into this one migration, as contract-service's and inventory-service's
-- did: its objects are verified by `scripts/verify-migration-reversible.mjs
-- procurement` (EXPECTED.procurement), not by the by-name outbox verifiers
-- (`verify-outbox-claim-migration.mjs` lists it as folded).
--
-- Statuses are TEXT under a CHECK naming every status of the lifecycle, the later
-- PRs' included — never an enum, whose values cannot be rolled back (ADR-068 § 2).
-- Every instant is TIMESTAMPTZ(3) from the start (D-048).
-- =============================================================================

-- CreateTable
CREATE TABLE "demand_aggregation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "window_hours" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "shortfall_policy" TEXT NOT NULL,
    "setting_version" INTEGER,
    "total_quantity" BIGINT NOT NULL,
    "demand_count" INTEGER NOT NULL,
    "extension_count" INTEGER NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "rfq_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "demand_aggregation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "aggregation_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "submitted_correlation_id" TEXT NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by" TEXT,
    "withdraw_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "demand_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id", "endpoint", "key")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "organization_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMPTZ(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_stream_sequence" (
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic","partition_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_demand_aggregation_org_id" ON "demand_aggregation"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_demand_aggregation_org_status" ON "demand_aggregation"("organization_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_demand_request_org_id" ON "demand_request"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_demand_request_org_status" ON "demand_request"("organization_id", "status", "id");

-- CreateIndex
CREATE INDEX "ix_demand_request_aggregation" ON "demand_request"("organization_id", "aggregation_id", "status");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- demand_aggregation ----------------------------------------------------------

-- At most one OPEN window per (organization, product) (ADR-070 § 2). Partial on purpose: the
-- windows that ended stay, any number of them. Not declared in schema.prisma: Prisma has no
-- syntax for an index predicate. Two first demands of one product race on this index; the loser
-- waits for the winner's commit and joins its window.
CREATE UNIQUE INDEX "ux_demand_aggregation_open"
    ON "demand_aggregation" ("organization_id", "product_id")
 WHERE "status" = 'OPEN';

-- The target of a demand's reference: the organization AND the product with the id, so a demand
-- can only join a window of its own organization and of its own product.
CREATE UNIQUE INDEX "ux_demand_aggregation_org_id_product"
    ON "demand_aggregation" ("organization_id", "id", "product_id");

-- Every status of the lifecycle, the later PRs' included (ADR-070 § 2).
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_status"
  CHECK ("status" IN ('OPEN', 'READY', 'RFQ_ISSUED', 'REFERRED', 'LAPSED', 'CANCELLED'));

-- An opaque identifier is present, and the product is marketplace's shape (never checked there, Q-105).
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_identifiers"
  CHECK (btrim("id") <> '' AND btrim("organization_id") <> ''
         AND "product_id" ~ '^PRD_[0-9A-HJKMNP-TV-Z]{26}$');

-- The window is half-open and has a length: [opened_at, closes_at).
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_window"
  CHECK ("closes_at" > "opened_at" AND "window_hours" BETWEEN 1 AND 8760);

-- The snapshot of the settings the window opened with (Q-10): a quantity, never an amount, and a
-- policy from the closed set. The threshold is at most MAX_QUANTITY, the most the window can hold
-- (PR-300 r2 R2-1): a higher one could never be reached.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_snapshot"
  CHECK ("min_quantity" BETWEEN 0 AND 2147483647
         AND "shortfall_policy" IN ('EXTEND', 'REFER', 'CLOSE')
         AND ("setting_version" IS NULL OR "setting_version" >= 1));

-- The window's contents: no negative total, and a total exactly when there is a demand (every
-- demand's quantity is positive). The total never passes MAX_QUANTITY, the integer an RFQ and a
-- purchase order state it in (ADR-070 § 2): the column is a bigint only so the sum cannot overflow
-- before this CHECK sees it; the service refuses such a demand first (422).
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_counts"
  CHECK ("total_quantity" BETWEEN 0 AND 2147483647
         AND "demand_count" >= 0 AND "extension_count" >= 0
         AND (("demand_count" = 0) = ("total_quantity" = 0)));

-- A window that ended says when; an open one has not.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_closed"
  CHECK ((("status" = 'OPEN') = ("closed_at" IS NULL))
         AND ("closed_at" IS NULL OR "closed_at" >= "opened_at"));

-- An RFQ is named exactly when one was issued from the window (ADR-070 plan PR 6).
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_rfq"
  CHECK (("status" = 'RFQ_ISSUED') = ("rfq_id" IS NOT NULL));

ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "demand_aggregation" ADD CONSTRAINT "ck_demand_aggregation_timestamps_ordered"
  CHECK ("updated_at" >= "created_at" AND "opened_at" >= "created_at");

-- ---- demand_request --------------------------------------------------------------

-- Same organization, same product (Q-119 (1), provisional): a demand joins a window of the
-- organization that registered it and of the product it asks for, and of nothing else.
ALTER TABLE "demand_request" ADD CONSTRAINT "fk_demand_request_aggregation"
  FOREIGN KEY ("organization_id", "aggregation_id", "product_id")
  REFERENCES "demand_aggregation" ("organization_id", "id", "product_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_status"
  CHECK ("status" IN ('SUBMITTED', 'WITHDRAWN', 'REFERRED', 'LAPSED'));

ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_identifiers"
  CHECK (btrim("id") <> '' AND btrim("organization_id") <> '' AND btrim("aggregation_id") <> ''
         AND "product_id" ~ '^PRD_[0-9A-HJKMNP-TV-Z]{26}$');

-- A whole, positive quantity of the product's base unit (Q-105, Q-120).
ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_quantity_positive"
  CHECK ("quantity" > 0);

-- The optional note is bounded; blank is absent.
ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_note"
  CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 500);

-- Every demand names who registered it and the request it came from (AGENTS.md S-06).
ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_actor_recorded"
  CHECK (btrim("submitted_by") <> '' AND btrim("submitted_correlation_id") <> '');

-- A withdrawal names when, who and why — all three, and only on a withdrawn demand.
ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_withdrawal"
  CHECK ((("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL))
         AND num_nonnulls("withdrawn_at", "withdrawn_by", "withdraw_reason") IN (0, 3)
         AND ("withdrawn_by" IS NULL OR btrim("withdrawn_by") <> '')
         AND ("withdraw_reason" IS NULL OR char_length(btrim("withdraw_reason")) BETWEEN 8 AND 500));

-- A demand that followed its window's end (REFERRED, LAPSED) says when.
ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_closed"
  CHECK (("status" IN ('REFERRED', 'LAPSED')) = ("closed_at" IS NOT NULL));

ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "demand_request" ADD CONSTRAINT "ck_demand_request_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "submitted_at")
         AND ("closed_at" IS NULL OR "closed_at" >= "submitted_at"));

-- ---- idempotency_key -------------------------------------------------------------

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
  ADD CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
  ADD CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
  ADD CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
    "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  );

-- =============================================================================
-- The lifecycles the database keeps (ADR-063 § 1)
-- =============================================================================
--
-- The code moves a row by a compare-and-set against the transition tables of
-- `src/demand/demand.state-machine.ts`; these guards refuse what that table does not
-- have, and what a row was made from, even from a future write path that forgets it.
-- Nothing here is ever deleted or truncated: an audit reads it. The runtime role owns
-- nothing and cannot disable them (D-045).

CREATE FUNCTION "demand_aggregation_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
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
    -- The window's contents are frozen once it ended (ADR-070 § 2): the demand set is final.
    IF OLD."status" <> 'OPEN'
       AND (NEW."total_quantity" IS DISTINCT FROM OLD."total_quantity"
            OR NEW."demand_count" IS DISTINCT FROM OLD."demand_count"
            OR NEW."closes_at" IS DISTINCT FROM OLD."closes_at"
            OR NEW."extension_count" IS DISTINCT FROM OLD."extension_count")
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_frozen: a window that ended keeps its contents'
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

CREATE TRIGGER "tg_demand_aggregation_guard"
  BEFORE UPDATE OR DELETE ON "demand_aggregation"
  FOR EACH ROW EXECUTE FUNCTION "demand_aggregation_guard"();

CREATE TRIGGER "tg_demand_aggregation_no_truncate"
  BEFORE TRUNCATE ON "demand_aggregation"
  FOR EACH STATEMENT EXECUTE FUNCTION "demand_aggregation_guard"();

-- A demand joins only an OPEN window, inside it: at or after `closes_at` it never joins that
-- window, whatever the status still says (ADR-070 § 2). It leaves (WITHDRAWN) only while the
-- window is OPEN and before its end, and follows the window's end (REFERRED, LAPSED) only with
-- it. The window row is the caller's to lock first (it is: `FOR UPDATE` before any demand
-- write), so reading it here sees the transaction's own change.
CREATE FUNCTION "demand_request_guard"() RETURNS trigger AS $$
DECLARE
  window_status TEXT;
  window_opened TIMESTAMPTZ;
  window_closes TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ck_demand_request_not_erasable: a demand is never deleted or truncated (% refused)', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "status", "opened_at", "closes_at" INTO window_status, window_opened, window_closes
    FROM "demand_aggregation"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."aggregation_id";

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SUBMITTED' OR NEW."version" <> 1
       OR NEW."withdrawn_at" IS NOT NULL OR NEW."closed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_demand_request_initial: a demand is registered SUBMITTED, version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF window_status IS DISTINCT FROM 'OPEN'
       OR NEW."submitted_at" < window_opened OR NEW."submitted_at" >= window_closes THEN
      RAISE EXCEPTION 'ck_demand_request_joins_open_window: a demand joins an OPEN window, within [opened_at, closes_at)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."aggregation_id" IS DISTINCT FROM OLD."aggregation_id"
     OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
     OR NEW."submitted_correlation_id" IS DISTINCT FROM OLD."submitted_correlation_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'ck_demand_request_origin_immutable: a demand is never edited; withdraw it and register another'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'SUBMITTED' OR NEW."status" = OLD."status" THEN
    RAISE EXCEPTION 'ck_demand_request_transition: % -> % is not a transition', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'ck_demand_request_version: every change moves the version by one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'WITHDRAWN'
     AND (window_status IS DISTINCT FROM 'OPEN' OR NEW."withdrawn_at" >= window_closes) THEN
    RAISE EXCEPTION 'ck_demand_request_withdraw_window: a demand is withdrawn only while its window is OPEN and before it ends'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('REFERRED', 'LAPSED') AND window_status IS DISTINCT FROM NEW."status" THEN
    RAISE EXCEPTION 'ck_demand_request_follows_window: a demand is % only with its window', NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_demand_request_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "demand_request"
  FOR EACH ROW EXECUTE FUNCTION "demand_request_guard"();

CREATE TRIGGER "tg_demand_request_no_truncate"
  BEFORE TRUNCATE ON "demand_request"
  FOR EACH STATEMENT EXECUTE FUNCTION "demand_request_guard"();

-- The window's total and count are its demands', at commit: the sum and the count of every
-- demand that joined it and was not withdrawn. A demand written without its window, or a window
-- total moved without its demand, is refused when the transaction commits — deferred, so the
-- two writes of one command may come in either order.
--
-- Only a write that can change what is compared rescans the window (PR-327 r1 F1): an insert, a
-- demand that leaves or rejoins the counted set (WITHDRAWN) or moves quantity, organization or
-- window, and a window whose stated total or count moved. A window's end moves every live demand
-- SUBMITTED → REFERRED or LAPSED and the window's status only — counted before and after — so
-- those rows return at once instead of each rescanning the window: closing N demands is N
-- constant checks and no rescan, not N rescans of N demands. Each event keeps the OLD and NEW of
-- its own row even when deferred, so the skip judges exactly the change that queued it.
--
-- The rescan reads the counted demands and nothing else (PR-327 r3 F1). The live-demand limit
-- bounds what a window counts, not what it ever held: a withdrawal frees a place but its row
-- stays, so submit-and-withdraw keeps a window small while its history grows without end. The
-- counted set is read status by status, each one equality range of `ix_demand_request_aggregation`
-- (organization, window, status). `<> 'WITHDRAWN'` is no range of any index: it was read as the
-- window's whole range with every withdrawn row filtered out — under the window's lock, twice for
-- every submit and withdrawal. Nor is `IN (…)` safe: on a table it has no column statistics for,
-- the planner kept the list out of the index condition and filtered the same whole range. An
-- equality on all three columns is always the index condition. `ck_demand_request_status` allows
-- one status more, WITHDRAWN, the one not counted: a status added there that counts must be added
-- here too.
CREATE FUNCTION "demand_aggregation_totals_check"() RETURNS trigger AS $$
DECLARE
  target_org TEXT;
  target_id TEXT;
  stated_total BIGINT;
  stated_count INTEGER;
  actual_total BIGINT;
  actual_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'demand_request' THEN
      IF (OLD."status" = 'WITHDRAWN') = (NEW."status" = 'WITHDRAWN')
         AND NEW."quantity" = OLD."quantity"
         AND NEW."organization_id" = OLD."organization_id"
         AND NEW."aggregation_id" = OLD."aggregation_id" THEN
        RETURN NULL;
      END IF;
    ELSIF NEW."total_quantity" = OLD."total_quantity"
          AND NEW."demand_count" = OLD."demand_count"
          AND NEW."organization_id" = OLD."organization_id"
          AND NEW."id" = OLD."id" THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'demand_request' THEN
    target_org := NEW."organization_id";
    target_id := NEW."aggregation_id";
  ELSE
    target_org := NEW."organization_id";
    target_id := NEW."id";
  END IF;

  SELECT "total_quantity", "demand_count" INTO stated_total, stated_count
    FROM "demand_aggregation"
   WHERE "organization_id" = target_org AND "id" = target_id;

  SELECT COALESCE(SUM(counted."quantity"), 0), COUNT(*) INTO actual_total, actual_count
    FROM (SELECT "quantity" FROM "demand_request"
           WHERE "organization_id" = target_org AND "aggregation_id" = target_id
             AND "status" = 'SUBMITTED'
          UNION ALL
          SELECT "quantity" FROM "demand_request"
           WHERE "organization_id" = target_org AND "aggregation_id" = target_id
             AND "status" = 'REFERRED'
          UNION ALL
          SELECT "quantity" FROM "demand_request"
           WHERE "organization_id" = target_org AND "aggregation_id" = target_id
             AND "status" = 'LAPSED') AS counted;

  IF stated_total IS DISTINCT FROM actual_total OR stated_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'ck_demand_aggregation_totals: a window''s total and count are its demands'''
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_demand_aggregation_totals_check"
  AFTER INSERT OR UPDATE ON "demand_aggregation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "demand_aggregation_totals_check"();

CREATE CONSTRAINT TRIGGER "tg_demand_request_totals_check"
  AFTER INSERT OR UPDATE ON "demand_request"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "demand_aggregation_totals_check"();

-- =============================================================================
-- Transactional outbox — the claim and stream objects Prisma cannot declare
-- =============================================================================

-- ---- ADR-050 CHECK constraints ----------------------------------------------

-- An active claim carries all three parts or none. Two of three describes a row
-- that has no fence, or no expiry, or looks unowned to the metrics while
-- somebody is publishing it.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- A published row holds no claim metadata and no scheduled retry. This is also
-- what makes `purgePublished` safe: it can never delete a row some worker still
-- holds a live lease on.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

-- `next_attempt_at` only means something for an unpublished row that has
-- already failed at least once.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- ---- ADR-050 claim indexes --------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_outbox_claimable"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_claim_expiry"
    ON "outbox_message" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_next_attempt"
    ON "outbox_message" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-050 eligibility-stream indexes -------------------------------------
--
-- The four streams `claimPendingSql` selects from. `now()` is stable rather
-- than immutable, so the planner cannot estimate `<= now()` and falls back to
-- 33% selectivity; these remove the estimate from the decision by making each
-- stream's eligibility test either statically true or a range on that index's
-- own leading column.

CREATE INDEX IF NOT EXISTS "ix_outbox_due_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-051 -----------------------------------------------------------------
--
-- The partial unique index and the four head indexes, at the definitions
-- `scripts/verify-outbox-b1-lib.mjs` asserts. The head indexes stay empty:
-- `is_stream_head` is false on every row this service writes (B4 is not merged).

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL. That is a total write outage, and it passes an
-- existence check.
--
-- Not declared in schema.prisma: Prisma has no syntax for an index predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_outbox_stream_seq"
    ON "outbox_message" ("topic", "partition_key", "stream_seq")
 WHERE "stream_seq" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_head_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";
