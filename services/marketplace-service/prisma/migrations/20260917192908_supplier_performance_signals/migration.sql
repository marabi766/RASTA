-- =============================================================================
-- ADR-052 § 1-a / 1-b / 1-c — the performance-signal producers.
--
-- `ix_product_search` (the trigram GIN index from `20260829185748_init_
-- marketplace`) is deliberately left untouched. Prisma's own diff proposed
-- dropping it: that index was hand-written raw SQL outside the Prisma DSL
-- (ADR-042 — Prisma has no directive for `gin_trgm_ops`), so `prisma migrate
-- dev` sees it as drift against a schema that never declared it and offers to
-- "fix" that by deleting production search infrastructure unrelated to this
-- change. The proposed `DROP INDEX` line has been removed from this file for
-- that reason.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ResponsibilityAttribution" AS ENUM ('SUPPLIER', 'BUYER', 'PLATFORM', 'UNDETERMINED');

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "cancellation_cause" "ResponsibilityAttribution",
ADD COLUMN     "promised_delivery_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order_dispute" ADD COLUMN     "responsibility" "ResponsibilityAttribution";

-- =============================================================================
-- Rule 14 / rule 13 (ADR-052 § 4): the two derived facts this step introduces
-- must never be silently absent once the row reaches the state that requires
-- them. `UNDETERMINED` is the honest "we could not tell" — a real enum value,
-- not a NULL standing in for it — so a CANCELLED order or a resolved dispute
-- always names one of the four values, never none.
-- =============================================================================

-- CreateCheckConstraint
ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_cancelled_has_cause"
  CHECK ("status" <> 'CANCELLED' OR "cancellation_cause" IS NOT NULL);

-- CreateCheckConstraint
ALTER TABLE "order_dispute"
  ADD CONSTRAINT "ck_dispute_resolved_has_responsibility"
  CHECK (
    "status" NOT IN ('RESOLVED_SETTLE', 'RESOLVED_REFUND')
    OR "responsibility" IS NOT NULL
  );
