-- =============================================================================
-- supplier-service — ADR-052 Phase B step 2: the performance formula, as data.
--
-- Two tables. `performance_formula_version` is one immutable set of rules —
-- the window, the minimum sample, the coverage threshold and the linear
-- rating → 0..100 mapping — and `performance_formula_weight` is that version's
-- per-component weight in integer basis points (ADR-052 § 3, § 7).
--
-- ## Platform-wide, not tenant-scoped (docs/24 Q-75, closed)
--
-- Neither table carries `organization_id`. ADR-052 § 3 says "only one version
-- is ACTIVE at any moment", and the published score is one public score per
-- supplier that buyers in every tenant read (§ 16). So the formula is one
-- platform-wide row set, the way `reward_evaluation_cutover` is in
-- economic-service, and every read of it states its reason under
-- `runUnscoped`. Q-75 was closed by the project owner on 2026-09-26: only
-- SYSTEM_ADMIN may create, activate or retire it (enforced by the step-7 API).
--
-- ## What the database refuses, rather than the DTO
--
--   * a version whose weights do not sum to exactly 10 000 bp — at commit, by
--     a deferred constraint trigger, so the version and its weights are written
--     in one transaction or not at all (ADR-052 § 3, § 23 "ثابت وزن");
--   * a second ACTIVE version — a partial unique index;
--   * any edit of an ACTIVE or RETIRED version, and any change to its weights —
--     only ACTIVE → RETIRED with its three stamps is allowed;
--   * a transaction that retires the ACTIVE version without activating a
--     successor — at commit, so retirement only ever happens as part of
--     activating the next version (PM ruling on Q-B);
--   * DELETE and TRUNCATE of either table.
--
-- No version is seeded. Weights are business data, and business data never
-- goes into a migration (AGENTS.md § 3).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PerformanceFormulaStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- The five components ADR-052 § 1 accepted. QUALITY is a component with a
-- weight even though nothing produces it yet (Q-56): the configured weight is
-- the denominator `coverageBp` is measured against.
CREATE TYPE "PerformanceComponent" AS ENUM (
  'QUALITY',
  'ON_TIME',
  'CUSTOMER_SATISFACTION',
  'DISPUTE_ABSENCE',
  'CANCELLATION_ABSENCE'
);

