-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountPurpose" AS ENUM ('WALLET', 'ESCROW', 'COMMISSION_REVENUE', 'REWARD_EXPENSE', 'PAYMENT_CLEARING');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('WALLET_TOP_UP', 'FUNDS_HELD', 'FUNDS_REFUNDED', 'SETTLEMENT', 'REWARD_GRANT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('MARKETPLACE_ORDER', 'MAINTENANCE_SERVICE', 'LOGISTICS', 'CONSTRUCTION_STATEMENT', 'PROCUREMENT_ORDER', 'WALLET_TOP_UP');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'HELD', 'PENDING_SETTLEMENT', 'DISPUTED', 'SETTLED', 'REFUNDED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "LegRole" AS ENUM ('PAYER', 'PAYEE', 'PLATFORM');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('POINTS', 'CASHBACK');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "ledger_account" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_type" "AccountType" NOT NULL,
    "account_code" TEXT NOT NULL,
    "purpose" "AccountPurpose" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT,
    "journal_type" "JournalType" NOT NULL,
    "description" TEXT NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "posted_by" TEXT NOT NULL,
    "reverses_id" TEXT,
    "reversal_reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" TEXT NOT NULL,
    "journal_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "ledger_account_id" TEXT NOT NULL,
    "ledger_balance_minor" BIGINT NOT NULL DEFAULT 0,
    "pending_balance_minor" BIGINT NOT NULL DEFAULT 0,
    "available_balance_minor" BIGINT NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_hold" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "reference" TEXT NOT NULL,
    "reference_type" TEXT NOT NULL,
    "placed_journal_id" TEXT,
    "resolved_journal_id" TEXT,
    "placed_at" TIMESTAMP(3) NOT NULL,
    "placed_by" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolution_note" TEXT,

    CONSTRAINT "wallet_hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "counterparty_organization_id" TEXT,
    "transaction_type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "gross_amount_minor" BIGINT NOT NULL,
    "commission_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "net_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source_type" TEXT,
    "source_reference" TEXT,
    "idempotency_key" TEXT,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "disputed_at" TIMESTAMP(3),
    "disputed_by" TEXT,
    "dispute_reason" TEXT,
    "dispute_resolved_at" TIMESTAMP(3),
    "dispute_resolved_by" TEXT,
    "settled_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_leg" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "LegRole" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "transaction_leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "transaction_id" TEXT,
    "provider" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "provider_reference" TEXT,
    "failure_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorized_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,

    CONSTRAINT "payment_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_rule" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "transaction_type" "TransactionType" NOT NULL,
    "rate_basis_points" INTEGER NOT NULL,
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "commission_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "rate_basis_points" INTEGER NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "journal_id" TEXT,
    "applied_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_rule" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "trigger_event" TEXT NOT NULL,
    "reward_type" "RewardType" NOT NULL DEFAULT 'POINTS',
    "condition" JSONB,
    "points" INTEGER NOT NULL,
    "credit_per_point_minor" BIGINT,
    "period_cap" INTEGER,
    "period_type" "PeriodType",
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "reward_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "trigger_event" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "credit_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "monetised" BOOLEAN NOT NULL DEFAULT false,
    "journal_id" TEXT,
    "period_key" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_level" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "min_points" INTEGER NOT NULL,
    "benefits" JSONB,
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "reward_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_balance" (
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "level_id" TEXT,
    "lifetime_credit_minor" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_balance_pkey" PRIMARY KEY ("organization_id","user_id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "journal_id" TEXT NOT NULL,
    "payer_organization_id" TEXT NOT NULL,
    "payee_organization_id" TEXT NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "commission_amount_minor" BIGINT NOT NULL,
    "net_amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "settled_at" TIMESTAMP(3) NOT NULL,
    "settled_by" TEXT NOT NULL,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "state" "IdempotencyState" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id","endpoint","key")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "organization_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_event" (
    "event_id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer_name")
);

