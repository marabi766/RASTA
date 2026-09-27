-- =============================================================================
-- supplier-service — ADR-052 Phase B step 3: the performance-event store.
--
-- One row per source event that was counted toward a supplier's performance.
-- `processed_event` (ADR-032) says "this consumer saw the event"; this table
-- says "this fact was counted" — separate on purpose, and neither replaces the
-- other (ADR-052 § 11).
--
-- ## What the database refuses
--
--   * a second row for one source event — UNIQUE (source_event_id), the
--     idempotency key of ADR-052 rule 8. Redelivery is an
--     `INSERT ... ON CONFLICT DO NOTHING` and moves nothing;
--   * any UPDATE, DELETE or TRUNCATE — the store is append-only. A wrong fact
--     is neutralised by a compensating row that names it (ADR-052 § 14);
--   * a responsibility outside the closed set, or a missing one where the
--     component is attributed — and one where it is not;
--   * a measurement that does not fit its component (below);
--   * a QUALITY row: nothing produces one until Q-56 is answered, so a row
--     here could only be a fact nobody decided how to measure.
--
-- ## One row per source event, so ON_TIME is two rows
--
-- The promise and the delivery arrive on different events
-- (`ORDER_CREATED.promisedDeliveryAt`, `ORDER_FULFILLED.fulfilledAt`), and a
-- source event maps to at most one row. So an ON_TIME row carries exactly one
-- of `promised_at` / `delivered_at`, and the calculation (step 6) pairs them by
-- outcome key. Nothing here decides how lateness becomes a score.
--
-- Tenant-scoped by the **supplier's** organization, the subject of the fact.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

-- ADR-052 § 4, rule 13 — the same closed set marketplace publishes on
-- `ORDER_DISPUTE_RESOLVED.responsibility` and `ORDER_CANCELLED.cancellationCause`.
-- UNDETERMINED is a value, not an absence: it is stored, and excluded from the
-- denominator rather than counted as zero.
CREATE TYPE "ResponsibilityAttribution" AS ENUM ('SUPPLIER', 'BUYER', 'PLATFORM', 'UNDETERMINED');

-- ADR-052 § 6: what the sample unit is keyed by.
CREATE TYPE "PerformanceOutcomeKind" AS ENUM ('ORDER', 'REPAIR_ORDER');

CREATE TABLE "performance_event" (
    "id" TEXT NOT NULL,
    -- The supplier organization this fact is about (`supplierOrganizationId`
    -- or `workshopOrganizationId` in the source payload).
    "organization_id" TEXT NOT NULL,

    -- The source event's own `eventId` — the idempotency key (rule 8).
    "source_event_id" TEXT NOT NULL,
    "source_event_name" TEXT NOT NULL,

    "component" "PerformanceComponent" NOT NULL,

    -- ADR-052 § 6: several events of one order are one sample.
    "outcome_kind" "PerformanceOutcomeKind" NOT NULL,
    "outcome_key" TEXT NOT NULL,

    -- The measured fact, raw. Never a score: how a rating or a delay becomes
    -- 0..100 is the formula version's business, so a new version can re-read
    -- the same history (ADR-052 § 12).
    "responsibility" "ResponsibilityAttribution",
    "rating" SMALLINT,
    "promised_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    -- ADR-052 § 14: a correction is a new row that names the one it corrects.
    "compensates_source_event_id" TEXT,

    -- When the fact happened (the source envelope), and when it was counted
    -- (this database's clock — D-5).
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "performance_event_pkey" PRIMARY KEY ("id")
);

-- Rule 8. Deliberately the source event id alone, not widened with the
-- organization: widening it would let one event be counted twice under two
-- tenants. A single-column index, so the tenant-leading rule for composite
-- indexes does not apply.
CREATE UNIQUE INDEX "ux_performance_event_source"
    ON "performance_event"("source_event_id");

-- The target of a compensation's foreign key: a correction must name a fact of
-- the same supplier and the same component.
CREATE UNIQUE INDEX "ux_performance_event_compensation_target"
    ON "performance_event"("organization_id", "component", "source_event_id");

-- ADR-052 § 10: the window scan, in the total order the calculation uses.
CREATE INDEX "ix_performance_event_window"
    ON "performance_event"("organization_id", "occurred_at", "source_event_id");

-- ADR-052 § 6: distinct outcome keys.
CREATE INDEX "ix_performance_event_outcome"
    ON "performance_event"("organization_id", "outcome_kind", "outcome_key");

CREATE INDEX "ix_performance_event_compensates"
    ON "performance_event"("organization_id", "compensates_source_event_id")
 WHERE "compensates_source_event_id" IS NOT NULL;

ALTER TABLE "performance_event" ADD CONSTRAINT "performance_event_compensates_fkey"
  FOREIGN KEY ("organization_id", "component", "compensates_source_event_id")
  REFERENCES "performance_event"("organization_id", "component", "source_event_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_not_self_compensating"
  CHECK ("compensates_source_event_id" IS NULL OR "compensates_source_event_id" <> "source_event_id");

-- Q-56: no producer, no measurement, no row.
ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_quality_unmeasured"
  CHECK ("component" <> 'QUALITY');

-- Rule 13: attribution exists exactly where the component is about fault.
ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_responsibility"
  CHECK (
    ("component" IN ('DISPUTE_ABSENCE', 'CANCELLATION_ABSENCE')) = ("responsibility" IS NOT NULL)
  );

-- `REVIEW_SUBMITTED.rating` is 1..5 in marketplace's published contract.
ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_rating"
  CHECK (
    ("component" = 'CUSTOMER_SATISFACTION') = ("rating" IS NOT NULL)
    AND ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
  );

-- ON_TIME carries exactly one side of the pair; nothing else carries either.
ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_timeliness"
  CHECK (
    CASE WHEN "component" = 'ON_TIME'
      THEN num_nonnulls("promised_at", "delivered_at") = 1
      ELSE num_nonnulls("promised_at", "delivered_at") = 0
    END
  );

ALTER TABLE "performance_event" ADD CONSTRAINT "ck_performance_event_text_not_blank"
  CHECK (
    "organization_id" ~ '[^[:space:]]'
    AND "source_event_id" ~ '[^[:space:]]'
    AND "source_event_name" ~ '[^[:space:]]'
    AND "outcome_key" ~ '[^[:space:]]'
    AND "correlation_id" ~ '[^[:space:]]'
  );

-- ---------------------------------------------------------------------------
-- Append-only. The row-level trigger refuses UPDATE and DELETE; TRUNCATE is
-- statement-level and never reaches a row trigger, so it has its own.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'performance_event is append-only (% refused); correct a fact with a compensating event',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_performance_event_append_only"
    BEFORE UPDATE OR DELETE ON "performance_event"
    FOR EACH ROW EXECUTE FUNCTION "performance_event_append_only"();

CREATE TRIGGER "trg_performance_event_no_truncate"
    BEFORE TRUNCATE ON "performance_event"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_event_append_only"();
