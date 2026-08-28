-- =============================================================================
-- Reverse of `migration.sql`.
--
-- AGENTS.md § 7 requires every migration to be reversible. Prisma has no
-- built-in down migration, so the reverse is written by hand and lives beside
-- the forward one — Prisma reads only `migration.sql` and ignores this file.
--
-- Applied with:
--
--   psql "$DATABASE_URL_ECONOMIC" -v ON_ERROR_STOP=1 \
--     -f prisma/migrations/20260828202043_init_economic/down.sql
--
-- and verified in CI by `scripts/verify-migration-reversible.mjs`, which runs
-- up → down → up against a throwaway database. A down script that is written
-- and never executed is a claim, not a capability.
--
-- ## What reversing this means
--
-- It drops the entire financial schema. That is correct for the *initial*
-- migration — before it there was no ledger — and it is the reason this file is
-- safe to hold. Any later migration's down script must be written to preserve
-- posted ledger entries: the forward direction may add a column, and the
-- reverse must drop that column rather than the table it lives on.
--
-- Order matters. Triggers and their functions go first so that dropping the
-- tables underneath them cannot be blocked, then tables in dependency order,
-- then the enum types nothing references any more.
-- =============================================================================

-- ---- Triggers and their functions -------------------------------------------
DROP TRIGGER IF EXISTS "trg_journal_balanced" ON "ledger_entry";
DROP TRIGGER IF EXISTS "trg_ledger_entry_immutable" ON "ledger_entry";
DROP TRIGGER IF EXISTS "trg_journal_immutable" ON "journal";

DROP FUNCTION IF EXISTS assert_journal_balanced();
DROP FUNCTION IF EXISTS reject_ledger_mutation();
DROP FUNCTION IF EXISTS reject_journal_mutation();

-- ---- Tables, dependants first ------------------------------------------------
DROP TABLE IF EXISTS "settlement";
DROP TABLE IF EXISTS "commission";
DROP TABLE IF EXISTS "reward";
DROP TABLE IF EXISTS "reward_balance";
DROP TABLE IF EXISTS "reward_level";
DROP TABLE IF EXISTS "reward_rule";
DROP TABLE IF EXISTS "commission_rule";
DROP TABLE IF EXISTS "payment_intent";
DROP TABLE IF EXISTS "transaction_leg";
DROP TABLE IF EXISTS "transaction";
DROP TABLE IF EXISTS "wallet_hold";
DROP TABLE IF EXISTS "wallet";
DROP TABLE IF EXISTS "ledger_entry";
DROP TABLE IF EXISTS "journal";
DROP TABLE IF EXISTS "ledger_account";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_message";

-- ---- Enum types --------------------------------------------------------------
DROP TYPE IF EXISTS "IdempotencyState";
DROP TYPE IF EXISTS "PeriodType";
DROP TYPE IF EXISTS "RewardType";
DROP TYPE IF EXISTS "RuleStatus";
DROP TYPE IF EXISTS "PaymentIntentStatus";
DROP TYPE IF EXISTS "LegRole";
DROP TYPE IF EXISTS "TransactionStatus";
DROP TYPE IF EXISTS "TransactionType";
DROP TYPE IF EXISTS "HoldStatus";
DROP TYPE IF EXISTS "WalletStatus";
DROP TYPE IF EXISTS "EntryDirection";
DROP TYPE IF EXISTS "JournalType";
DROP TYPE IF EXISTS "AccountStatus";
DROP TYPE IF EXISTS "AccountPurpose";
DROP TYPE IF EXISTS "AccountType";

-- ---- Prisma's own bookkeeping ------------------------------------------------
-- Removing the row lets `migrate deploy` reapply the forward migration, which
-- is what makes the up → down → up verification meaningful rather than a
-- no-op.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260828202043_init_economic';
