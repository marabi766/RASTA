-- =============================================================================
-- Reverse of `migration.sql` (COM-007 PR 6).
--
-- Refuses, and changes nothing, while any RFQ exists: each is the record of what a buyer asked
-- suppliers for, under which criteria and deadline, and the only home of its sealing key — and
-- its aggregation is RFQ_ISSUED, a status that names it. With none, it drops the aggregation's
-- reference, the guards and the three tables. Aggregations keep `rfq_id` (NULL on every row then),
-- as PR 1 created it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "rfq") THEN
    RAISE EXCEPTION 'refusing to reverse 20261022120000_rfq_issue: rfq holds issued RFQs, refusing to drop them, their criteria, invitations and sealing keys';
  END IF;
END
$$;

ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "fk_demand_aggregation_rfq";

DROP TRIGGER IF EXISTS "tg_rfq_invitation_count_check" ON "rfq_invitation";
DROP TRIGGER IF EXISTS "tg_rfq_invitation_no_truncate" ON "rfq_invitation";
DROP TRIGGER IF EXISTS "tg_rfq_invitation_guard" ON "rfq_invitation";
DROP TRIGGER IF EXISTS "tg_rfq_criterion_count_check" ON "rfq_criterion";
DROP TRIGGER IF EXISTS "tg_rfq_criterion_no_truncate" ON "rfq_criterion";
DROP TRIGGER IF EXISTS "tg_rfq_criterion_guard" ON "rfq_criterion";
DROP TRIGGER IF EXISTS "tg_rfq_issue_check" ON "rfq";
DROP TRIGGER IF EXISTS "tg_rfq_no_truncate" ON "rfq";
DROP TRIGGER IF EXISTS "tg_rfq_guard" ON "rfq";
DROP TRIGGER IF EXISTS "tg_rfq_born" ON "rfq";

DROP TABLE IF EXISTS "rfq_invitation";
DROP TABLE IF EXISTS "rfq_criterion";
DROP TABLE IF EXISTS "rfq";

DROP FUNCTION IF EXISTS "rfq_issue_check"();
DROP FUNCTION IF EXISTS "rfq_child_guard"();
DROP FUNCTION IF EXISTS "rfq_guard"();
DROP FUNCTION IF EXISTS "rfq_born_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022120000_rfq_issue';
