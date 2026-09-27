-- =============================================================================
-- supplier-service — ADR-052 Phase B step 4: the score snapshot.
--
-- Every computation is a new row; nothing is ever overwritten (ADR-052 § 12).
-- A snapshot carries all of § 8's provenance, in integer columns rather than
-- JSON so "no float anywhere" (§ 7, § 24) is a property of the schema:
--
--   performance_score_snapshot      formulaVersion, window, calculatedAt,
--                                   status, scoreCentis, eligibleSampleCount,
--                                   coverageBp
--   performance_score_component     componentScores and effectiveWeights, one
--                                   row per component the formula weighs —
--                                   an absent component is NULL, never 0
--   performance_score_source_event  sourceEventIds
--
-- ## What the database refuses
--
--   * any UPDATE, DELETE or TRUNCATE of the three tables;
--   * a child row added after its snapshot's own transaction — a snapshot is
--     complete when it commits, or it is not a snapshot;
--   * a score on anything but PUBLISHED, and a PUBLISHED row without one;
--   * a status its numbers contradict: PUBLISHED below either threshold of its
--     formula version, INSUFFICIENT_COVERAGE at or above the coverage
--     threshold, INSUFFICIENT_DATA at or above the minimum sample;
--   * a snapshot of a DRAFT version, whose weights could still change under it;
--   * a window that is not exactly its version's `window_days` long, and a
--     present component that counted no sample;
--   * provenance that does not add up, at commit: a component row for every
--     weighted component and no other, its configured weight equal to the
--     version's, `coverage_bp` equal to the configured weight of the available
--     components, and each effective weight equal to
--     half-up(configured × 10 000 ÷ coverage) — the exact pair is stored, the
--     rounded value is for display (PM ruling on the column shape);
--   * a source event of another tenant.
--
-- What it does not decide: which status wins when both thresholds fail, and
-- how facts become a component score. Those are the calculation (step 6).
--
-- ## What these checks do NOT prove (Codex review of #120, round 2)
--
-- They are structural. They do not recompute anything, so they cannot tell
-- that `score_centis` is the weighted sum of the component scores, that a
-- component score follows from its facts, or that the cited source events are
-- exactly the ones the sample counts were taken from. That consistency is the
-- step-6 engine's to guarantee, and it is not claimed here: a snapshot this
-- table accepts is well-formed, not proven correct.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PerformanceScoreStatus" AS ENUM ('PUBLISHED', 'INSUFFICIENT_DATA', 'INSUFFICIENT_COVERAGE');

-- Targets for the composite foreign keys below: they let a snapshot name its
-- version number consistently, and let a child row name its tenant.
CREATE UNIQUE INDEX "ux_performance_formula_version_identity"
    ON "performance_formula_version"("id", "formula_version");

CREATE UNIQUE INDEX "ux_performance_event_tenant_source"
    ON "performance_event"("organization_id", "source_event_id");

