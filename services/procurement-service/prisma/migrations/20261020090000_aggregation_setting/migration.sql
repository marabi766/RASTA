-- =============================================================================
-- procurement-service — an organization's aggregation settings, versioned (COM-007 PR 3;
-- ADR-070 § 2, plan PR 3; docs/24 Q-10, Q-119 (2) and (3)).
--
-- 1. `aggregation_setting`: one row per version of an organization's settings — the window's
--    length in hours, its quantity threshold and its shortfall policy — and who recorded it, when,
--    under which correlation. Append-only: a version is never changed or erased, the next one
--    replaces it for windows opened afterwards. Versions run 1, 2, 3… per organization with no gap
--    (`aggregation_setting_guard`), so "the current version" is the largest, and two writers that
--    both read version n collide on the primary key instead of both becoming n + 1.
-- 2. The bounds of the plan's R2-1 (review of PR-300 round 2): the length 1 to 8760 hours, the
--    threshold 0 to MAX_QUANTITY (2147483647) — a threshold above the most a window can hold would
--    never be reached and EXTEND would extend it forever — the policy EXTEND, REFER or CLOSE. The
--    same bounds as the environment defaults and as `ck_demand_aggregation_snapshot`.
-- 3. A window that names a setting version (`setting_version`, NULL = the environment defaults of
--    Q-10, as PR 1 and 2 wrote every window) names one of its own organization's
--    (`fk_demand_aggregation_setting`), and its snapshot is exactly that version's values
--    (`demand_aggregation_snapshot_guard`, on INSERT: `demand_aggregation_guard` already keeps the
--    snapshot from changing afterwards).
-- =============================================================================

CREATE TABLE "aggregation_setting" (
    "organization_id"  TEXT NOT NULL,
    "version"          INTEGER NOT NULL,
    "window_hours"     INTEGER NOT NULL,
    "min_quantity"     INTEGER NOT NULL,
    "shortfall_policy" TEXT NOT NULL,
    "recorded_by"      TEXT NOT NULL,
    "recorded_at"      TIMESTAMPTZ(3) NOT NULL,
    "correlation_id"   TEXT NOT NULL,

    CONSTRAINT "aggregation_setting_pkey" PRIMARY KEY ("organization_id", "version"),
    CONSTRAINT "ck_aggregation_setting_values"
        CHECK ("version" >= 1
               AND "window_hours" BETWEEN 1 AND 8760
               AND "min_quantity" BETWEEN 0 AND 2147483647
               AND "shortfall_policy" IN ('EXTEND', 'REFER', 'CLOSE')),
    CONSTRAINT "ck_aggregation_setting_recorded"
        CHECK (btrim("organization_id") <> '' AND btrim("recorded_by") <> ''
               AND btrim("correlation_id") <> '')
);

-- A version is the next one of its organization, and is never changed or erased.
CREATE FUNCTION "aggregation_setting_guard"() RETURNS trigger AS $$
DECLARE
  current_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max("version") INTO current_version
      FROM "aggregation_setting" WHERE "organization_id" = NEW."organization_id";
    IF NEW."version" <> coalesce(current_version, 0) + 1 THEN
      RAISE EXCEPTION 'ck_aggregation_setting_next_version: version % of an organization at version %',
        NEW."version", coalesce(current_version, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_aggregation_setting_append_only: a setting version is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_aggregation_setting_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "aggregation_setting"
  FOR EACH ROW EXECUTE FUNCTION "aggregation_setting_guard"();

CREATE TRIGGER "tg_aggregation_setting_no_truncate"
  BEFORE TRUNCATE ON "aggregation_setting"
  FOR EACH STATEMENT EXECUTE FUNCTION "aggregation_setting_guard"();

-- A window names a version of its own organization (NULL: the environment defaults).
ALTER TABLE "demand_aggregation"
  ADD CONSTRAINT "fk_demand_aggregation_setting"
  FOREIGN KEY ("organization_id", "setting_version")
  REFERENCES "aggregation_setting" ("organization_id", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ...and holds exactly that version's values.
CREATE FUNCTION "demand_aggregation_snapshot_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."setting_version" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "aggregation_setting" AS s
        WHERE s."organization_id" = NEW."organization_id" AND s."version" = NEW."setting_version"
          AND s."window_hours" = NEW."window_hours" AND s."min_quantity" = NEW."min_quantity"
          AND s."shortfall_policy" = NEW."shortfall_policy")
  THEN
    RAISE EXCEPTION 'ck_demand_aggregation_snapshot_setting: a window''s snapshot is the setting version it names'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_demand_aggregation_snapshot"
  BEFORE INSERT ON "demand_aggregation"
  FOR EACH ROW EXECUTE FUNCTION "demand_aggregation_snapshot_guard"();