-- CreateIndex
CREATE INDEX "ledger_account_organization_id_account_type_idx" ON "ledger_account"("organization_id", "account_type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_organization_id_account_code_currency_key" ON "ledger_account"("organization_id", "account_code", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_organization_id_purpose_currency_key" ON "ledger_account"("organization_id", "purpose", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "journal_reverses_id_key" ON "journal"("reverses_id");

-- CreateIndex
CREATE INDEX "journal_organization_id_posted_at_idx" ON "journal"("organization_id", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "journal_transaction_id_idx" ON "journal"("transaction_id");

-- CreateIndex
CREATE INDEX "ledger_entry_account_id_posted_at_idx" ON "ledger_entry"("account_id", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entry_journal_id_idx" ON "ledger_entry"("journal_id");

-- CreateIndex
CREATE INDEX "ledger_entry_organization_id_posted_at_idx" ON "ledger_entry"("organization_id", "posted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ledger_account_id_key" ON "wallet"("ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_organization_id_currency_key" ON "wallet"("organization_id", "currency");

-- CreateIndex
CREATE INDEX "wallet_hold_organization_id_status_idx" ON "wallet_hold"("organization_id", "status");

-- CreateIndex
CREATE INDEX "wallet_hold_reference_idx" ON "wallet_hold"("reference");

-- CreateIndex
CREATE INDEX "transaction_organization_id_status_occurred_at_idx" ON "transaction"("organization_id", "status", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "transaction_organization_id_source_type_source_reference_idx" ON "transaction"("organization_id", "source_type", "source_reference");

-- CreateIndex
CREATE INDEX "transaction_counterparty_organization_id_status_idx" ON "transaction"("counterparty_organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_organization_id_idempotency_key_key" ON "transaction"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "transaction_leg_organization_id_idx" ON "transaction_leg"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_leg_transaction_id_role_key" ON "transaction_leg"("transaction_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_transaction_id_key" ON "payment_intent"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_intent_organization_id_status_created_at_idx" ON "payment_intent"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_organization_id_idempotency_key_key" ON "payment_intent"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "commission_rule_transaction_type_status_valid_from_idx" ON "commission_rule"("transaction_type", "status", "valid_from");

-- CreateIndex
CREATE INDEX "commission_rule_organization_id_transaction_type_status_idx" ON "commission_rule"("organization_id", "transaction_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_transaction_id_key" ON "commission"("transaction_id");

-- CreateIndex
CREATE INDEX "commission_organization_id_applied_at_idx" ON "commission"("organization_id", "applied_at" DESC);

-- CreateIndex
CREATE INDEX "reward_rule_trigger_event_status_valid_from_idx" ON "reward_rule"("trigger_event", "status", "valid_from");

-- CreateIndex
CREATE INDEX "reward_rule_organization_id_trigger_event_status_idx" ON "reward_rule"("organization_id", "trigger_event", "status");

-- CreateIndex
CREATE INDEX "reward_organization_id_user_id_rule_id_period_key_idx" ON "reward"("organization_id", "user_id", "rule_id", "period_key");

-- CreateIndex
CREATE INDEX "reward_organization_id_granted_at_idx" ON "reward"("organization_id", "granted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reward_rule_id_source_reference_key" ON "reward"("rule_id", "source_reference");

-- CreateIndex
CREATE INDEX "reward_level_status_min_points_idx" ON "reward_level"("status", "min_points");

-- CreateIndex
CREATE UNIQUE INDEX "reward_level_organization_id_rank_key" ON "reward_level"("organization_id", "rank");

-- CreateIndex
CREATE INDEX "reward_balance_organization_id_total_points_idx" ON "reward_balance"("organization_id", "total_points" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_transaction_id_key" ON "settlement"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_journal_id_key" ON "settlement"("journal_id");

-- CreateIndex
CREATE INDEX "settlement_organization_id_settled_at_idx" ON "settlement"("organization_id", "settled_at" DESC);

-- CreateIndex
CREATE INDEX "settlement_payee_organization_id_settled_at_idx" ON "settlement"("payee_organization_id", "settled_at" DESC);

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_message"("created_at");

-- CreateIndex
CREATE INDEX "processed_event_processed_at_idx" ON "processed_event"("processed_at");

-- AddForeignKey
ALTER TABLE "journal" ADD CONSTRAINT "journal_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_hold" ADD CONSTRAINT "wallet_hold_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_leg" ADD CONSTRAINT "transaction_leg_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "commission_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward" ADD CONSTRAINT "reward_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "reward_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_balance" ADD CONSTRAINT "reward_balance_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "reward_level"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Financial invariants
--
-- Everything below this line is the part of this service that TypeScript cannot
-- enforce. A correction script, a careless ORM call, a psql session or a
-- hurried developer can all bypass the domain layer; none of them can bypass
-- PostgreSQL (docs/05 § 5.4, ADR-013).
--
-- The rule applied throughout: if an invariant can be expressed as a constraint,
-- it is a constraint. The application still checks the same things first, but
-- only so that the caller gets a meaningful error code instead of a driver
-- exception — never as the enforcement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ledger immutability — the foundational rule (AGENTS.md A-06)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entry is append-only. Correct with a reversal journal, never UPDATE/DELETE.'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- A journal is immutable for the same reason its entries are.
--
-- docs/05 § 5.4 mandates the trigger only on `ledger_entry`, but a mutable
-- header over immutable lines is a gap: rewriting a journal's description or
-- its posted_at changes what the entries mean without touching them. There is
-- no code path that updates a journal — whether one has been reversed is
-- answered by looking for the journal whose `reverses_id` points at it — so
-- this costs nothing and closes the gap.
CREATE OR REPLACE FUNCTION reject_journal_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'journal is append-only. Correct with a reversal journal, never UPDATE/DELETE.'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_immutable
  BEFORE UPDATE OR DELETE ON "journal"
  FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();

-- The self-referencing foreign key Prisma generated is ON DELETE SET NULL,
-- which would attempt an UPDATE the trigger above rejects. Journals are never
-- deleted, so it could never fire — but a constraint whose action is impossible
-- is a trap for whoever reads it next.
ALTER TABLE "journal" DROP CONSTRAINT "journal_reverses_id_fkey";
ALTER TABLE "journal"
  ADD CONSTRAINT "journal_reverses_id_fkey"
  FOREIGN KEY ("reverses_id") REFERENCES "journal"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- -----------------------------------------------------------------------------
-- 2. Every posted journal balances — checked by the database, at commit
--
-- This is the single most important property in the platform: docs/10 § 10.12
-- lists it first among the mandatory financial-integrity tests, and ADR-013
-- makes it a merge gate. The domain checks it before writing, so a caller gets
-- LEDGER_UNBALANCED rather than a driver error; this trigger is what makes the
-- property true regardless of which code path did the writing.
--
-- It is a DEFERRABLE INITIALLY DEFERRED constraint trigger because the entries
-- of one journal arrive as several rows: checking after each would fail on the
-- first leg of a journal that is perfectly balanced by its third. Deferred
-- means "checked once, at COMMIT, when the transaction has finished saying
-- what it means".
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  unbalanced RECORD;
  leg_count  INTEGER;
BEGIN
  SELECT COUNT(*) INTO leg_count FROM "ledger_entry" WHERE "journal_id" = NEW."journal_id";

  -- A single-legged journal is not double-entry bookkeeping. Checked here
  -- rather than trusted, because the balance test below would pass trivially
  -- for a journal with no rows left after a partial failure.
  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'journal % has % ledger entries; a balanced journal needs at least two',
      NEW."journal_id", leg_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- Per currency, because a journal that nets to zero only by treating two
  -- currencies as interchangeable is not balanced (docs/10 § 10.4).
  SELECT "currency",
         SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE -"amount_minor" END) AS delta
    INTO unbalanced
    FROM "ledger_entry"
   WHERE "journal_id" = NEW."journal_id"
   GROUP BY "currency"
  HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE -"amount_minor" END) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'journal % does not balance in %: debits minus credits = %',
      NEW."journal_id", unbalanced."currency", unbalanced.delta
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT ON "ledger_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- -----------------------------------------------------------------------------
-- 3. Ledger entries
-- -----------------------------------------------------------------------------

-- Amount is always positive; the sign lives in `direction` (docs/05 § 5.4).
-- Written this way so "sum the debits" is a filter rather than a conditional,
-- and so an entry of zero — which asserts nothing and balances nothing — is
-- impossible.
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ck_ledger_entry_amount_positive"
  CHECK ("amount_minor" > 0);

-- An entry belongs to its account's organization and its account's currency.
--
-- Expressed as a composite foreign key rather than as application logic,
-- because both ways this could go wrong are silent: posting a rial entry to a
-- foreign-currency account would make the balance meaningless, and posting an
-- entry under the wrong organization would put one tenant's movement into
-- another's statement — the statement query reads `ledger_entry.organization_id`.
ALTER TABLE "ledger_account"
  ADD CONSTRAINT "uq_ledger_account_identity"
  UNIQUE ("id", "organization_id", "currency");

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "fk_ledger_entry_account_identity"
  FOREIGN KEY ("account_id", "organization_id", "currency")
  REFERENCES "ledger_account" ("id", "organization_id", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- -----------------------------------------------------------------------------
-- 4. Journal shape
-- -----------------------------------------------------------------------------

-- A reversal names what it reverses and why; nothing else claims to be one.
--
-- Both halves matter. A REVERSAL with no target would be an ordinary journal
-- wearing the wrong label, and a journal that quietly reverses another without
-- declaring itself would make "has this been reversed" unanswerable from the
-- type alone.
ALTER TABLE "journal"
  ADD CONSTRAINT "ck_journal_reversal_shape"
  CHECK (
    ("journal_type" = 'REVERSAL' AND "reverses_id" IS NOT NULL AND "reversal_reason" IS NOT NULL)
    OR
    ("journal_type" <> 'REVERSAL' AND "reverses_id" IS NULL AND "reversal_reason" IS NULL)
  );

-- A journal cannot reverse itself.
ALTER TABLE "journal"
  ADD CONSTRAINT "ck_journal_no_self_reversal"
  CHECK ("reverses_id" IS NULL OR "reverses_id" <> "id");

-- -----------------------------------------------------------------------------
-- 5. Wallet — the invariant that makes an overspend impossible
--
-- docs/10 § 10.3 states it:
--
--   available = ledger - pending,  and none of the three is ever negative.
--
-- The application checks `available >= amount` before placing a hold, under a
-- row lock. That check produces the INSUFFICIENT_BALANCE error a user should
-- see. **It is not what prevents the overspend** — this constraint is. If the
-- lock were ever taken wrongly, or a new code path forgot it, the write fails
-- here rather than leaving a wallet owing money it never had.
-- -----------------------------------------------------------------------------

ALTER TABLE "wallet"
  ADD CONSTRAINT "ck_wallet_balances"
  CHECK (
    "ledger_balance_minor" >= 0 AND
    "pending_balance_minor" >= 0 AND
    "available_balance_minor" >= 0 AND
    "available_balance_minor" = "ledger_balance_minor" - "pending_balance_minor"
  );

-- A wallet and the ledger account it projects agree on organization and
-- currency. Same composite-key technique, same reason.
ALTER TABLE "wallet"
  ADD CONSTRAINT "fk_wallet_account_identity"
  FOREIGN KEY ("ledger_account_id", "organization_id", "currency")
  REFERENCES "ledger_account" ("id", "organization_id", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- -----------------------------------------------------------------------------
-- 6. Holds
-- -----------------------------------------------------------------------------

ALTER TABLE "wallet_hold"
  ADD CONSTRAINT "ck_wallet_hold_amount_positive"
  CHECK ("amount_minor" > 0);

-- A resolved hold says when and through which journal; an active one claims
-- neither.
ALTER TABLE "wallet_hold"
  ADD CONSTRAINT "ck_wallet_hold_resolution"
  CHECK (
    ("status" = 'ACTIVE' AND "resolved_at" IS NULL AND "resolved_journal_id" IS NULL)
    OR
    ("status" <> 'ACTIVE' AND "resolved_at" IS NOT NULL AND "resolved_journal_id" IS NOT NULL)
  );

-- One live hold per obligation.
--
-- This is what makes `placeHold` idempotent at the database level rather than
-- at the application level: two concurrent retries of the same request both
-- pass an application "is there already a hold?" check, and exactly one of
-- them survives this index. Partial, because a refunded hold must not block a
-- legitimate second attempt on the same obligation.
CREATE UNIQUE INDEX "uq_wallet_hold_active_reference"
  ON "wallet_hold" ("wallet_id", "reference")
  WHERE "status" = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 7. Transactions
-- -----------------------------------------------------------------------------

-- Amounts are coherent at every point in the lifecycle, and exactly coherent
-- once settled. `net = gross - commission` is asserted only for a settled
-- transaction because before settlement both derived figures are zero and the
-- gross is not yet apportioned.
ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_amounts"
  CHECK (
    "gross_amount_minor" > 0 AND
    "commission_amount_minor" >= 0 AND
    "net_amount_minor" >= 0 AND
    "commission_amount_minor" <= "gross_amount_minor" AND
    ("status" <> 'SETTLED' OR
      "net_amount_minor" = "gross_amount_minor" - "commission_amount_minor")
  );

-- A settled transaction records when. A disputed one records why.
ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_settled_at"
  CHECK ("status" <> 'SETTLED' OR "settled_at" IS NOT NULL);

ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_dispute"
  CHECK (
    "status" <> 'DISPUTED' OR ("disputed_at" IS NOT NULL AND "dispute_reason" IS NOT NULL)
  );

-- A transaction has two distinct parties, or one party and the platform.
-- An organization paying itself is not an economic event, and it would let a
-- settlement debit and credit the same wallet under one lock.
ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_distinct_parties"
  CHECK (
    "counterparty_organization_id" IS NULL OR
    "counterparty_organization_id" <> "organization_id"
  );

ALTER TABLE "transaction_leg"
  ADD CONSTRAINT "ck_transaction_leg_amount_positive"
  CHECK ("amount_minor" > 0);

-- -----------------------------------------------------------------------------
-- 8. Payment intents
-- -----------------------------------------------------------------------------

ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_amount_positive"
  CHECK ("amount_minor" > 0);

-- Each terminal state records its own timestamp, and a captured payment must
-- have been authorised first — the lifecycle ADR-024 specifies, made
-- unforgeable rather than merely implemented.
ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_lifecycle"
  CHECK (
    ("status" <> 'AUTHORIZED' OR "authorized_at" IS NOT NULL) AND
    ("status" <> 'CAPTURED'   OR ("authorized_at" IS NOT NULL AND "captured_at" IS NOT NULL)) AND
    ("status" <> 'FAILED'     OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL)) AND
    ("status" <> 'REFUNDED'   OR ("captured_at" IS NOT NULL AND "refunded_at" IS NOT NULL))
  );

-- -----------------------------------------------------------------------------
-- 9. Commission — configuration, and what it produced
-- -----------------------------------------------------------------------------

-- A rate is an integer basis point between nothing and everything. 10 000 bp is
-- 100%; a commission larger than the transaction is not a rate, it is a bug.
ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ck_commission_rule_rate"
  CHECK ("rate_basis_points" >= 0 AND "rate_basis_points" <= 10000);

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ck_commission_rule_bounds"
  CHECK (
    ("min_amount_minor" IS NULL OR "min_amount_minor" >= 0) AND
    ("max_amount_minor" IS NULL OR "max_amount_minor" >= 0) AND
    ("min_amount_minor" IS NULL OR "max_amount_minor" IS NULL OR
      "min_amount_minor" <= "max_amount_minor")
  );

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ck_commission_rule_validity_window"
  CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");

ALTER TABLE "commission"
  ADD CONSTRAINT "ck_commission_amounts"
  CHECK (
    "rate_basis_points" >= 0 AND "rate_basis_points" <= 10000 AND
    "gross_amount_minor" > 0 AND
    "amount_minor" >= 0 AND
    "amount_minor" <= "gross_amount_minor"
  );

-- -----------------------------------------------------------------------------
-- 10. Reward — configuration, and what it produced (ADR-033)
-- -----------------------------------------------------------------------------

-- A rule grants at least one point. A rule granting zero should be INACTIVE,
-- and the difference matters: INACTIVE is a decision, zero is an accident.
ALTER TABLE "reward_rule"
  ADD CONSTRAINT "ck_reward_rule_points_positive"
  CHECK ("points" > 0);

-- The conversion rate, when present, is a real rate. Null means points-only —
-- the whole point of ADR-033 — so null is allowed and zero is not.
ALTER TABLE "reward_rule"
  ADD CONSTRAINT "ck_reward_rule_credit_rate"
  CHECK ("credit_per_point_minor" IS NULL OR "credit_per_point_minor" > 0);

-- A cap without a window is not a cap. Either both or neither.
ALTER TABLE "reward_rule"
  ADD CONSTRAINT "ck_reward_rule_period_cap"
  CHECK (
    ("period_cap" IS NULL AND "period_type" IS NULL)
    OR
    ("period_cap" IS NOT NULL AND "period_type" IS NOT NULL AND "period_cap" > 0)
  );

ALTER TABLE "reward_rule"
  ADD CONSTRAINT "ck_reward_rule_validity_window"
  CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");

-- `monetised` cannot lie. A monetised reward has credit and the journal that
-- expensed it; a points-only reward has neither. Without this the flag would be
-- a comment rather than a fact, and a consumer could not trust it.
ALTER TABLE "reward"
  ADD CONSTRAINT "ck_reward_monetisation"
  CHECK (
    "points" > 0 AND
    (
      ("monetised" = false AND "credit_amount_minor" = 0 AND "journal_id" IS NULL)
      OR
      ("monetised" = true AND "credit_amount_minor" > 0 AND "journal_id" IS NOT NULL)
    )
  );

ALTER TABLE "reward_level"
  ADD CONSTRAINT "ck_reward_level_thresholds"
  CHECK ("min_points" >= 0 AND "rank" >= 0);

ALTER TABLE "reward_balance"
  ADD CONSTRAINT "ck_reward_balance_non_negative"
  CHECK ("total_points" >= 0 AND "lifetime_credit_minor" >= 0);

-- -----------------------------------------------------------------------------
-- 11. Settlement
-- -----------------------------------------------------------------------------

-- The arithmetic of a settlement is exact, always — there is no lifecycle stage
-- at which a settlement row exists with provisional figures.
ALTER TABLE "settlement"
  ADD CONSTRAINT "ck_settlement_amounts"
  CHECK (
    "gross_amount_minor" > 0 AND
    "commission_amount_minor" >= 0 AND
    "net_amount_minor" >= 0 AND
    "net_amount_minor" = "gross_amount_minor" - "commission_amount_minor"
  );

ALTER TABLE "settlement"
  ADD CONSTRAINT "ck_settlement_distinct_parties"
  CHECK ("payer_organization_id" <> "payee_organization_id");

-- -----------------------------------------------------------------------------
-- 12. Idempotency
-- -----------------------------------------------------------------------------

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_expiry"
  CHECK ("expires_at" > "created_at");

-- A completed record carries the response it will replay; an in-progress one
-- has nothing to replay yet. Replaying a null body as a success would turn a
-- crashed first attempt into a fabricated confirmation.
ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_completed_response"
  CHECK (
    "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  );