CREATE TABLE "performance_formula_version" (
    "id" TEXT NOT NULL,
    -- ADR-052 § 3: an integer, ascending. Every snapshot is stamped with it.
    "formula_version" INTEGER NOT NULL,
    "status" "PerformanceFormulaStatus" NOT NULL DEFAULT 'DRAFT',

    -- ADR-052 § 9: the rolling window is part of the version.
    "window_days" INTEGER NOT NULL,
    -- ADR-052 § 6 and rule 15, stored on the version so a snapshot's
    -- provenance names the thresholds it was judged against (PM ruling, Q-C).
    "min_sample_count" INTEGER NOT NULL,
    "min_coverage_bp" INTEGER NOT NULL,

    -- ADR-052 § 7: the rating → 0..100 mapping is linear, explicit and
    -- recorded in the version, never in code. Two points define the line.
    "rating_scale_min" SMALLINT NOT NULL,
    "rating_scale_max" SMALLINT NOT NULL,
    "rating_min_score_centis" INTEGER NOT NULL,
    "rating_max_score_centis" INTEGER NOT NULL,

    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_correlation_id" TEXT NOT NULL,
    "activated_by" TEXT,
    "activated_at" TIMESTAMP(3),
    "activated_correlation_id" TEXT,
    "retired_by" TEXT,
    "retired_at" TIMESTAMP(3),
    "retired_correlation_id" TEXT,

    CONSTRAINT "performance_formula_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_performance_formula_version_number"
    ON "performance_formula_version"("formula_version");

-- At most one ACTIVE version on the whole platform. "At least one, once any
-- has been activated" is the deferred trigger further down.
CREATE UNIQUE INDEX "ux_performance_formula_single_active"
    ON "performance_formula_version"("status")
 WHERE "status" = 'ACTIVE';

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_version_positive"
  CHECK ("formula_version" > 0);

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_window_positive"
  CHECK ("window_days" > 0);

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_min_sample_positive"
  CHECK ("min_sample_count" > 0);

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_min_coverage_range"
  CHECK ("min_coverage_bp" BETWEEN 0 AND 10000);

-- A line needs two distinct points, and a better rating never maps to a lower
-- score. Both ends stay inside the 0..100 scale (0..10 000 centis).
ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_rating_mapping"
  CHECK (
    "rating_scale_min" < "rating_scale_max"
    AND "rating_min_score_centis" BETWEEN 0 AND 10000
    AND "rating_max_score_centis" BETWEEN 0 AND 10000
    AND "rating_min_score_centis" < "rating_max_score_centis"
  );

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_activation_complete"
  CHECK (num_nonnulls("activated_by", "activated_at", "activated_correlation_id") IN (0, 3));

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_retirement_complete"
  CHECK (num_nonnulls("retired_by", "retired_at", "retired_correlation_id") IN (0, 3));

-- The status and its stamps are one fact. RETIRED implies it was once ACTIVE:
-- there is no DRAFT → RETIRED path, because nothing retires what was never in
-- force.
ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_status_stamps"
  CHECK (
    ("status" = 'DRAFT'   AND "activated_at" IS NULL     AND "retired_at" IS NULL)
    OR ("status" = 'ACTIVE'  AND "activated_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  );

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_chronology"
  CHECK (
    ("activated_at" IS NULL OR "activated_at" >= "created_at")
    AND ("retired_at" IS NULL OR "retired_at" >= "activated_at")
  );

ALTER TABLE "performance_formula_version" ADD CONSTRAINT "ck_formula_text_not_blank"
  CHECK (
    "created_by" ~ '[^[:space:]]'
    AND "created_correlation_id" ~ '[^[:space:]]'
    AND ("activated_by" IS NULL OR "activated_by" ~ '[^[:space:]]')
    AND ("activated_correlation_id" IS NULL OR "activated_correlation_id" ~ '[^[:space:]]')
    AND ("retired_by" IS NULL OR "retired_by" ~ '[^[:space:]]')
    AND ("retired_correlation_id" IS NULL OR "retired_correlation_id" ~ '[^[:space:]]')
  );

CREATE TABLE "performance_formula_weight" (
    "formula_version_id" TEXT NOT NULL,
    "component" "PerformanceComponent" NOT NULL,
    -- ADR-052 § 3: integer basis points, 100% = 10 000. A component the version
    -- does not weigh has no row; a zero-weight row would be the same fact
    -- stated twice.
    "weight_bp" INTEGER NOT NULL,

    CONSTRAINT "performance_formula_weight_pkey" PRIMARY KEY ("formula_version_id", "component"),
    CONSTRAINT "performance_formula_weight_version_fkey" FOREIGN KEY ("formula_version_id")
      REFERENCES "performance_formula_version"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "performance_formula_weight" ADD CONSTRAINT "ck_formula_weight_bp_range"
  CHECK ("weight_bp" BETWEEN 1 AND 10000);

-- ---------------------------------------------------------------------------
-- A version is frozen once it leaves DRAFT.
--
-- DRAFT may still be corrected (its weights stay subject to the 100% rule at
-- every commit). ACTIVE may only become RETIRED, and only its three retirement
-- stamps may change with it. RETIRED never changes. Nothing is ever deleted.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_formula_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retire_columns CONSTANT TEXT[] :=
    ARRAY['status', 'retired_by', 'retired_at', 'retired_correlation_id'];
  identity_columns CONSTANT TEXT[] :=
    ARRAY['id', 'formula_version', 'created_by', 'created_at', 'created_correlation_id'];
  col TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'performance_formula_version is never truncated'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'performance_formula_version % is never deleted', OLD."formula_version"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'ACTIVE') THEN
      RAISE EXCEPTION 'performance formula version % may go from DRAFT only to ACTIVE, not %',
        OLD."formula_version", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    FOREACH col IN ARRAY identity_columns LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        RAISE EXCEPTION 'performance formula version %: % is fixed at creation',
          OLD."formula_version", col
          USING ERRCODE = 'restrict_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'ACTIVE'
     AND NEW."status" = 'RETIRED'
     AND (to_jsonb(NEW) - retire_columns) = (to_jsonb(OLD) - retire_columns) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'performance formula version % is % and is never edited; create a new version',
    OLD."formula_version", OLD."status"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_performance_formula_version_guard"
    BEFORE UPDATE OR DELETE ON "performance_formula_version"
    FOR EACH ROW EXECUTE FUNCTION "performance_formula_version_guard"();

CREATE TRIGGER "trg_performance_formula_version_no_truncate"
    BEFORE TRUNCATE ON "performance_formula_version"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_formula_version_guard"();

-- The weights of a version that has left DRAFT are as frozen as the version.
CREATE FUNCTION "performance_formula_weight_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_id TEXT;
  version_status "PerformanceFormulaStatus";
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'performance_formula_weight is never truncated'
      USING ERRCODE = 'restrict_violation';
  END IF;

  FOREACH version_id IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD."formula_version_id" END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW."formula_version_id" END
  ] LOOP
    CONTINUE WHEN version_id IS NULL;
    SELECT "status" INTO version_status
      FROM "performance_formula_version" WHERE "id" = version_id;
    IF version_status IS DISTINCT FROM 'DRAFT' AND version_status IS NOT NULL THEN
      RAISE EXCEPTION 'the weights of performance formula version % are frozen: it is %',
        version_id, version_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_performance_formula_weight_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "performance_formula_weight"
    FOR EACH ROW EXECUTE FUNCTION "performance_formula_weight_guard"();

CREATE TRIGGER "trg_performance_formula_weight_no_truncate"
    BEFORE TRUNCATE ON "performance_formula_weight"
    FOR EACH STATEMENT EXECUTE FUNCTION "performance_formula_weight_guard"();

-- ---------------------------------------------------------------------------
-- The 100% rule, checked at commit.
--
-- Deferred because a version and its weights are several statements: checked
-- per statement, the first weight would always fail. At commit, every version
-- the transaction touched must have weights summing to exactly 10 000 bp —
-- including one inserted with no weights at all.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_formula_weight_sum_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_ids TEXT[];
  version_id TEXT;
  total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'performance_formula_version' THEN
    version_ids := ARRAY[NEW."id"];
  ELSIF TG_OP = 'INSERT' THEN
    version_ids := ARRAY[NEW."formula_version_id"];
  ELSIF TG_OP = 'DELETE' THEN
    version_ids := ARRAY[OLD."formula_version_id"];
  ELSE
    version_ids := ARRAY[OLD."formula_version_id", NEW."formula_version_id"];
  END IF;

  FOREACH version_id IN ARRAY version_ids LOOP
    -- A version that no longer exists has nothing to sum. (Versions are never
    -- deleted, but the check does not rely on that.)
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM "performance_formula_version" WHERE "id" = version_id
    );
    SELECT COALESCE(SUM("weight_bp"), 0) INTO total
      FROM "performance_formula_weight" WHERE "formula_version_id" = version_id;
    IF total <> 10000 THEN
      RAISE EXCEPTION
        'performance formula version % has weights summing to % bp; exactly 10000 bp is required',
        version_id, total
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "trg_performance_formula_weight_sum"
    AFTER INSERT OR UPDATE OR DELETE ON "performance_formula_weight"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "performance_formula_weight_sum_check"();

CREATE CONSTRAINT TRIGGER "trg_performance_formula_version_sum"
    AFTER INSERT ON "performance_formula_version"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "performance_formula_weight_sum_check"();

-- ---------------------------------------------------------------------------
-- Retirement only with a successor (PM ruling on Q-B).
--
-- The partial unique index makes "at most one ACTIVE" immediate, so activation
-- retires the old version first and activates the new one second. At commit,
-- a transaction that retired the ACTIVE version must have left another one
-- ACTIVE: a standalone retirement would leave the platform with no formula.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "performance_formula_successor_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "performance_formula_version" WHERE "status" = 'ACTIVE') THEN
    RAISE EXCEPTION
      'performance formula version % was retired without a successor; retirement happens only by activating the next version',
      NEW."formula_version"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "trg_performance_formula_successor"
    AFTER UPDATE ON "performance_formula_version"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')
    EXECUTE FUNCTION "performance_formula_successor_check"();
