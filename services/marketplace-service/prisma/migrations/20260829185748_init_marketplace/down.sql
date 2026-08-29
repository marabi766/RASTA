-- =============================================================================
-- Reverse of `migration.sql`.
--
-- AGENTS.md § 7 requires every migration to be reversible. Prisma has no
-- built-in down migration, so the reverse is written by hand and lives beside
-- the forward one — Prisma reads only `migration.sql` and ignores this file.
--
-- Applied with:
--
--   psql "$DATABASE_URL_MARKETPLACE" -v ON_ERROR_STOP=1 \
--     -f prisma/migrations/20260829185748_init_marketplace/down.sql
--
-- and verified by `scripts/verify-migration-reversible.mjs`, which runs
-- up → down → up against a throwaway schema. A down script that is written and
-- never executed is a claim, not a capability.
--
-- ## What reversing this means
--
-- It drops the entire marketplace schema. That is correct for the *initial*
-- migration — before it there were no orders. Any later migration's down
-- script must be written to preserve placed orders: the forward direction may
-- add a column, and the reverse must drop that column rather than the table it
-- lives on.
--
-- Order matters: dependent tables before the ones they reference, then the
-- enum types nothing references any more. The extension is deliberately NOT
-- dropped — `pg_trgm` is installed cluster-wide into template1 by the
-- platform's bootstrap script and is shared with every other database.
-- =============================================================================

-- ---- Tables, dependants first -----------------------------------------------
DROP TABLE IF EXISTS "review";
DROP TABLE IF EXISTS "order_dispute";
DROP TABLE IF EXISTS "order_status_history";
DROP TABLE IF EXISTS "fulfillment";
DROP TABLE IF EXISTS "order_line";
DROP TABLE IF EXISTS "order";
DROP TABLE IF EXISTS "offer_price_history";
DROP TABLE IF EXISTS "offer";
DROP TABLE IF EXISTS "product";

-- ---- Infrastructure ----------------------------------------------------------
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_message";

-- ---- Enum types --------------------------------------------------------------
DROP TYPE IF EXISTS "IdempotencyState";
DROP TYPE IF EXISTS "OrderHistoryKind";
DROP TYPE IF EXISTS "DisputeStatus";
DROP TYPE IF EXISTS "ProductKind";
DROP TYPE IF EXISTS "ProductStatus";
DROP TYPE IF EXISTS "OfferStatus";
DROP TYPE IF EXISTS "OrderStatus";

-- ---- Prisma's own bookkeeping ------------------------------------------------
-- Removing the row lets `migrate deploy` reapply the forward migration, which
-- is what makes the up → down → up verification meaningful rather than a no-op.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260829185748_init_marketplace';