CREATE TABLE "performance_score_snapshot" (
    "id" TEXT NOT NULL,
    -- The supplier organization scored.
    "organization_id" TEXT NOT NULL,

    "formula_version_id" TEXT NOT NULL,
    "formula_version" INTEGER NOT NULL,

    -- ADR-052 § 9: half-open [window_start, window_end), UTC.
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    -- The database clock (D-5).
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "status" "PerformanceScoreStatus" NOT NULL,
    -- ADR-052 § 7: hundredths of the 0..100 scale. NULL unless PUBLISHED —
    -- never 0 standing in for "no score".
    "score_centis" INTEGER,
    -- ADR-052 § 6: distinct outcome keys, not raw events.
    "eligible_sample_count" INTEGER NOT NULL,
    -- ADR-052 § 5: configured weight of the components that had data.
    "coverage_bp" INTEGER NOT NULL,

    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "performance_score_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "performance_score_snapshot_version_fkey"
      FOREIGN KEY ("formula_version_id", "formula_version")
      REFERENCES "performance_formula_version"("id", "formula_version")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ux_performance_score_snapshot_tenant"
    ON "performance_score_snapshot"("organization_id", "id");

-- The latest snapshot of a supplier: newest first, with a total order.
CREATE INDEX "ix_performance_score_snapshot_latest"
    ON "performance_score_snapshot"("organization_id", "calculated_at", "id");

-- Parent-child path to the formula version: RESTRICT is checked by version id
-- alone, and no query reaches snapshots from a version per tenant.
CREATE INDEX "ix_performance_score_snapshot_version"
    ON "performance_score_snapshot"("formula_version_id");

ALTER TABLE "performance_score_snapshot" ADD CONSTRAINT "ck_score_snapshot_window"
  CHECK ("window_start" < "window_end");

ALTER TABLE "performance_score_snapshot" ADD CONSTRAINT "ck_score_snapshot_score_only_when_published"
  CHECK (("status" = 'PUBLISHED') = ("score_centis" IS NOT NULL));

ALTER TABLE "performance_score_snapshot" ADD CONSTRAINT "ck_score_snapshot_ranges"
  CHECK (
    ("score_centis" IS NULL OR "score_centis" BETWEEN 0 AND 10000)
    AND "eligible_sample_count" >= 0
    AND "coverage_bp" BETWEEN 0 AND 10000
  );

ALTER TABLE "performance_score_snapshot" ADD CONSTRAINT "ck_score_snapshot_text_not_blank"
  CHECK ("organization_id" ~ '[^[:space:]]' AND "correlation_id" ~ '[^[:space:]]');

CREATE TABLE "performance_score_component" (
    "organization_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "component" "PerformanceComponent" NOT NULL,

    -- The version's weight for this component — the exact numerator.
    "configured_weight_bp" INTEGER NOT NULL,
    -- Half-up(configured × 10 000 ÷ coverage), for display. NULL when absent.
    "effective_weight_bp" INTEGER,
    -- This component's 0..100 score in hundredths. NULL when absent.
    "component_score_centis" INTEGER,
    -- How many facts the component counted. May be non-zero on an absent
    -- component — facts that were all excluded from its denominator.
    "sample_count" INTEGER NOT NULL,

    CONSTRAINT "performance_score_component_pkey" PRIMARY KEY ("organization_id", "snapshot_id", "component"),
    CONSTRAINT "performance_score_component_snapshot_fkey"
      FOREIGN KEY ("organization_id", "snapshot_id")
      REFERENCES "performance_score_snapshot"("organization_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Absent is both NULLs, present is both values: never a zero standing in for
-- "not measured" (ADR-052 § 5).
ALTER TABLE "performance_score_component" ADD CONSTRAINT "ck_score_component_absent_is_null"
  CHECK (num_nonnulls("effective_weight_bp", "component_score_centis") IN (0, 2));

-- A component with a score counted something (Codex review of #120, round 2):
-- a present component resting on zero samples is a number with nothing
-- under it. The converse is allowed — an absent component may have counted
-- facts that were all excluded from its denominator (UNDETERMINED).
ALTER TABLE "performance_score_component" ADD CONSTRAINT "ck_score_component_present_has_samples"
  CHECK ("effective_weight_bp" IS NULL OR "sample_count" > 0);

ALTER TABLE "performance_score_component" ADD CONSTRAINT "ck_score_component_ranges"
  CHECK (
    "configured_weight_bp" BETWEEN 1 AND 10000
    AND ("effective_weight_bp" IS NULL OR "effective_weight_bp" BETWEEN 1 AND 10000)
    AND ("component_score_centis" IS NULL OR "component_score_centis" BETWEEN 0 AND 10000)
    AND "sample_count" >= 0
  );

CREATE TABLE "performance_score_source_event" (
    "organization_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,

    CONSTRAINT "performance_score_source_event_pkey" PRIMARY KEY ("organization_id", "snapshot_id", "source_event_id"),
    CONSTRAINT "performance_score_source_event_snapshot_fkey"
      FOREIGN KEY ("organization_id", "snapshot_id")
      REFERENCES "performance_score_snapshot"("organization_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- Same tenant by construction: a snapshot cannot cite another supplier's fact.
    CONSTRAINT "performance_score_source_event_event_fkey"
      FOREIGN KEY ("organization_id", "source_event_id")
      REFERENCES "performance_event"("organization_id", "source_event_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- "Which snapshots counted this fact" — the reverse of the primary key.
CREATE INDEX "ix_performance_score_source_event_event"
    ON "performance_score_source_event"("organization_id", "source_event_id");

-- ---------------------------------------------------------------------------
-- Insert-only, all three tables.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_score_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only (% refused); a recomputation writes a new snapshot', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_performance_score_snapshot_append_only"
    BEFORE UPDATE OR DELETE ON "performance_score_snapshot"
    FOR EACH ROW EXECUTE FUNCTION "performance_score_append_only"();
CREATE TRIGGER "trg_performance_score_snapshot_no_truncate"
    BEFORE TRUNCATE ON "performance_score_snapshot"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_score_append_only"();

CREATE TRIGGER "trg_performance_score_component_append_only"
    BEFORE UPDATE OR DELETE ON "performance_score_component"
    FOR EACH ROW EXECUTE FUNCTION "performance_score_append_only"();
CREATE TRIGGER "trg_performance_score_component_no_truncate"
    BEFORE TRUNCATE ON "performance_score_component"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_score_append_only"();

CREATE TRIGGER "trg_performance_score_source_event_append_only"
    BEFORE UPDATE OR DELETE ON "performance_score_source_event"
    FOR EACH ROW EXECUTE FUNCTION "performance_score_append_only"();
CREATE TRIGGER "trg_performance_score_source_event_no_truncate"
    BEFORE TRUNCATE ON "performance_score_source_event"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_score_append_only"();

-- ---------------------------------------------------------------------------
-- A child row belongs to its snapshot's own transaction.
--
-- Compared by the parent's `xmin`: a snapshot inserted in this transaction
-- carries this transaction's id. Adding a component or a source event to a
-- snapshot committed earlier would rewrite what it said.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_score_child_sealed"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_xmin xid;
BEGIN
  SELECT "xmin" INTO parent_xmin FROM "performance_score_snapshot" WHERE "id" = NEW."snapshot_id";
  IF parent_xmin IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION
      'snapshot % is sealed: its % rows are written in the transaction that creates it',
      NEW."snapshot_id", TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_performance_score_component_sealed"
    BEFORE INSERT ON "performance_score_component"
    FOR EACH ROW EXECUTE FUNCTION "performance_score_child_sealed"();

CREATE TRIGGER "trg_performance_score_source_event_sealed"
    BEFORE INSERT ON "performance_score_source_event"
    FOR EACH ROW EXECUTE FUNCTION "performance_score_child_sealed"();

-- ---------------------------------------------------------------------------
-- The snapshot is consistent with its formula version, checked at commit.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_score_snapshot_consistent"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version RECORD;
  missing INTEGER;
  extra INTEGER;
  wrong_weight INTEGER;
  available_bp BIGINT;
  wrong_effective INTEGER;
  available_count INTEGER;
BEGIN
  SELECT "status", "window_days", "min_sample_count", "min_coverage_bp" INTO version
    FROM "performance_formula_version" WHERE "id" = NEW."formula_version_id";

  IF version."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'snapshot % names DRAFT formula version %; a draft is never scored against',
      NEW."id", NEW."formula_version"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The window is the version's (ADR-052 § 9): exactly `window_days` long.
  IF NEW."window_end" <> NEW."window_start" + make_interval(days => version."window_days") THEN
    RAISE EXCEPTION 'snapshot % covers [%, %), which is not the % days of formula version %',
      NEW."id", NEW."window_start", NEW."window_end", version."window_days", NEW."formula_version"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Status against the version's own thresholds (ADR-052 § 5 rule 15, § 6).
  IF NEW."status" = 'PUBLISHED'
     AND (NEW."coverage_bp" < version."min_coverage_bp"
          OR NEW."eligible_sample_count" < version."min_sample_count") THEN
    RAISE EXCEPTION 'snapshot % is PUBLISHED below its formula version''s thresholds', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'INSUFFICIENT_COVERAGE' AND NEW."coverage_bp" >= version."min_coverage_bp" THEN
    RAISE EXCEPTION 'snapshot % claims INSUFFICIENT_COVERAGE at % bp, which meets the threshold',
      NEW."id", NEW."coverage_bp"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'INSUFFICIENT_DATA'
     AND NEW."eligible_sample_count" >= version."min_sample_count" THEN
    RAISE EXCEPTION 'snapshot % claims INSUFFICIENT_DATA with % samples, which meets the minimum',
      NEW."id", NEW."eligible_sample_count"
      USING ERRCODE = 'check_violation';
  END IF;

  -- One component row per weighted component, and no other, at the version's weight.
  SELECT count(*) INTO missing
    FROM "performance_formula_weight" w
   WHERE w."formula_version_id" = NEW."formula_version_id"
     AND NOT EXISTS (
       SELECT 1 FROM "performance_score_component" c
        WHERE c."organization_id" = NEW."organization_id"
          AND c."snapshot_id" = NEW."id" AND c."component" = w."component");
  SELECT count(*) INTO extra
    FROM "performance_score_component" c
   WHERE c."organization_id" = NEW."organization_id" AND c."snapshot_id" = NEW."id"
     AND NOT EXISTS (
       SELECT 1 FROM "performance_formula_weight" w
        WHERE w."formula_version_id" = NEW."formula_version_id" AND w."component" = c."component");
  SELECT count(*) INTO wrong_weight
    FROM "performance_score_component" c
    JOIN "performance_formula_weight" w
      ON w."formula_version_id" = NEW."formula_version_id" AND w."component" = c."component"
   WHERE c."organization_id" = NEW."organization_id" AND c."snapshot_id" = NEW."id"
     AND c."configured_weight_bp" <> w."weight_bp";
  IF missing > 0 OR extra > 0 OR wrong_weight > 0 THEN
    RAISE EXCEPTION
      'snapshot % does not match formula version % (missing %, extra %, wrong weight %)',
      NEW."id", NEW."formula_version", missing, extra, wrong_weight
      USING ERRCODE = 'check_violation';
  END IF;

  -- coverageBp is the configured weight of the components that had data.
  SELECT COALESCE(SUM(c."configured_weight_bp"), 0), count(*)
    INTO available_bp, available_count
    FROM "performance_score_component" c
   WHERE c."organization_id" = NEW."organization_id" AND c."snapshot_id" = NEW."id"
     AND c."effective_weight_bp" IS NOT NULL;
  IF available_bp <> NEW."coverage_bp" THEN
    RAISE EXCEPTION 'snapshot % states coverage % bp; its available components weigh % bp',
      NEW."id", NEW."coverage_bp", available_bp
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND available_count = 0 THEN
    RAISE EXCEPTION 'snapshot % is PUBLISHED with no available component', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Each effective weight is half-up(configured × 10000 ÷ coverage), in integers.
  SELECT count(*) INTO wrong_effective
    FROM "performance_score_component" c
   WHERE c."organization_id" = NEW."organization_id" AND c."snapshot_id" = NEW."id"
     AND c."effective_weight_bp" IS NOT NULL
     AND c."effective_weight_bp"::BIGINT
         <> (2::BIGINT * c."configured_weight_bp" * 10000 + NEW."coverage_bp")
            / (2::BIGINT * NEW."coverage_bp");
  IF wrong_effective > 0 THEN
    RAISE EXCEPTION 'snapshot % has % effective weight(s) that are not the renormalised configured weight',
      NEW."id", wrong_effective
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "trg_performance_score_snapshot_consistent"
    AFTER INSERT ON "performance_score_snapshot"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "performance_score_snapshot_consistent"();
