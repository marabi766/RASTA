-- =============================================================================
-- construction-service — contractor standing (CON-002 PR 5, ADR-067 § 4)
--
-- A read model of supplier-service's SUPPLIER_QUALIFIED / SUPPLIER_SUSPENDED /
-- SUPPLIER_REINSTATED. Folded so that any order and any replay gives the same
-- answer (see ContractorStandingRepository). No row means not eligible.
-- =============================================================================

-- CreateTable
CREATE TABLE "contractor_standing" (
    "organization_id" TEXT NOT NULL,
    "contracting_qualified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_standing_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "contractor_suspension" (
    "suspension_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "suspended_at" TIMESTAMP(3),
    "reinstated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_suspension_pkey" PRIMARY KEY ("suspension_id")
);

-- CreateTable
-- The bootstrap marker (ADR-061 § 4): one row, written when the standing is first
-- loaded from supplier-service's snapshot. The consumer group starts at the end of
-- a seven-day log, so what predates it is learned only from the snapshot; until
-- `completed_at` is set, nobody is eligible. Not tenant data (no organization).
CREATE TABLE "standing_bootstrap" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT,
    "suppliers_loaded" INTEGER NOT NULL DEFAULT 0,
    "source_snapshot_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standing_bootstrap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_contractor_suspension_org" ON "contractor_suspension"("organization_id", "suspension_id");

ALTER TABLE "contractor_standing" ADD CONSTRAINT "ck_standing_org_not_blank"
  CHECK (btrim("organization_id") <> '');

ALTER TABLE "contractor_suspension" ADD CONSTRAINT "ck_suspension_text_not_blank"
  CHECK (btrim("suspension_id") <> '' AND btrim("organization_id") <> '');

-- An episode is not lifted before it began, when both are known.
ALTER TABLE "contractor_suspension" ADD CONSTRAINT "ck_suspension_order"
  CHECK ("suspended_at" IS NULL OR "reinstated_at" IS NULL OR "reinstated_at" >= "suspended_at");

-- One marker row; a completed bootstrap names the snapshot instant it read.
ALTER TABLE "standing_bootstrap" ADD CONSTRAINT "ck_standing_bootstrap_singleton" CHECK ("id" = 1);
ALTER TABLE "standing_bootstrap" ADD CONSTRAINT "ck_standing_bootstrap_complete"
  CHECK ("suppliers_loaded" >= 0 AND ("completed_at" IS NULL OR "source_snapshot_at" IS NOT NULL));

-- Once complete, the marker never becomes incomplete and is never removed: a
-- rebuild is `down.sql` and the migration again, not an edit (docs/runbooks).
CREATE FUNCTION "standing_bootstrap_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ck_standing_bootstrap_immutable: the bootstrap marker is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL
     AND (NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
          OR NEW."source_snapshot_at" IS DISTINCT FROM OLD."source_snapshot_at") THEN
    RAISE EXCEPTION 'ck_standing_bootstrap_immutable: a completed bootstrap is not reopened or rewritten'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_standing_bootstrap_guard"
  BEFORE UPDATE OR DELETE ON "standing_bootstrap"
  FOR EACH ROW EXECUTE FUNCTION "standing_bootstrap_guard"();
