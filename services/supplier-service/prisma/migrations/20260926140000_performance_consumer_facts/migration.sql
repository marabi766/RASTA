-- =============================================================================
-- supplier-service — ADR-052 step 5: what the marketplace consumer records that
-- the step-3 store could not hold.
--
-- Two additions, both storage only. Nothing here decides how a fact becomes a
-- score; that is step 6, and three of its rules are still with the owner
-- (docs/24 Q-77, Q-78, Q-79).
--
-- ## 1. `performance_event.dispute_id`
--
-- A dispute can be resolved more than once: marketplace has no compensating
-- event, so a re-attributed dispute arrives as a new `ORDER_DISPUTE_RESOLVED`
-- for the same `disputeId`. The project manager ruled (2026-09-26) that the
-- later resolution supersedes the earlier — latest by `occurred_at`, then by
-- `source_event_id` — and that **both rows are kept**. The order id cannot
-- tell two disputes on one order apart, so the dispute id is stored on the
-- fact itself, on DISPUTE_ABSENCE rows and nowhere else.
--
-- The rule is added `NOT VALID`: enforced on every row inserted from now on,
-- not checked against rows already present. No consumer wrote this table
-- before this migration, so a deployed database holds none; a developer
-- database may hold DISPUTE_ABSENCE rows that integration tests wrote, and the
-- table is append-only, so they cannot be backfilled and must not block the
-- migration.
--
-- ## 2. `performance_concluded_outcome`
--
-- One row per order that concluded through `ORDER_COMPLETED`. It belongs to no
-- component and carries no weight, which is why it is not a `performance_event`
-- row: every CHECK on that table is about a component. It is recorded because
-- one of the three answers to Q-78 — "all orders that finished in the window" —
-- needs a count of concluded orders, and a history not recorded now cannot be
-- rebuilt later from a topic that no longer retains it. Recording it decides
-- nothing: under the other two answers it is simply never read. Cancellations
-- are already recorded, as CANCELLATION_ABSENCE facts.
--
-- Tenant-scoped by the **supplier's** organization, like every performance fact.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE "performance_event" ADD COLUMN "dispute_id" TEXT;

-- A dispute id on exactly the DISPUTE_ABSENCE rows, and never a blank one.
ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_dispute"
  CHECK (
    ("component" = 'DISPUTE_ABSENCE') = ("dispute_id" IS NOT NULL)
    AND ("dispute_id" IS NULL OR "dispute_id" ~ '[^[:space:]]')
  ) NOT VALID;

-- The supersession read: a dispute's resolutions, in the order that decides
-- which one stands.
CREATE INDEX "ix_performance_event_dispute"
    ON "performance_event"("organization_id", "dispute_id", "occurred_at", "source_event_id")
 WHERE "dispute_id" IS NOT NULL;

CREATE TABLE "performance_concluded_outcome" (
    "id" TEXT NOT NULL,
    -- The supplier organization whose order concluded.
    "organization_id" TEXT NOT NULL,

    -- The source event's own `eventId` — the idempotency key (rule 8).
    "source_event_id" TEXT NOT NULL,
    "source_event_name" TEXT NOT NULL,

    -- ADR-052 § 6: the sample unit, the same key the component facts carry.
    "outcome_kind" "PerformanceOutcomeKind" NOT NULL,
    "outcome_key" TEXT NOT NULL,

    -- When the outcome concluded (the source envelope), and when it was
    -- recorded (this database's clock).
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "performance_concluded_outcome_pkey" PRIMARY KEY ("id")
);

-- Rule 8, as on `performance_event`: the source event id alone.
CREATE UNIQUE INDEX "ux_performance_concluded_outcome_source"
    ON "performance_concluded_outcome"("source_event_id");

-- The window scan, in ADR-052 § 10's total order.
CREATE INDEX "ix_performance_concluded_outcome_window"
    ON "performance_concluded_outcome"("organization_id", "occurred_at", "source_event_id");

ALTER TABLE "performance_concluded_outcome" ADD CONSTRAINT "ck_performance_concluded_outcome_text_not_blank"
  CHECK (
    "organization_id" ~ '[^[:space:]]'
    AND "source_event_id" ~ '[^[:space:]]'
    AND "source_event_name" ~ '[^[:space:]]'
    AND "outcome_key" ~ '[^[:space:]]'
    AND "correlation_id" ~ '[^[:space:]]'
  );

-- Append-only, for the same reason and in the same two halves as
-- `performance_event`: the row trigger never sees a TRUNCATE.
CREATE FUNCTION "performance_concluded_outcome_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'performance_concluded_outcome is append-only (% refused)',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_performance_concluded_outcome_append_only"
    BEFORE UPDATE OR DELETE ON "performance_concluded_outcome"
    FOR EACH ROW EXECUTE FUNCTION "performance_concluded_outcome_append_only"();

CREATE TRIGGER "trg_performance_concluded_outcome_no_truncate"
    BEFORE TRUNCATE ON "performance_concluded_outcome"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_concluded_outcome_append_only"();

-- The runtime role records and reads; it never updates, deletes or truncates
-- (20260926130000_supplier_runtime_privileges).
GRANT SELECT, INSERT ON "performance_concluded_outcome" TO rasta_supplier;
