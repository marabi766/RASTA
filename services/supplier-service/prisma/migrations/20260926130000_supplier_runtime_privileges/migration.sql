-- =============================================================================
-- supplier-service — the runtime role gets DML, and only the DML it needs.
--
-- ## Why this exists (Codex review of #120, finding 2)
--
-- The performance tables' guarantees are triggers: the frozen formula, the
-- deferred 100% sum, the append-only event store, the sealed and insert-only
-- snapshots. A trigger binds every role — the owner included — but the owner
-- can remove it: `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, `ALTER
-- TABLE`, `DROP TABLE`. Until now the service connected as the role that ran
-- the migrations and so owned every table, which made each of those guarantees
-- something the running service could switch off.
--
-- The fix follows audit-service (ADR-053 § 6) with one difference: the tables
-- stay in `public`, because supplier-service was already migrated there on
-- main and moving schemas would strand its rows. Instead the database and every
-- object in it belong to `rasta_supplier_migrator`
-- (infrastructure/docker/postgres/lib/supplier-privilege-split.bash, run by the
-- bootstrap and as an upgrade step), migrations connect as that role
-- (`DATABASE_URL_SUPPLIER_MIGRATOR`, picked by scripts/prisma.mjs), and the
-- service connects as `rasta_supplier`, which owns nothing, has no CREATEDB and
-- holds only CONNECT, USAGE on `public` and the grants below. It cannot widen
-- them — only an owner can grant. `test/runtime-privileges.int-spec.ts` proves
-- each refusal is SQLSTATE 42501.
--
-- ## What the runtime role may do
--
--   domain and plumbing tables   SELECT, INSERT, UPDATE, DELETE — what the
--                                service (and its outbox relay and purge) did
--                                before; TRUNCATE and every DDL are gone.
--   performance_formula_version  SELECT, INSERT, UPDATE — create a draft,
--                                activate, retire. Never DELETE.
--   performance_formula_weight   SELECT, INSERT. A weight is written with its
--                                draft; there is no edit path.
--   performance_event            SELECT, INSERT — append-only.
--   performance_score_*          SELECT, INSERT — insert-only.
--
-- ## Reversibility
--
-- `down.sql` revokes what this grants. That leaves each table's ACL as the
-- owner's explicit default rather than NULL, which PostgreSQL treats as the
-- same thing; the reversibility verifier compares ACLs through `acldefault`
-- for exactly that reason.
--
-- A table added by a later migration needs its own grant: the runtime-role
-- suite enumerates every table in the schema and fails on one it cannot
-- account for.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "supplier",
  "supplier_capability",
  "qualification",
  "qualification_evidence",
  "suspension",
  "outbox_message",
  "outbox_stream_sequence",
  "processed_event"
TO rasta_supplier;

GRANT SELECT, INSERT, UPDATE ON "performance_formula_version" TO rasta_supplier;

GRANT SELECT, INSERT ON
  "performance_formula_weight",
  "performance_event",
  "performance_score_snapshot",
  "performance_score_component",
  "performance_score_source_event"
TO rasta_supplier;
