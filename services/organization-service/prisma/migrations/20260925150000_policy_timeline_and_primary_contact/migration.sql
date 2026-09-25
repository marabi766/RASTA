-- Policy timeline and primary-contact integrity.
--
-- Three invariants the service already meant to keep, which concurrent or
-- out-of-order writes could break:
--
--   * a policy value ends after it begins (ck_policy_effective_range);
--   * no two values of one key of one organization are in force at the same
--     instant (ex_policy_no_overlap);
--   * at most one primary contact per (organization, kind)
--     (ux_contact_primary_per_kind).
--
-- The service serialises the write paths (per-key and per-kind advisory
-- locks) and refuses the cases it cannot represent; these constraints are what
-- make the invariants hold for every writer, not only the ones that go through
-- that code.
--
-- Existing rows that already break an invariant are not repaired here: which
-- of two overlapping governance values was meant, or which of two primary
-- contacts, is a decision about real records, not something a migration may
-- guess. The migration refuses and names the rows instead. Find them with the
-- queries in the error messages, resolve them, and deploy again.

DO $$
DECLARE
  inverted integer;
  overlapping integer;
  primaries integer;
BEGIN
  SELECT count(*) INTO inverted
  FROM "organization_policy"
  WHERE "effective_to" IS NOT NULL AND "effective_to" <= "effective_from";

  -- Inverted rows are left out: tsrange() raises on them, and they are
  -- reported by the check above.
  WITH valid AS MATERIALIZED (
    SELECT "id", "organization_id", "key", tsrange("effective_from", "effective_to", '[)') AS period
    FROM "organization_policy"
    WHERE "effective_to" IS NULL OR "effective_to" > "effective_from"
  )
  SELECT count(*) INTO overlapping
  FROM valid a
  JOIN valid b
    ON a."organization_id" = b."organization_id"
   AND a."key" = b."key"
   AND a."id" < b."id"
   AND a.period && b.period;

  SELECT count(*) INTO primaries
  FROM (
    SELECT 1 FROM "organization_contact"
    WHERE "is_primary"
    GROUP BY "organization_id", "kind"
    HAVING count(*) > 1
  ) duplicated;

  IF inverted > 0 THEN
    RAISE EXCEPTION
      'organization_policy holds % row(s) that end at or before they begin. Find them with: SELECT id, organization_id, key, effective_from, effective_to FROM organization_policy WHERE effective_to <= effective_from;',
      inverted;
  END IF;
  IF overlapping > 0 THEN
    RAISE EXCEPTION
      'organization_policy holds % pair(s) of values of one key in force at the same time. Find them with: SELECT a.id, b.id, a.organization_id, a.key FROM organization_policy a JOIN organization_policy b ON a.organization_id = b.organization_id AND a.key = b.key AND a.id < b.id AND (a.effective_to IS NULL OR a.effective_to > b.effective_from) AND (b.effective_to IS NULL OR b.effective_to > a.effective_from);',
      overlapping;
  END IF;
  IF primaries > 0 THEN
    RAISE EXCEPTION
      'organization_contact holds % (organization, kind) pair(s) with more than one primary contact. Find them with: SELECT organization_id, kind, array_agg(id) FROM organization_contact WHERE is_primary GROUP BY organization_id, kind HAVING count(*) > 1;',
      primaries;
  END IF;
END $$;

-- `=` on text inside a GiST exclusion constraint needs btree_gist. It is a
-- trusted extension (PostgreSQL 13+), so the database owner — the service
-- role — can create it without superuser. The bootstrap also installs it, as
-- it does ltree and postgis.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "organization_policy"
  ADD CONSTRAINT "ck_policy_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- Half-open periods, [effective_from, effective_to): a value closed at T and
-- its replacement starting at T meet without overlapping. A NULL end is an
-- unbounded range.
ALTER TABLE "organization_policy"
  ADD CONSTRAINT "ex_policy_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "key" WITH =,
    tsrange("effective_from", "effective_to", '[)') WITH &&
  );

CREATE UNIQUE INDEX "ux_contact_primary_per_kind"
  ON "organization_contact" ("organization_id", "kind")
  WHERE "is_primary";
