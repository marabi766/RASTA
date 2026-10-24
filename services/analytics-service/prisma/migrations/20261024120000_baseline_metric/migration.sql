-- ADR-071 § 6 / Q-142 (1): storage only, no API, application writer or seed.
CREATE TABLE "baseline_metric" (
    "organization_id" VARCHAR(128) NOT NULL,
    "id" VARCHAR(128) NOT NULL,
    "version" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "metric_key" VARCHAR(64) NOT NULL,
    "scope_kind" VARCHAR(32) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "value" BIGINT NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "currency" CHAR(3),
    "source" VARCHAR(128) NOT NULL,
    "recorded_by" VARCHAR(128) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "baseline_metric_pkey" PRIMARY KEY ("organization_id", "id"),
    CONSTRAINT "ck_baseline_metric_ids" CHECK (
      btrim("organization_id") <> '' AND btrim("id") <> ''
      AND btrim("source") <> '' AND btrim("recorded_by") <> ''
    ),
    CONSTRAINT "ck_baseline_metric_key" CHECK ("metric_key" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "ck_baseline_metric_scope" CHECK ("scope_kind" IN ('ORGANIZATION', 'GOVERNANCE_ROOT')),
    CONSTRAINT "ck_baseline_metric_period" CHECK ("period_start" < "period_end"),
    CONSTRAINT "ck_baseline_metric_value" CHECK ("value" >= 0),
    CONSTRAINT "ck_baseline_metric_unit" CHECK ("unit" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
    CONSTRAINT "ck_baseline_metric_currency" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
);

-- Empty currency is forbidden by ck_baseline_metric_currency. Normalizing NULL
-- to '' gives the planner an equality pathkey; IS NULL alone cannot skip the
-- nullable currency key when satisfying ORDER BY version DESC on PostgreSQL 16.
CREATE INDEX "ix_baseline_metric_org_key_scope_period"
  ON "baseline_metric"("organization_id", "metric_key", "scope_kind", "unit", (COALESCE("currency", '')), "period_start", "period_end", "version" DESC);

CREATE FUNCTION "baseline_metric_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_baseline_metric_append_only: a baseline is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_baseline_metric_append_only"
  BEFORE UPDATE OR DELETE ON "baseline_metric"
  FOR EACH ROW EXECUTE FUNCTION "baseline_metric_append_only"();

CREATE TRIGGER "tg_baseline_metric_no_truncate"
  BEFORE TRUNCATE ON "baseline_metric"
  FOR EACH STATEMENT EXECUTE FUNCTION "baseline_metric_append_only"();

-- Reuse PR 1's database-clock stamping; a writer cannot backdate a version.
CREATE TRIGGER "tg_baseline_metric_recorded_at"
  BEFORE INSERT ON "baseline_metric"
  FOR EACH ROW EXECUTE FUNCTION "fact_recorded_at_now"();
