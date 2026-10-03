-- =============================================================================
-- audit-service — the payment-reconciliation evidence projection (D-046, ADR-064 § 6)
--
-- One append-only row per PAYMENT_RECONCILIATION_RESOLVED and per
-- PAYMENT_RECONCILIATION_OPERATOR_ACTION on `rasta.economic.v1`, written in the
-- same transaction as the event's `audit_event` row (whose id it carries). It keeps
-- an ALLOW-LISTED, VERSIONED projection of the payload: who proposed, who approved
-- or acted, on which evidence reference, with which outcome or action code, and
-- whether four-eyes applied. Nothing else.
--
--   * No free text: economic never puts a reason on these events, and every text
--     column here is a closed code, an identifier (printable ASCII, no whitespace)
--     or the pattern-checked evidence reference — the same pattern as economic's
--     `ck_payment_resolution_evidence`.
--   * No amounts, no currency, no provider name.
--   * `projection_version` names the shape a row was written under. Version 1 is
--     the only one; a later shape adds its number to the CHECK in its own migration
--     and leaves version-1 rows as they are.
--
-- The CHECKs restate the consumer's contract (`payment-reconciliation-projection.ts`),
-- so a row that does not satisfy it cannot exist even if that code were wrong: the
-- consumer refuses such an event to the dead-letter topic and writes nothing.
--
-- Same privilege split as the rest of this schema: the migrator owns the table, the
-- runtime role `rasta_audit` holds SELECT and INSERT and nothing else, and a trigger
-- refuses UPDATE, DELETE and TRUNCATE for everybody (the owner included, until it
-- drops the trigger on purpose).
-- =============================================================================

-- CreateTable
CREATE TABLE "payment_reconciliation_evidence" (
    "source_event_id" VARCHAR(128) NOT NULL,
    "audit_event_id" VARCHAR(64) NOT NULL,
    "projection_version" SMALLINT NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "event_name" VARCHAR(64) NOT NULL,
    "payment_intent_id" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "operator_action" VARCHAR(16),
    "actor" VARCHAR(256),
    "resolution" VARCHAR(32),
    "resolved_by" VARCHAR(256),
    "provider_outcome" VARCHAR(16),
    "resolution_id" VARCHAR(128),
    "requeue_id" VARCHAR(128),
    "proposed_by" VARCHAR(256),
    "approved_by" VARCHAR(256),
    "evidence_reference" VARCHAR(128),
    "four_eyes" BOOLEAN,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_reconciliation_evidence_pkey" PRIMARY KEY ("source_event_id")
);

CREATE UNIQUE INDEX "ux_payment_reconciliation_evidence_audit_event"
  ON "payment_reconciliation_evidence"("audit_event_id");

-- "Everything that happened to this intent's reconciliation", inside one tenant.
CREATE INDEX "ix_payment_reconciliation_evidence_intent"
  ON "payment_reconciliation_evidence"("organization_id", "payment_intent_id", "occurred_at");

-- Version 1 is the only shape. A later one is added here by its own migration.
ALTER TABLE "payment_reconciliation_evidence" ADD CONSTRAINT "ck_payment_reconciliation_evidence_version"
  CHECK ("projection_version" = 1);

