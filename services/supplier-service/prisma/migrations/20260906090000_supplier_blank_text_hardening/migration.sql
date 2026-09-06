-- =============================================================================
-- supplier-service — close the whitespace hole in every "not blank" CHECK.
--
-- ## The defect
--
-- The initial migration expressed "this text is not blank" as
-- `length(btrim(x)) > 0`. PostgreSQL's one-argument `btrim(text)` removes
-- **spaces only** — not tabs, newlines, carriage returns, form feeds or
-- vertical tabs. So every one of these constraints accepted a value made
-- entirely of tabs or newlines:
--
--   INSERT ... document_id = E'\t\t'   -- accepted, and is not an identifier
--   INSERT ... display_name = E'\n'    -- accepted, and is not a name
--
-- `test/constraints.int-spec.ts` demonstrated it on the first run of the suite
-- against a real database: "refuses a whitespace-only document identifier"
-- failed because the row was created.
--
-- This matters most on `qualification_evidence.document_id`, which is the
-- opaque handle a reviewer must resolve in document-service. A tab is a handle
-- that resolves to nothing, stored as though it were a real reference.
--
-- ## The fix
--
-- `x ~ '[^[:space:]]'` — "contains at least one non-whitespace character".
-- Stated as the property itself rather than as a trimming trick, so it cannot
-- be wrong about which characters count as blank: the POSIX class is the
-- database's own definition of whitespace, and it covers every character
-- `btrim` was silently letting through.
--
-- This **strengthens** every constraint. Nothing that was rejected before is
-- accepted now; values that were wrongly accepted are now rejected. No existing
-- row can violate it, because no legitimate write ever produced a blank one —
-- and if one somehow existed this migration would fail loudly rather than
-- install a constraint that does not hold.
--
-- Each constraint is dropped and recreated rather than altered, because
-- PostgreSQL has no `ALTER CONSTRAINT` for a CHECK expression.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

-- supplier ---------------------------------------------------------------------
ALTER TABLE "supplier" DROP CONSTRAINT "ck_supplier_display_name_not_blank";
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_display_name_not_blank"
  CHECK ("display_name" ~ '[^[:space:]]');

ALTER TABLE "supplier" DROP CONSTRAINT "ck_supplier_actor_recorded";
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_actor_recorded"
  CHECK ("registered_by" ~ '[^[:space:]]' AND "registered_correlation_id" ~ '[^[:space:]]');

-- supplier_capability -----------------------------------------------------------
ALTER TABLE "supplier_capability" DROP CONSTRAINT "ck_supplier_capability_actor_recorded";
ALTER TABLE "supplier_capability" ADD CONSTRAINT "ck_supplier_capability_actor_recorded"
  CHECK ("declared_by" ~ '[^[:space:]]');

-- qualification -----------------------------------------------------------------
ALTER TABLE "qualification" DROP CONSTRAINT "ck_qualification_text_not_blank";
ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_text_not_blank"
  CHECK (
    "submitted_by" ~ '[^[:space:]]'
    AND "submitted_correlation_id" ~ '[^[:space:]]'
    AND ("statement" IS NULL OR "statement" ~ '[^[:space:]]')
    AND ("decided_by" IS NULL OR "decided_by" ~ '[^[:space:]]')
    AND ("decided_correlation_id" IS NULL OR "decided_correlation_id" ~ '[^[:space:]]')
    AND ("decision_note" IS NULL OR "decision_note" ~ '[^[:space:]]')
  );

-- qualification_evidence ---------------------------------------------------------
ALTER TABLE "qualification_evidence" DROP CONSTRAINT "ck_evidence_document_id_not_blank";
ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_document_id_not_blank"
  CHECK ("document_id" ~ '[^[:space:]]');

ALTER TABLE "qualification_evidence" DROP CONSTRAINT "ck_evidence_text_not_blank";
ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_text_not_blank"
  CHECK (
    "attached_by" ~ '[^[:space:]]'
    AND ("label" IS NULL OR "label" ~ '[^[:space:]]')
  );

-- suspension ---------------------------------------------------------------------
ALTER TABLE "suspension" DROP CONSTRAINT "ck_suspension_text_not_blank";
ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_text_not_blank"
  CHECK (
    "reason" ~ '[^[:space:]]'
    AND "suspended_by" ~ '[^[:space:]]'
    AND "suspended_correlation_id" ~ '[^[:space:]]'
    AND ("reinstated_by" IS NULL OR "reinstated_by" ~ '[^[:space:]]')
    AND ("reinstated_correlation_id" IS NULL OR "reinstated_correlation_id" ~ '[^[:space:]]')
    AND ("reinstatement_note" IS NULL OR "reinstatement_note" ~ '[^[:space:]]')
  );
