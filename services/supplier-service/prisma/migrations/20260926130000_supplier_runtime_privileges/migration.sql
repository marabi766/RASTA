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
-- The fix is audit-service's (ADR-053 § 6): the tables live in schema
-- `supplier`, owned by `rasta_supplier_migrator`; migrations connect as that
-- role (`DATABASE_URL_SUPPLIER_MIGRATOR`, picked by scripts/prisma.mjs); the
-- service connects as `rasta_supplier`, which owns nothing there and holds
-- only the grants below. It cannot widen them — only an owner can grant.
-- `test/runtime-privileges.int-spec.ts` proves each refusal is SQLSTATE 42501.
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
-- ## Why the grants are conditional
--
-- Granting to a table's owner is meaningless — it already holds everything —
-- but it still rewrites `relacl` from NULL to an explicit list, and a REVOKE
-- cannot put the NULL back. The reversibility verifier runs as `rasta_supplier`
-- in a scratch schema it owns, and compares `relacl` exactly; so when the
-- migration runs as `rasta_supplier` itself there is nothing to grant, and it
-- grants nothing. Every real deployment runs as the migrator.
--
-- A table added by a later migration needs its own grant: the runtime-role
-- suite enumerates every table in the schema and fails on one it cannot
-- account for.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF current_user = 'rasta_supplier' THEN
    RETURN;
  END IF;

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
END;
$$;