-- Closed codes, the identifier shape, and the evidence pattern. An identifier is
-- printable ASCII without whitespace: an id or a service actor, never prose.
ALTER TABLE "payment_reconciliation_evidence" ADD CONSTRAINT "ck_payment_reconciliation_evidence_values"
  CHECK (
    btrim("organization_id") <> '' AND btrim("payment_intent_id") <> ''
    AND btrim("source_event_id") <> '' AND btrim("audit_event_id") <> ''
    AND "event_name" IN ('PAYMENT_RECONCILIATION_RESOLVED', 'PAYMENT_RECONCILIATION_OPERATOR_ACTION')
    AND "kind" IN ('REFUND', 'UNCREDITED_REFUND')
    AND ("operator_action" IS NULL OR "operator_action" IN ('REQUEUED', 'PROPOSED', 'REJECTED'))
    AND ("provider_outcome" IS NULL OR "provider_outcome" IN ('REFUNDED', 'DECLINED', 'NOT_REACHED'))
    AND ("resolution" IS NULL OR "resolution" IN (
          'REFUNDED', 'REFUND_DECLINED', 'REFUND_NOT_REACHED', 'UNCREDITED_REFUNDED',
          'UNCREDITED_DECLINED', 'UNCREDITED_NOT_REACHED', 'NOTHING_TO_RECONCILE'))
    AND ("actor" IS NULL OR "actor" ~ '^[!-~]+$')
    AND ("resolved_by" IS NULL OR "resolved_by" ~ '^[!-~]+$')
    AND ("proposed_by" IS NULL OR "proposed_by" ~ '^[!-~]+$')
    AND ("approved_by" IS NULL OR "approved_by" ~ '^[!-~]+$')
    AND ("resolution_id" IS NULL OR "resolution_id" ~ '^[!-~]+$')
    AND ("requeue_id" IS NULL OR "requeue_id" ~ '^[!-~]+$')
    AND ("evidence_reference" IS NULL
         OR "evidence_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$')
  );

-- Which fields each event carries (docs/events, ADR-064 § 6 "as built"):
--
--   RESOLVED          a resolution code and who resolved it; an operator resolution
--                     also names the resolution, both actors, the evidence and
--                     four-eyes — all five, or none for the reconciler's own.
--   OPERATOR_ACTION   REQUEUED names its requeue row and nothing of a resolution;
--                     PROPOSED and REJECTED name the resolution, its proposed
--                     outcome, its evidence and its proposer. Every action says
--                     whether four-eyes applied.
ALTER TABLE "payment_reconciliation_evidence" ADD CONSTRAINT "ck_payment_reconciliation_evidence_shape"
  CHECK (
    (
      "event_name" = 'PAYMENT_RECONCILIATION_RESOLVED'
      AND "resolution" IS NOT NULL AND "resolved_by" IS NOT NULL
      AND "operator_action" IS NULL AND "actor" IS NULL
      AND "requeue_id" IS NULL AND "provider_outcome" IS NULL
      AND (
        ("resolution_id" IS NULL AND "proposed_by" IS NULL AND "approved_by" IS NULL
         AND "evidence_reference" IS NULL AND "four_eyes" IS NULL)
        OR
        ("resolution_id" IS NOT NULL AND "proposed_by" IS NOT NULL AND "approved_by" IS NOT NULL
         AND "evidence_reference" IS NOT NULL AND "four_eyes" IS NOT NULL)
      )
    )
    OR
    (
      "event_name" = 'PAYMENT_RECONCILIATION_OPERATOR_ACTION'
      AND "operator_action" IS NOT NULL AND "actor" IS NOT NULL AND "four_eyes" IS NOT NULL
      AND "resolution" IS NULL AND "resolved_by" IS NULL AND "approved_by" IS NULL
      AND (
        ("operator_action" = 'REQUEUED'
         AND "requeue_id" IS NOT NULL AND "resolution_id" IS NULL AND "provider_outcome" IS NULL
         AND "evidence_reference" IS NULL AND "proposed_by" IS NULL)
        OR
        ("operator_action" IN ('PROPOSED', 'REJECTED')
         AND "requeue_id" IS NULL AND "resolution_id" IS NOT NULL AND "provider_outcome" IS NOT NULL
         AND "evidence_reference" IS NOT NULL AND "proposed_by" IS NOT NULL)
      )
    )
  );

-- =============================================================================
-- Append-only, for everybody
-- =============================================================================

CREATE FUNCTION "payment_reconciliation_evidence_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_payment_reconciliation_evidence_append_only: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_payment_reconciliation_evidence_append_only"
  BEFORE UPDATE OR DELETE ON "payment_reconciliation_evidence"
  FOR EACH ROW EXECUTE FUNCTION "payment_reconciliation_evidence_append_only"();
CREATE TRIGGER "tg_payment_reconciliation_evidence_no_truncate"
  BEFORE TRUNCATE ON "payment_reconciliation_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "payment_reconciliation_evidence_append_only"();

-- The runtime role reads and appends; it owns nothing here.
GRANT SELECT, INSERT ON "payment_reconciliation_evidence" TO rasta_audit;
