-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops the two CHECK constraints, the two new columns and the enum type, in
-- the order that respects the dependency between them (a column using the
-- type must go before the type itself). No data is destroyed beyond the
-- values held in the three new columns: nothing else on `order` or
-- `order_dispute` is touched, and no row is deleted.
--
-- `ix_product_search` is not mentioned here for the same reason it is not
-- mentioned in `migration.sql`: this migration never touched it.
-- =============================================================================

ALTER TABLE "order_dispute" DROP CONSTRAINT "ck_dispute_resolved_has_responsibility";
ALTER TABLE "order" DROP CONSTRAINT "ck_order_cancelled_has_cause";

ALTER TABLE "order_dispute" DROP COLUMN "responsibility";
ALTER TABLE "order" DROP COLUMN "cancellation_cause";
ALTER TABLE "order" DROP COLUMN "promised_delivery_at";

DROP TYPE "ResponsibilityAttribution";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260917192908_supplier_performance_signals';
