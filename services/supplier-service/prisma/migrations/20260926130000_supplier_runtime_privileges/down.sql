-- Reverses 20260926130000_supplier_runtime_privileges.
--
-- **What a rollback costs.** The service loses every table grant and cannot
-- run until this migration is re-applied. That is the safe direction: the
-- alternative — handing the runtime role ownership back — would restore the
-- ability to disable the triggers, which is what the forward migration closes.
--
-- Conditional for the same reason as the forward migration: run as
-- `rasta_supplier` (the reversibility verifier), nothing was granted and there
-- is nothing to revoke. Revoking from an owner would itself rewrite `relacl`.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF current_user = 'rasta_supplier' THEN
    RETURN;
  END IF;

  REVOKE ALL ON
    "supplier",
    "supplier_capability",
    "qualification",
    "qualification_evidence",
    "suspension",
    "outbox_message",
    "outbox_stream_sequence",
    "processed_event",
    "performance_formula_version",
    "performance_formula_weight",
    "performance_event",
    "performance_score_snapshot",
    "performance_score_component",
    "performance_score_source_event"
  FROM rasta_supplier;
END;
$$;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926130000_supplier_runtime_privileges';
