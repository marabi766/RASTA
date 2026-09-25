-- Legacy data, brought to the shape the code in this release expects
-- (PR #108 review round 1, items #2 and #5).
--
-- 1. Identifiers are canonicalised. New input is canonicalised at the API
--    boundary (src/asset/identifier.ts), but rows stored before this release
--    are not: `ماشين-۱۲` (Arabic yeh, Persian digits) and `ماشین-12` compare
--    unequal, so a lookup misses its duplicate and a unique index sees two
--    values. Asset tags, serial numbers, policy numbers and insurer names are
--    rewritten to the same canonical form, here, before the partial unique
--    indexes of 20260925120000 are built on them.
--
-- 2. The dossier is reunited with its owner. Before this release a transfer
--    moved only the asset row: policies, claims, inspections, locations,
--    documents, timeline entries and earlier transfer records stayed under
--    the previous owner. A claim left SUBMITTED there blocks every later
--    transfer (the open-claim check sees it) while neither organization can
--    act on it. Every child row whose organization is not its asset's
--    current owner is moved to that owner, which is what a transfer does now.
--
-- Collisions are refused, never resolved. If canonicalising would make two
-- rows equal where they must be unique, the migration stops before changing
-- anything and names the query that lists them. Which of two records is the
-- real one is an operator's decision.
--
-- Reversible. Every value changed is written to asset_legacy_migration_log
-- first, and down.sql restores from it.
--
-- Re-runnable on a database that already has it (the legacy-state integration
-- test does exactly that): CREATE ... IF NOT EXISTS / OR REPLACE, the log keeps
-- the first original value of a row, and the updates only touch rows that
-- still differ.
--
-- Atomic: prisma migrate deploy already runs a PostgreSQL migration as one
-- transaction (verified 2026-09-25: a failing statement rolled back a
-- CREATE TABLE before it). The explicit BEGIN/COMMIT keeps that true however
-- the script is run.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- The canonical form, exactly as canonicalIdentifier() computes it: NFKC;
-- Arabic yeh (ي ى) and kaf (ك) to Persian (ی ک); Persian and Arabic-Indic
-- digits to Latin; tatweel removed; every JavaScript \s character run
-- collapsed to one space; trimmed. The class is spelled out rather than
-- written \s, because PostgreSQL's \s depends on the locale and JavaScript's
-- does not. test/legacy-migration.int-spec.ts proves the two agree.
-- Kept after the migration so an operator can use it in the queries below.
CREATE OR REPLACE FUNCTION canonical_identifier(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $canonical$
  SELECT btrim(
    regexp_replace(
      replace(
        translate(normalize(value, NFKC), 'يىك۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'ییک01234567890123456789'),
        'ـ', ''),
      '[\t\n\v\f\r    -     　﻿]+', ' ', 'g'),
    ' ')
$canonical$;

CREATE TABLE IF NOT EXISTS "asset_legacy_migration_log" (
    "table_name"  TEXT         NOT NULL,
    "row_id"      TEXT         NOT NULL,
    "column_name" TEXT         NOT NULL,
    "old_value"   TEXT,
    "logged_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_legacy_migration_log_pkey" PRIMARY KEY ("table_name", "row_id", "column_name")
);

-- ---------------------------------------------------------------------------
-- 1. Canonical identifiers: collisions first, before anything is written.
--
-- Grouped with deleted_at, because two groups matter: live rows (deleted_at
-- NULL, grouped together), which the partial indexes of 20260925120000 will
-- refuse, and soft-deleted rows with the same deletion instant, which the
-- current composite indexes refuse. Serial numbers are unique across every
-- row, deleted or not.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  tags integer;
  serials integer;
  policies integer;
BEGIN
  SELECT count(*) INTO tags FROM (
    SELECT 1 FROM "asset"
     WHERE "asset_tag" IS NOT NULL
     GROUP BY "organization_id", canonical_identifier("asset_tag"), "deleted_at"
    HAVING count(*) > 1) AS duplicates;
  IF tags > 0 THEN
    RAISE EXCEPTION 'asset: % asset tag(s) become duplicates within an organization once canonicalised; nothing was changed', tags
      USING HINT = 'List them with: SELECT organization_id, canonical_identifier(asset_tag), deleted_at, array_agg(id), array_agg(asset_tag) FROM asset WHERE asset_tag IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1; (canonical_identifier is created by this migration; run its CREATE FUNCTION first). Retag or retire one of each pair, then deploy again.';
  END IF;

  SELECT count(*) INTO serials FROM (
    SELECT 1 FROM "asset"
     WHERE "serial_number" IS NOT NULL
     GROUP BY canonical_identifier("serial_number")
    HAVING count(*) > 1) AS duplicates;
  IF serials > 0 THEN
    RAISE EXCEPTION 'asset: % serial number(s) become duplicates once canonicalised; nothing was changed', serials
      USING HINT = 'List them with: SELECT canonical_identifier(serial_number), array_agg(id), array_agg(organization_id), array_agg(serial_number) FROM asset WHERE serial_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1; (canonical_identifier is created by this migration; run its CREATE FUNCTION first). One physical machine registered twice must be resolved by a person.';
  END IF;

  SELECT count(*) INTO policies FROM (
    SELECT 1 FROM "insurance_policy"
     GROUP BY canonical_identifier("policy_number"), canonical_identifier("insurer_name"), "deleted_at"
    HAVING count(*) > 1) AS duplicates;
  IF policies > 0 THEN
    RAISE EXCEPTION 'insurance_policy: % policy number(s) become duplicates for one insurer once canonicalised; nothing was changed', policies
      USING HINT = 'List them with: SELECT canonical_identifier(policy_number), canonical_identifier(insurer_name), deleted_at, array_agg(id), array_agg(asset_id) FROM insurance_policy GROUP BY 1, 2, 3 HAVING count(*) > 1; (canonical_identifier is created by this migration; run its CREATE FUNCTION first).';
  END IF;
END
$preflight$;

DO $canonicalise$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('asset', 'asset_tag'),
      ('asset', 'serial_number'),
      ('insurance_policy', 'policy_number'),
      ('insurance_policy', 'insurer_name')
    ) AS t (table_name, column_name)
  LOOP
    EXECUTE format(
      'INSERT INTO asset_legacy_migration_log (table_name, row_id, column_name, old_value)
       SELECT %L, id, %L, %I FROM %I
        WHERE %I IS NOT NULL AND %I IS DISTINCT FROM canonical_identifier(%I)
       ON CONFLICT DO NOTHING',
      target.table_name, target.column_name, target.column_name, target.table_name,
      target.column_name, target.column_name, target.column_name);
    EXECUTE format(
      'UPDATE %I SET %I = canonical_identifier(%I)
        WHERE %I IS NOT NULL AND %I IS DISTINCT FROM canonical_identifier(%I)',
      target.table_name, target.column_name, target.column_name,
      target.column_name, target.column_name, target.column_name);
  END LOOP;
END
$canonicalise$;

-- ---------------------------------------------------------------------------
-- 2. The dossier follows its asset: every asset-owned table, as the transfer
--    in src/asset/asset.service.ts moves them.
-- ---------------------------------------------------------------------------
DO $dossier$
DECLARE
  child text;
BEGIN
  FOREACH child IN ARRAY ARRAY[
    'asset_timeline_entry',
    'asset_location',
    'asset_document_ref',
    'insurance_policy',
    'insurance_claim',
    'technical_inspection',
    'asset_transfer'
  ]
  LOOP
    EXECUTE format(
      'INSERT INTO asset_legacy_migration_log (table_name, row_id, column_name, old_value)
       SELECT %L, c.id, ''organization_id'', c.organization_id
         FROM %I c JOIN asset a ON a.id = c.asset_id
        WHERE c.organization_id <> a.organization_id
       ON CONFLICT DO NOTHING',
      child, child);
    EXECUTE format(
      'UPDATE %I c SET organization_id = a.organization_id
         FROM asset a
        WHERE a.id = c.asset_id AND c.organization_id <> a.organization_id',
      child);
  END LOOP;
END
$dossier$;

COMMIT;
