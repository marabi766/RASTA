-- Reverses 20260906090000_supplier_blank_text_hardening.
--
-- Restores the one-argument `btrim` predicates exactly as the initial migration
-- wrote them. This is a genuine reversal and therefore restores the weaker
-- constraint — that is what reversing this migration *means*, and the reason it
-- is only ever run by the reversibility gate. It cannot fail on existing rows:
-- every row that satisfies the stronger predicate satisfies the weaker one.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "supplier" DROP CONSTRAINT "ck_supplier_display_name_not_blank";
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_display_name_not_blank"
  CHECK (length(btrim("display_name")) > 0);

ALTER TABLE "supplier" DROP CONSTRAINT "ck_supplier_actor_recorded";
ALTER TABLE "supplier" ADD CONSTRAINT "ck_supplier_actor_recorded"
  CHECK (length(btrim("registered_by")) > 0 AND length(btrim("registered_correlation_id")) > 0);

ALTER TABLE "supplier_capability" DROP CONSTRAINT "ck_supplier_capability_actor_recorded";
ALTER TABLE "supplier_capability" ADD CONSTRAINT "ck_supplier_capability_actor_recorded"
  CHECK (length(btrim("declared_by")) > 0);

ALTER TABLE "qualification" DROP CONSTRAINT "ck_qualification_text_not_blank";
ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_text_not_blank"
  CHECK (
    length(btrim("submitted_by")) > 0
    AND length(btrim("submitted_correlation_id")) > 0
    AND ("statement" IS NULL OR length(btrim("statement")) > 0)
    AND ("decided_by" IS NULL OR length(btrim("decided_by")) > 0)
    AND ("decision_note" IS NULL OR length(btrim("decision_note")) > 0)
  );

ALTER TABLE "qualification_evidence" DROP CONSTRAINT "ck_evidence_document_id_not_blank";
ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_document_id_not_blank"
  CHECK (length(btrim("document_id")) > 0);

ALTER TABLE "qualification_evidence" DROP CONSTRAINT "ck_evidence_text_not_blank";
ALTER TABLE "qualification_evidence" ADD CONSTRAINT "ck_evidence_text_not_blank"
  CHECK (
    length(btrim("attached_by")) > 0
    AND ("label" IS NULL OR length(btrim("label")) > 0)
  );

ALTER TABLE "suspension" DROP CONSTRAINT "ck_suspension_text_not_blank";
ALTER TABLE "suspension" ADD CONSTRAINT "ck_suspension_text_not_blank"
  CHECK (
    length(btrim("reason")) > 0
    AND length(btrim("suspended_by")) > 0
    AND length(btrim("suspended_correlation_id")) > 0
    AND ("reinstated_by" IS NULL OR length(btrim("reinstated_by")) > 0)
    AND ("reinstatement_note" IS NULL OR length(btrim("reinstatement_note")) > 0)
  );
