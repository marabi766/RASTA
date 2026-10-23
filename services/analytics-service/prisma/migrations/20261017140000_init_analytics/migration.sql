-- =============================================================================
-- analytics-service — initial schema (RUN-001 PR 1, ADR-071).
--
-- Two tables: the first fact and the consumer's idempotency marker. No outbox —
-- this service publishes nothing (ADR-071 § 1). Every instant is timestamptz(3)
-- from the first migration (D-048).
-- =============================================================================

-- ---- processed_event: which event each consumer already applied (docs/07 § 7.5) --

CREATE TABLE "processed_event" (
    "event_id" VARCHAR(128) NOT NULL,
    "consumer_name" VARCHAR(128) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id", "consumer_name"),
    CONSTRAINT "ck_processed_event_ids" CHECK (btrim("event_id") <> '' AND btrim("consumer_name") <> '')
);

-- ---- fact_maintenance: one completed maintenance request (MAINTENANCE_COMPLETED) --
--
-- Keyed by the organization and the request, so a second event about the same
-- completion can never make a second row. The CHECKs restate what the consumer
-- validates, so a writer that bypassed it still cannot store a negative cost, a
-- negative downtime or a blank identifier.

CREATE TABLE "fact_maintenance" (
    "organization_id" VARCHAR(128) NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "asset_id" VARCHAR(128) NOT NULL,
    "maintenance_type" VARCHAR(64) NOT NULL,
    "schedule_id" VARCHAR(128),
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    "downtime_minutes" INTEGER,
    "total_cost_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source_event_id" VARCHAR(128) NOT NULL,
    -- When the fact became visible to analytics: the database clock at the insert, never the
    -- transaction's start (`now()`) and never a value a writer supplies (tg_fact_maintenance_
    -- recorded_at). A governance release cut takes the table in SHARE mode and stamps
    -- clock_timestamp(), so a fact is in the cut exactly when it was recorded before it, and
    -- one recorded after it is late (ADR-071 § 2 (8), § 5 (5)).
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "fact_maintenance_pkey" PRIMARY KEY ("organization_id", "request_id"),
    CONSTRAINT "ck_fact_maintenance_ids" CHECK (
      btrim("organization_id") <> '' AND btrim("request_id") <> '' AND btrim("asset_id") <> ''
      AND btrim("source_event_id") <> '' AND ("schedule_id" IS NULL OR btrim("schedule_id") <> '')
    ),
    CONSTRAINT "ck_fact_maintenance_type" CHECK ("maintenance_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "ck_fact_maintenance_downtime_nonneg" CHECK ("downtime_minutes" IS NULL OR "downtime_minutes" >= 0),
    CONSTRAINT "ck_fact_maintenance_cost_nonneg" CHECK ("total_cost_minor" >= 0),
    CONSTRAINT "ck_fact_maintenance_currency" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- The fleet dashboard's one read: an organization's completions in a window.
CREATE INDEX "ix_fact_maintenance_org_completed" ON "fact_maintenance"("organization_id", "completed_at");

-- A fact is never changed or erased: a contradictory event is dead-lettered by the
-- consumer, never written over the fact it contradicts (ADR-071 § 2).
CREATE FUNCTION "fact_maintenance_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_fact_maintenance_append_only: a fact is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_fact_maintenance_append_only"
  BEFORE UPDATE OR DELETE ON "fact_maintenance"
  FOR EACH ROW EXECUTE FUNCTION "fact_maintenance_append_only"();

CREATE TRIGGER "tg_fact_maintenance_no_truncate"
  BEFORE TRUNCATE ON "fact_maintenance"
  FOR EACH STATEMENT EXECUTE FUNCTION "fact_maintenance_append_only"();

-- `recorded_at` is the database's own clock at the insert, whatever the writer sent: the
-- column default alone would accept a supplied (or backdated) instant.
CREATE FUNCTION "fact_recorded_at_now"() RETURNS trigger AS $$
BEGIN
  NEW."recorded_at" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_fact_maintenance_recorded_at"
  BEFORE INSERT ON "fact_maintenance"
  FOR EACH ROW EXECUTE FUNCTION "fact_recorded_at_now"();
