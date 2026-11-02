BEGIN;

-- ADR-071 § 6 / Q-154 (D-082): from which instant the maintenance-facts projection is complete.
--
-- ONE row per projection (consumer), deployment-wide, written once by the service the first
-- time the consumer has started successfully. This migration NEVER inserts that row: an
-- existing deployment's coverage starts at its upgrade, so every older window reads as NO_DATA
-- — honest, because nothing proves the projection saw those instants.
CREATE TABLE "projection_coverage" (
    "consumer_name" VARCHAR(128) NOT NULL,
    "covered_from" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "projection_coverage_pkey" PRIMARY KEY ("consumer_name"),
    CONSTRAINT "ck_projection_coverage_name" CHECK (btrim("consumer_name") <> '')
);

-- Written once, never moved: not earlier (which would vouch for an instant nobody observed) and
-- not later (which would hide a window the projection did cover). Insert-if-absent is the only
-- write; TRUNCATE is refused to the owner as well.
CREATE FUNCTION "projection_coverage_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_projection_coverage_append_only: a coverage start is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_projection_coverage_append_only"
  BEFORE UPDATE OR DELETE ON "projection_coverage"
  FOR EACH ROW EXECUTE FUNCTION "projection_coverage_append_only"();

CREATE TRIGGER "tg_projection_coverage_no_truncate"
  BEFORE TRUNCATE ON "projection_coverage"
  FOR EACH STATEMENT EXECUTE FUNCTION "projection_coverage_append_only"();

-- The database's own clock at the insert, whatever the writer sent: a supplied or backdated
-- instant cannot claim coverage the projection never had.
CREATE FUNCTION "projection_coverage_started_now"() RETURNS trigger AS $$
BEGIN
  NEW."covered_from" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_projection_coverage_started_at"
  BEFORE INSERT ON "projection_coverage"
  FOR EACH ROW EXECUTE FUNCTION "projection_coverage_started_now"();

-- Explicit runtime grants (the privilege migration revoked the table defaults): the consumer
-- inserts the row, the KPI read selects it. No UPDATE, no DELETE.
REVOKE ALL ON "projection_coverage" FROM rasta_analytics;
GRANT SELECT, INSERT ON "projection_coverage" TO rasta_analytics;

COMMIT;
