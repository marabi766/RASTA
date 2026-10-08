import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// -----------------------------------------------------------------------------
// What each service's migration chain must leave behind, and the SQL that
// checks it.
//
// Extracted from `verify-migration-reversible.mjs` for the same reason
// `verify-outbox-b1-lib.mjs` and `ci-image-matrix-lib.mjs` exist: the verifier
// is a CLI that does its work at import time, so nothing inside it can be
// unit-tested in place. Everything here is a pure function of constants, the
// verifier imports it, and `verify-migration-reversible-lib.test.mjs` exercises
// the same code the verifier runs rather than a copy of it.
//
// The split is along one line: this file is *what is expected*, the CLI is
// *how it is executed*.
// -----------------------------------------------------------------------------

/**
 * A cancelled-before-hold order, as the running service writes one.
 *
 * Every column the other CHECK constraints demand is populated, because a row
 * that only satisfies the constraint under test would not prove anything about
 * a real database: it has to be an order the service could genuinely have
 * produced.
 *
 * `cancellation_cause` is filled in for a `CANCELLED` row (never for
 * `FUNDS_HELD`, which this helper also produces at the last step below) so
 * that `ck_order_cancelled_has_cause` — added later by
 * `20260917192908_supplier_performance_signals` and, unlike
 * `ck_order_held_has_transaction`, not the constraint this probe exists to
 * test — never fires here and is mistaken for it.
 */
export const CANCELLED_BEFORE_HOLD = (id, status = 'CANCELLED') => `
INSERT INTO "order" (
  "id", "organization_id", "supplier_organization_id", "placed_by", "status",
  "total_amount_minor", "currency", "economic_transaction_id",
  "idempotency_key", "correlation_id",
  "cancelled_at", "cancellation_reason", "cancellation_cause",
  "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-BUYER', 'ORG-MIGCHECK-SUPPLIER', 'USR-MIGCHECK', '${status}',
  250000, 'IRR', NULL,
  'KEY-${id}', 'COR-${id}',
  NOW(), 'cancelled before the saga created the obligation',
  ${status === 'CANCELLED' ? `'BUYER'` : 'NULL'},
  'USR-MIGCHECK', NOW()
);`;

/**
 * The rollback of `20260830103500_cancel_before_hold`, run against data only
 * the migration it reverses permits.
 *
 * The whole-chain reversal below cannot test this. It runs every `down.sql` in
 * order against a schema that was created seconds earlier and holds no rows, so
 * a down script that works on an empty table and fails on a real one passes it
 * — and a constraint-restoring rollback is exactly the kind that does. This
 * one restores a *narrower* CHECK, which PostgreSQL validates against every
 * existing row unless told otherwise.
 *
 * The step that matters is `down` itself succeeding. With a plain
 * `ADD CONSTRAINT`, it aborts here with a constraint violation naming the
 * seeded order, and the rollback is left part-applied.
 */
export const MARKETPLACE_DATA_ROLLBACK = {
  migration: '20260830103500_cancel_before_hold',
  label: 'a cancellation that happened before the hold',
  steps: [
    {
      label: 'seed: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_BEFORE'),
    },
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, which would destroy the evidence this probe exists to check.
      label: 'down: the rollback succeeds with that order in the table',
      runDownScript: true,
    },
    {
      label: 'down: the order is still there, unaltered',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL
             AND cancellation_reason = 'cancelled before the saga created the obligation';
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the rollback did not preserve the cancelled-before-hold order (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'down: the restored constraint still refuses a new violating insert',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      // NOT VALID skips existing rows; it does not skip updates to them.
      // PostgreSQL checks the new row version, so a surviving row cannot be
      // edited into staying violating.
      label: 'down: the restored constraint still checks an update to the surviving row',
      sql: `UPDATE "order" SET cancellation_reason = 'edited'
             WHERE id = 'ORD_MIGCHECK_BEFORE';`,
      mustFail: 'ck_order_held_has_transaction',
    },
    { label: 'up again: the forward migration re-applies over the surviving order', reapply: true },
    {
      label: 'up again: the order survived the whole round trip',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION 'the order did not survive down → up (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
    },
    {
      // The constraint is genuinely restored and not merely absent: a status
      // that does hold money is still required to name a transaction.
      label: 'up again: the widened constraint is not vacuous',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_HELD', 'FUNDS_HELD'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      label: 'clean up the probe rows',
      sql: `DELETE FROM "order" WHERE id LIKE 'ORD_MIGCHECK%';`,
    },
  ],
};

/**
 * An infected document as the **init** schema permitted one: no quarantine
 * record, because the columns did not exist yet.
 *
 * Every column the init CHECK constraints demand is populated, so the row is
 * one the service of that era could genuinely have written.
 */
export const INFECTED_WITHOUT_QUARANTINE = (id) => `
INSERT INTO "document" (
  "id", "organization_id", "object_key", "document_class", "status",
  "content_type", "size_bytes", "filename",
  "scan_state", "scan_engine", "scan_version", "scan_signature", "scanned_at",
  "upload_intent_id", "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-DOC', 'ORG-MIGCHECK-DOC/CONTRACT/${id}', 'CONTRACT', 'REGISTERED',
  'application/pdf', 4096, 'infected.pdf',
  'INFECTED', 'clamav', '1.5.4', 'Eicar-Test-Signature', NOW(),
  'UPI_MIGCHECK_${id}', 'USR-MIGCHECK', NOW()
);`;

/**
 * The forward migration applied over data the schema it upgrades allowed.
 *
 * `ck_document_infected_is_quarantined` is validated against every existing
 * row the moment it is added, and the init schema permitted an `INFECTED`
 * document with no quarantine record. Nothing ever produced one — the only
 * scanner was a stub that inspects nothing — but "no deployment happens to
 * hold that row" is a different claim from "this migration is safe", and the
 * difference only surfaces on the deployment that does hold one.
 *
 * The whole-chain reversal below cannot test this. It runs against a schema
 * created seconds earlier holding no rows, so a forward migration that works
 * on an empty table and aborts halfway on a populated one passes it — leaving
 * the columns added and the constraints missing, which is the worst of the
 * three possible outcomes.
 *
 * The steps run in the order the harness executes them: roll this migration
 * back to the init schema, seed the row that schema allowed, re-apply, and
 * assert the row came back **quarantined** rather than merely surviving.
 */
export const DOCUMENT_DATA_ROLLBACK = {
  migration: '20260831180000_document_scan_lifecycle',
  label: 'an infected document registered before quarantine was recorded',
  steps: [
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, and this probe needs the init schema still standing.
      label: 'down: the rollback succeeds and leaves the init schema behind',
      runDownScript: true,
    },
    {
      label: 'down: the init schema accepts an infected document with no quarantine',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_INFECTED'),
    },
    { label: 'up again: the forward migration applies over that row', reapply: true },
    {
      label: 'up again: the row survived and was quarantined rather than left mid-policy',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "document"
           WHERE id = 'DOC_MIGCHECK_INFECTED'
             AND scan_state = 'INFECTED'
             AND scan_signature = 'Eicar-Test-Signature'
             AND quarantined_at IS NOT NULL
             AND quarantine_reason IS NOT NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the infected document was not carried through and quarantined (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: a new infected document with no quarantine is refused',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_REFUSED'),
      mustFail: 'ck_document_infected_is_quarantined',
    },
    {
      label: 'up again: a worker lease cannot be attached to a document that is not pending',
      sql: `UPDATE "document" SET scan_lease_owner = 'worker-1',
              scan_lease_expires_at = NOW() + INTERVAL '1 minute'
             WHERE id = 'DOC_MIGCHECK_INFECTED';`,
      mustFail: 'ck_document_scan_lease_only_when_pending',
    },
    {
      label: 'cleanup: the probe rows are removed before the chain reversal',
      sql: `DELETE FROM "document" WHERE id LIKE 'DOC_MIGCHECK_%';`,
    },
  ],
};

/** A payment intent as the schema before `20260930200000` holds it. */
const PAYMENT_INTENT_MIGCHECK = (id, status, failureReason) => `
INSERT INTO "payment_intent" (
  "id", "organization_id", "wallet_id", "provider", "amount_minor", "currency", "status",
  "failure_reason", "idempotency_key", "correlation_id", "authorized_at", "captured_at",
  "created_by"
) VALUES (
  '${id}', 'ORG-MIGCHECK', 'WLT_MIGCHECK', 'mock', 1000, 'IRR', '${status}',
  ${failureReason ? `'${failureReason}'` : 'NULL'}, 'KEY-${id}', 'COR-${id}', NOW(),
  ${status === 'CAPTURED' ? 'NOW()' : 'NULL'}, 'USR-MIGCHECK'
);`;

/**
 * The rollback of `20260930200000_payment_reconciliation_task`, against rows.
 *
 * Two things only data can show. The forward migration **backfills** a task
 * for every intent B0 (#143) already left marked, and nothing else; and the
 * down script **refuses** while a task is open, because dropping the queue
 * then would leave a held refund that nothing ever looks at again (ADR-064
 * step B1). The whole-chain reversal below runs on an empty table and sees
 * neither.
 *
 * Every later migration that hangs off the task table is rolled back first,
 * newest first (a `runDownScript` list runs in order), and re-applied with it:
 * B2's heal-window index and B3's resolution table. Rolling back the task
 * table alone dropped B2's index with it and the re-deploy never put it back
 * (the ledger still listed B2) — caught once B3's snapshot expected it. The
 * probe also shows B3's down script refusing while ANY resolution exists — a
 * decided one included, since those rows are the only record of the evidence
 * (Codex on #175, HIGH 2) — and the table refusing to delete one.
 */
const MEMBERSHIP_GUARD = '20261004100000_membership_live_duplicates_guard';
const MEMBERSHIP_GUARD_SQL = readFileSync(
  new URL(
    `../services/identity-service/prisma/migrations/${MEMBERSHIP_GUARD}/migration.sql`,
    import.meta.url,
  ),
  'utf8',
);
const LIVE_MEMBERSHIP = (id) => `
  INSERT INTO "membership" (id, user_id, organization_id, roles, updated_at, created_by, updated_by)
  VALUES ('${id}', 'USR_MIGCHECK', 'ORG-MIGCHECK', ARRAY['FLEET_MANAGER'], now(), 'MIGCHECK', 'MIGCHECK');`;

const MEMBERSHIP_INDEX = '20261004100100_membership_one_live_index';

/** Raises unless ux_membership_live_user_org is there and in the state named. */
const LIVE_INDEX_IS = (valid) => `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = to_regclass('ux_membership_live_user_org')
         AND i.indisvalid = ${valid}
    ) THEN
      RAISE EXCEPTION 'ux_membership_live_user_org is not there ${valid ? 'and VALID' : 'as an INVALID leftover'}';
    END IF;
  END $$;`;

/**
 * One live membership per (user, organization): fix/identity-one-live-membership.
 *
 * The schema before it accepts two live memberships for one user and
 * organization (NULL deleted_at values are distinct in the old unique index).
 *
 * Run as it fails in production (#219 r1): the guard has passed, and a
 * duplicate arrives before the CONCURRENTLY build, which then fails and leaves
 * an INVALID index. Every deploy is refused until the failure is resolved; a
 * leftover is never taken for the real index; and the recovery the runbook
 * gives — resolve the duplicate, let the guard run again, resolve the failed
 * build, deploy — ends with a VALID index and no grant deleted or merged.
 * The guard itself refuses over duplicates, naming the index it will not add.
 */
export const IDENTITY_DATA_ROLLBACK = {
  migration: MEMBERSHIP_GUARD,
  label: 'two live memberships for one user and organization, and a failed CONCURRENTLY build',
  steps: [
    {
      label: 'rows the old key refuses: two revocations of one pair at the same instant',
      sql: `
        INSERT INTO "user" (id, username, email, first_name, last_name, updated_at, created_by, updated_by)
        VALUES ('USR_MIGCHECK', 'migcheck', 'migcheck@example.test', 'M', 'C', now(), 'MIGCHECK', 'MIGCHECK');
        INSERT INTO "membership" (id, user_id, organization_id, roles, deleted_at, status, updated_at, created_by, updated_by)
        VALUES ('MBR_MIGCHECK_R1', 'USR_MIGCHECK', 'ORG-MIGCHECK', ARRAY['DRIVER'], '2026-01-01', 'REVOKED', now(), 'MIGCHECK', 'MIGCHECK'),
               ('MBR_MIGCHECK_R2', 'USR_MIGCHECK', 'ORG-MIGCHECK', ARRAY['DRIVER'], '2026-01-01', 'REVOKED', now(), 'MIGCHECK', 'MIGCHECK');`,
    },
    {
      label: '(the pre-build itself, alone)',
      sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership" ("user_id", "organization_id", "deleted_at");',
      // `prisma db execute` reports the failed build by its columns, not its name.
      mustFail:
        'Unique constraint failed on the fields: (`user_id`,`organization_id`,`deleted_at`)',
    },
    {
      label: '(and it is there, INVALID)',
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indexrelid = to_regclass('membership_user_id_organization_id_deleted_at_key')
               AND NOT i.indisvalid
          ) THEN
            RAISE EXCEPTION 'the failed pre-build left no INVALID index';
          END IF;
        END $$;`,
    },
    {
      label: 'down: the drop of the old key refuses to roll back onto the INVALID pre-build',
      runDownScript: ['20261004100200_drop_membership_deleted_at_unique'],
      mustFail: 'is INVALID; refusing to roll back onto it',
    },
    {
      label: 'clear the pre-build and its rows, as the runbook says',
      sql: `DROP INDEX "membership_user_id_organization_id_deleted_at_key";
            DELETE FROM "membership" WHERE user_id = 'USR_MIGCHECK';
            DELETE FROM "user" WHERE id = 'USR_MIGCHECK';`,
    },
    {
      label: 'down: the old key comes back and the new index goes; the guard stays applied',
      runDownScript: ['20261004100200_drop_membership_deleted_at_unique', MEMBERSHIP_INDEX],
    },
    {
      label: 'a duplicate arrives after the guard: the old key accepts two live memberships',
      sql: `
        INSERT INTO "user" (id, username, email, first_name, last_name, updated_at, created_by, updated_by)
        VALUES ('USR_MIGCHECK', 'migcheck', 'migcheck@example.test', 'M', 'C', now(), 'MIGCHECK', 'MIGCHECK');
        ${LIVE_MEMBERSHIP('MBR_MIGCHECK_1')}
        ${LIVE_MEMBERSHIP('MBR_MIGCHECK_2')}`,
    },
    {
      label: 'up again: the CONCURRENTLY build fails over them (P3018)',
      deployMustFail: 'could not create unique index "ux_membership_live_user_org"',
    },
    {
      label: 'it leaves ux_membership_live_user_org behind, INVALID',
      sql: LIVE_INDEX_IS(false),
    },
    {
      label: 'every deploy is refused until the failure is resolved (P3009)',
      deployMustFail: 'P3009',
    },
    {
      label: 'the guard refuses over them rather than choosing one',
      sql: MEMBERSHIP_GUARD_SQL,
      mustFail: 'refusing to add ux_membership_live_user_org',
    },
    {
      label: "recovery 1: resolve the pair as the guard's HINT says — revoke one",
      sql: `UPDATE "membership" SET deleted_at = now(), status = 'REVOKED' WHERE id = 'MBR_MIGCHECK_2';`,
    },
    {
      label: 'resolve the failed build, but skip the guard: prisma migrate resolve --rolled-back',
      resolveRolledBack: MEMBERSHIP_INDEX,
    },
    {
      label:
        'up again: the build fails on the leftover with "already exists" — never taken for the real index',
      deployMustFail: 'already exists',
    },
    { label: 'resolve that failure too', resolveRolledBack: MEMBERSHIP_INDEX },
    {
      label: "recovery 2: the guard's down script removes its ledger row, so it runs again",
      runDownScript: [MEMBERSHIP_GUARD],
    },
    {
      label:
        'recovery 3: deploy — the guard drops the INVALID leftover and checks again, the build succeeds',
      reapply: true,
    },
    { label: 'ux_membership_live_user_org is VALID', sql: LIVE_INDEX_IS(true) },
    {
      label: 'a second live membership for the pair is refused',
      sql: LIVE_MEMBERSHIP('MBR_MIGCHECK_3'),
      // `prisma db execute` reports the violation by its columns, not its name.
      mustFail: 'Unique constraint failed on the fields: (`organization_id`,`user_id`)',
    },
    {
      label: 'no grant was deleted: both memberships are still there',
      sql: `
        DO $$
        BEGIN
          IF (SELECT count(*) FROM "membership" WHERE user_id = 'USR_MIGCHECK') <> 2 THEN
            RAISE EXCEPTION 'a membership was deleted or added by the recovery';
          END IF;
        END $$;`,
    },
    {
      // Prisma keeps a failed attempt as a rolled-back ledger row; the
      // whole-chain reversal below asserts a ledger with none.
      label: 'clean up the probe rows and its rolled-back ledger rows',
      sql: `DELETE FROM "membership" WHERE user_id = 'USR_MIGCHECK';
            DELETE FROM "user" WHERE id = 'USR_MIGCHECK';
            DELETE FROM "_prisma_migrations"
             WHERE migration_name = '${MEMBERSHIP_INDEX}' AND rolled_back_at IS NOT NULL;`,
    },
  ],
};

const MONEY_ADD = '20261005120000_insurance_money_non_negative';
const MONEY_VALIDATE = '20261005120100_insurance_money_non_negative_validate';
const MONEY_CONSTRAINTS = [
  'ck_policy_premium_non_negative',
  'ck_policy_insured_value_non_negative',
  'ck_claim_claimed_amount_non_negative',
  'ck_claim_approved_amount_non_negative',
];
/** Raises unless each money constraint is there and validated (or there and NOT VALID). */
const MONEY_CONSTRAINTS_ARE = (validated) => `
  DO $$
  BEGIN
    IF (SELECT count(*) FROM pg_constraint
         WHERE conname IN (${MONEY_CONSTRAINTS.map((name) => `'${name}'`).join(', ')})
           AND convalidated = ${validated}) <> ${MONEY_CONSTRAINTS.length} THEN
      RAISE EXCEPTION 'expected all four money constraints present with convalidated = ${validated}';
    END IF;
  END $$;`;
/** Raises unless the probe rows still hold exactly the amounts they were given. */
const MONEY_ROWS_UNTOUCHED = (premium) => `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM "insurance_policy" WHERE id = 'INS_MIGCHECK'
                    AND premium_minor = ${premium} AND insured_value_minor = -2)
       OR NOT EXISTS (SELECT 1 FROM "insurance_claim" WHERE id = 'CLM_MIGCHECK'
                    AND claimed_amount_minor = -3 AND approved_amount_minor = -4) THEN
      RAISE EXCEPTION 'a stored amount was rewritten';
    END IF;
  END $$;`;
/**
 * A negative write must be refused by the named constraint, by the database's
 * own report of it (GET STACKED DIAGNOSTICS) — not by anything else, and never
 * accepted. Raises otherwise.
 */
const NEGATIVE_REFUSED_BY = (constraint, statement) => `
  DO $$
  DECLARE
    refused_by text;
  BEGIN
    BEGIN
      ${statement};
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
      IF refused_by <> '${constraint}' THEN
        RAISE EXCEPTION 'refused by %, not ${constraint}', refused_by;
      END IF;
      RETURN;
    END;
    RAISE EXCEPTION 'a negative amount was accepted; ${constraint} refused nothing';
  END $$;`;

/**
 * asset-service's non-negative money constraints (audit L7-36), against rows.
 *
 * The migrations exist to refuse what an empty schema cannot hold: a negative
 * amount already stored. So: both migrations rolled back, negative rows
 * written, and the add migration must refuse — naming counts, changing nothing
 * — until an operator corrects the rows. Then the state the second migration's
 * check is there for: a NOT VALID constraint over a negative row. The shipped
 * chain cannot reach it — the first migration checks and adds under one lock
 * (#222 r1; the race itself is run in asset-service's
 * insurance-money-stored.int-spec.ts) — but constraints re-added by hand can,
 * and the validation must refuse in words, not as a raw check violation, and
 * leave the constraints NOT VALID. Last, the runtime shape: NULL and zero
 * accepted, each negative refused by its own constraint.
 */
export const ASSET_DATA_ROLLBACK = {
  migration: MONEY_ADD,
  label: 'negative insurance amounts stored before the constraints',
  steps: [
    {
      label: 'down: validation, then the constraints, go',
      runDownScript: [MONEY_VALIDATE, MONEY_ADD],
    },
    {
      label: 'rows a write around the API could leave: one negative value in each column',
      sql: `
        INSERT INTO "asset" (id, organization_id, name, type, updated_at, created_by, updated_by)
        VALUES ('AST_MIGCHECK', 'ORG-MIGCHECK', 'migcheck', 'GRADER', now(), 'MIGCHECK', 'MIGCHECK');
        INSERT INTO "insurance_policy" (id, asset_id, organization_id, policy_number, insurer_name, coverage,
                                        premium_minor, insured_value_minor, valid_from, valid_to,
                                        updated_at, created_by, updated_by)
        VALUES ('INS_MIGCHECK', 'AST_MIGCHECK', 'ORG-MIGCHECK', 'MIG-1', 'migcheck', 'THIRD_PARTY',
                -1, -2, now(), now() + interval '1 year', now(), 'MIGCHECK', 'MIGCHECK');
        INSERT INTO "insurance_claim" (id, policy_id, asset_id, organization_id, description, incident_at,
                                       claimed_amount_minor, approved_amount_minor,
                                       updated_at, created_by, updated_by)
        VALUES ('CLM_MIGCHECK', 'INS_MIGCHECK', 'AST_MIGCHECK', 'ORG-MIGCHECK', 'migcheck', now(),
                -3, -4, now(), 'MIGCHECK', 'MIGCHECK');`,
    },
    {
      label: 'up again: the add migration refuses over them, counting each column',
      deployMustFail:
        'negative amounts stored (premium_minor 1, insured_value_minor 1, claimed_amount_minor 1, approved_amount_minor 1); refusing to add',
    },
    {
      label: 'nothing changed: no money constraint, every amount as stored',
      sql: `
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname IN (${MONEY_CONSTRAINTS.map((name) => `'${name}'`).join(', ')})) THEN
            RAISE EXCEPTION 'a refused migration left a money constraint behind';
          END IF;
        END $$;
        ${MONEY_ROWS_UNTOUCHED(-1)}`,
    },
    {
      label: 'every deploy is refused until the failure is resolved (P3009)',
      deployMustFail: 'P3009',
    },
    {
      label: 'an operator corrects the rows (in the probe: the sign)',
      sql: `UPDATE "insurance_policy" SET premium_minor = 1, insured_value_minor = 2 WHERE id = 'INS_MIGCHECK';
            UPDATE "insurance_claim" SET claimed_amount_minor = 3, approved_amount_minor = 4 WHERE id = 'CLM_MIGCHECK';`,
    },
    { label: 'resolve the refused migration', resolveRolledBack: MONEY_ADD },
    { label: 'up again: both migrations apply', reapply: true },
    { label: 'all four constraints are validated', sql: MONEY_CONSTRAINTS_ARE(true) },
    {
      label: 'down: the validation only — the constraints are NOT VALID again',
      runDownScript: [MONEY_VALIDATE],
    },
    { label: '(and they are NOT VALID)', sql: MONEY_CONSTRAINTS_ARE(false) },
    {
      // A NOT VALID constraint over a row it never checked — reached by hand,
      // since the first migration's lock closes the race (#222 r1).
      label: 'by hand: negative rows under constraints re-added NOT VALID',
      sql: `
        ALTER TABLE "insurance_policy" DROP CONSTRAINT "ck_policy_premium_non_negative",
                                       DROP CONSTRAINT "ck_policy_insured_value_non_negative";
        ALTER TABLE "insurance_claim" DROP CONSTRAINT "ck_claim_claimed_amount_non_negative",
                                      DROP CONSTRAINT "ck_claim_approved_amount_non_negative";
        UPDATE "insurance_policy" SET premium_minor = -1, insured_value_minor = -2 WHERE id = 'INS_MIGCHECK';
        UPDATE "insurance_claim" SET claimed_amount_minor = -3, approved_amount_minor = -4 WHERE id = 'CLM_MIGCHECK';
        ALTER TABLE "insurance_policy"
          ADD CONSTRAINT "ck_policy_premium_non_negative" CHECK ("premium_minor" >= 0) NOT VALID,
          ADD CONSTRAINT "ck_policy_insured_value_non_negative" CHECK ("insured_value_minor" >= 0) NOT VALID;
        ALTER TABLE "insurance_claim"
          ADD CONSTRAINT "ck_claim_claimed_amount_non_negative" CHECK ("claimed_amount_minor" >= 0) NOT VALID,
          ADD CONSTRAINT "ck_claim_approved_amount_non_negative" CHECK ("approved_amount_minor" >= 0) NOT VALID;`,
    },
    {
      label: 'up again: the validation refuses in words, not as a raw check violation',
      deployMustFail:
        'negative amounts stored (premium_minor 1, insured_value_minor 1, claimed_amount_minor 1, approved_amount_minor 1); refusing to validate',
    },
    {
      label: 'nothing changed: the constraints still NOT VALID, every amount as stored',
      sql: MONEY_CONSTRAINTS_ARE(false) + MONEY_ROWS_UNTOUCHED(-1),
    },
    {
      label: 'an operator corrects the rows again',
      sql: `UPDATE "insurance_policy" SET premium_minor = 1, insured_value_minor = 2 WHERE id = 'INS_MIGCHECK';
            UPDATE "insurance_claim" SET claimed_amount_minor = 3, approved_amount_minor = 4 WHERE id = 'CLM_MIGCHECK';`,
    },
    { label: 'resolve the refused validation', resolveRolledBack: MONEY_VALIDATE },
    { label: 'up again: the validation applies', reapply: true },
    { label: 'all four constraints are validated again', sql: MONEY_CONSTRAINTS_ARE(true) },
    {
      label: 'NULL ("not stated") and zero are accepted in every column',
      sql: `UPDATE "insurance_policy" SET premium_minor = NULL, insured_value_minor = 0 WHERE id = 'INS_MIGCHECK';
            UPDATE "insurance_policy" SET premium_minor = 0, insured_value_minor = NULL WHERE id = 'INS_MIGCHECK';
            UPDATE "insurance_claim" SET claimed_amount_minor = NULL, approved_amount_minor = 0 WHERE id = 'CLM_MIGCHECK';
            UPDATE "insurance_claim" SET claimed_amount_minor = 0, approved_amount_minor = NULL WHERE id = 'CLM_MIGCHECK';`,
    },
    {
      label: 'each negative amount is refused by its own constraint',
      sql: [
        NEGATIVE_REFUSED_BY(
          'ck_policy_premium_non_negative',
          `UPDATE "insurance_policy" SET premium_minor = -1 WHERE id = 'INS_MIGCHECK'`,
        ),
        NEGATIVE_REFUSED_BY(
          'ck_policy_insured_value_non_negative',
          `UPDATE "insurance_policy" SET insured_value_minor = -1 WHERE id = 'INS_MIGCHECK'`,
        ),
        NEGATIVE_REFUSED_BY(
          'ck_claim_claimed_amount_non_negative',
          `UPDATE "insurance_claim" SET claimed_amount_minor = -1 WHERE id = 'CLM_MIGCHECK'`,
        ),
        NEGATIVE_REFUSED_BY(
          'ck_claim_approved_amount_non_negative',
          `UPDATE "insurance_claim" SET approved_amount_minor = -1 WHERE id = 'CLM_MIGCHECK'`,
        ),
      ].join('\n'),
    },
    {
      // Prisma keeps a failed attempt as a rolled-back ledger row; the
      // whole-chain reversal below asserts a ledger with none.
      label: 'clean up the probe rows and the rolled-back ledger rows',
      sql: `DELETE FROM "insurance_claim" WHERE id = 'CLM_MIGCHECK';
            DELETE FROM "insurance_policy" WHERE id = 'INS_MIGCHECK';
            DELETE FROM "asset" WHERE id = 'AST_MIGCHECK';
            DELETE FROM "_prisma_migrations"
             WHERE migration_name IN ('${MONEY_ADD}', '${MONEY_VALIDATE}') AND rolled_back_at IS NOT NULL;`,
    },
  ],
};

export const ECONOMIC_DATA_ROLLBACK = {
  migration: '20260930200000_payment_reconciliation_task',
  label: 'intents B0 left marked, and the open tasks they get',
  steps: [
    {
      label: 'down: the rollback succeeds while no task is open (the resolutions first)',
      runDownScript: [
        // Its foreign key needs the intent's (organization_id, id) index,
        // which 20260930200000's down script drops.
        '20261003100000_payment_refund_decline',
        '20261001100000_payment_reconciliation_resolution',
        '20260930210000_payment_intent_unfinished_refund_index',
        '20260930200000_payment_reconciliation_task',
      ],
    },
    {
      label: 'down: the schema before the queue holds marked intents',
      sql: [
        PAYMENT_INTENT_MIGCHECK('PAY_MIGCHECK_REFUND', 'CAPTURED', 'REFUND_UNKNOWN'),
        PAYMENT_INTENT_MIGCHECK('PAY_MIGCHECK_UNCREDITED', 'AUTHORIZED', 'CAPTURED_REFUND_UNKNOWN'),
        PAYMENT_INTENT_MIGCHECK('PAY_MIGCHECK_DECLINED', 'AUTHORIZED', 'CAPTURED_NOT_CREDITED'),
        PAYMENT_INTENT_MIGCHECK('PAY_MIGCHECK_PLAIN', 'CAPTURED', null),
      ].join('\n'),
    },
    { label: 'up again: the forward migration applies over them', reapply: true },
    {
      label: 'up again: a task for each unknown refund, and none for the rest',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "payment_reconciliation_task"
           WHERE organization_id = 'ORG-MIGCHECK';
          IF row_count <> 2 THEN
            RAISE EXCEPTION 'the backfill wrote % task(s), expected 2', row_count;
          END IF;
          SELECT count(*) INTO row_count FROM "payment_reconciliation_task"
           WHERE (id, payment_intent_id, kind::text, last_outcome) IN (
                   ('PRT_PAY_MIGCHECK_REFUND', 'PAY_MIGCHECK_REFUND', 'REFUND', 'REFUND_UNKNOWN'),
                   ('PRT_PAY_MIGCHECK_UNCREDITED', 'PAY_MIGCHECK_UNCREDITED',
                    'UNCREDITED_REFUND', 'CAPTURED_REFUND_UNKNOWN'))
             AND status = 'PENDING' AND next_attempt_at <= NOW();
          IF row_count <> 2 THEN
            RAISE EXCEPTION 'the backfilled tasks are not the expected ones (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: the down script refuses while a task is open',
      runDownScript: true,
      mustFail: 'refusing to drop the queue',
    },
    {
      label: 'up again: an intent cannot have a second open task',
      sql: `INSERT INTO "payment_reconciliation_task"
              ("id", "organization_id", "payment_intent_id", "kind", "next_attempt_at",
               "correlation_id", "created_at", "updated_at")
            VALUES ('PRT_MIGCHECK_SECOND', 'ORG-MIGCHECK', 'PAY_MIGCHECK_REFUND', 'REFUND',
                    NOW(), 'COR-MIGCHECK', NOW(), NOW());`,
      // Reported by the key, not the index name; `ux_payment_reconciliation_open`
      // is the only unique index on the intent id alone.
      mustFail: 'Unique constraint failed on the fields: (`payment_intent_id`)',
    },
    {
      label: 'up again: a DECIDED resolution on the backfilled task (history, not pending)',
      sql: `INSERT INTO "payment_reconciliation_resolution"
              ("id", "organization_id", "payment_intent_id", "task_id", "status", "provider_outcome",
               "evidence_reference", "reason", "four_eyes", "proposed_by", "proposed_by_issuer",
               "proposed_by_subject", "proposed_at", "decided_by", "decided_by_issuer",
               "decided_by_subject", "decided_at", "decision_reason", "correlation_id",
               "created_at", "updated_at")
            VALUES ('PRR_MIGCHECK', 'ORG-MIGCHECK', 'PAY_MIGCHECK_REFUND', 'PRT_PAY_MIGCHECK_REFUND',
                    'REJECTED', 'DECLINED', 'TICKET-MIGCHECK', 'a migration probe', true,
                    'USR-MIGCHECK-A', 'https://idp.migcheck', 'sub-a', NOW(),
                    'USR-MIGCHECK-B', 'https://idp.migcheck', 'sub-b', NOW(), 'checked',
                    'COR-MIGCHECK', NOW(), NOW());`,
    },
    {
      label: 'up again: the rollback refuses while any resolution exists, decided or not',
      runDownScript: ['20261001100000_payment_reconciliation_resolution'],
      mustFail: 'refusing to drop its history',
    },
    {
      label: 'up again: a resolution is never deleted',
      sql: `DELETE FROM "payment_reconciliation_resolution" WHERE id = 'PRR_MIGCHECK';`,
      mustFail: 'append-only',
    },
    {
      // Codex round 3 on #175: newest-first, the creator-identity rollbacks
      // run before B3's. Each refuses first, so the sequence stops before
      // changing anything — never a half-rolled-back schema.
      label:
        'up again: the newest-first rollback refuses at its first script while operator history exists',
      runDownScript: [
        '20261002100100_payment_intent_creator_identity_validate',
        '20261002100000_payment_intent_creator_identity',
        '20261001100000_payment_reconciliation_resolution',
      ],
      mustFail: 'refusing to roll back beneath it',
    },
    {
      label: 'up again: the creator-identity rollback refuses on its own as well',
      runDownScript: ['20261002100000_payment_intent_creator_identity'],
      mustFail: 'refusing to roll back beneath it',
    },
    {
      label:
        'up again: the schema is intact — creator columns, validated CHECK, both migrations applied',
      sql: `
        DO $$
        DECLARE found INT;
        BEGIN
          SELECT count(*) INTO found FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'payment_intent'
             AND column_name IN ('created_by_issuer', 'created_by_subject');
          IF found <> 2 THEN
            RAISE EXCEPTION 'the creator columns were dropped (found %)', found;
          END IF;
          SELECT count(*) INTO found FROM pg_constraint
           WHERE conname = 'ck_payment_intent_creator_identity' AND convalidated
             AND conrelid = 'payment_intent'::regclass;
          IF found <> 1 THEN
            RAISE EXCEPTION 'the creator CHECK is no longer validated';
          END IF;
          SELECT count(*) INTO found FROM "_prisma_migrations"
           WHERE migration_name IN ('20261002100000_payment_intent_creator_identity',
                                    '20261002100100_payment_intent_creator_identity_validate')
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
          IF found <> 2 THEN
            RAISE EXCEPTION 'a creator-identity migration left the ledger (found %)', found;
          END IF;
          SELECT count(*) INTO found FROM "payment_reconciliation_resolution" WHERE id = 'PRR_MIGCHECK';
          IF found <> 1 THEN
            RAISE EXCEPTION 'the operator history is gone';
          END IF;
        END
        $$;`,
    },
    {
      label: 'cleanup: the probe rows are removed before the chain reversal',
      // The append-only trigger is lifted for the probe's own row only, in this
      // one script; the owner may do that, the service's runtime role may not.
      sql: `ALTER TABLE "payment_reconciliation_resolution" DISABLE TRIGGER "trg_payment_resolution_append_only";
            DELETE FROM "payment_reconciliation_resolution" WHERE organization_id = 'ORG-MIGCHECK';
            ALTER TABLE "payment_reconciliation_resolution" ENABLE TRIGGER "trg_payment_resolution_append_only";
            DELETE FROM "payment_reconciliation_task" WHERE organization_id = 'ORG-MIGCHECK';
            DELETE FROM "payment_intent" WHERE organization_id = 'ORG-MIGCHECK';`,
    },
  ],
};

/** One refused read of an award approval: the log row `20261004120000` let the log hold. */
const TENDER_READ_LOG_ROW = (id) => `
INSERT INTO "tender_approval_log" ("id", "organization_id", "tender_id", "request_id", "workflow_key",
  "action", "outcome", "refusal_code", "step_order", "actor_user_id", "actor_organization_id",
  "occurred_at")
VALUES ('${id}', 'ORG-MIGCHECK-CON', 'TND_MIGCHECK_READ', NULL, 'tender.award', 'READ', 'REFUSED',
  'READ_ROLE_NOT_HELD', 1, 'USR_MIGCHECK', 'ORG-MIGCHECK-CON', now());`;

/** A project, a DRAFT tender and a refused award-approval READ, as the schema with the insert guards holds them. */
const TENDER_READ_LOG_MIGCHECK = `
INSERT INTO "project" ("id", "organization_id", "title", "operation_type", "scope_of_work",
  "location_description", "status", "status_changed_at", "status_changed_by", "created_at",
  "created_by", "created_correlation_id", "updated_at", "updated_by")
VALUES ('PRJ_MIGCHECK_READ', 'ORG-MIGCHECK-CON', 'Road', 'road', 'Resurface', 'North', 'APPROVED',
  now(), 'USR_MIGCHECK', now(), 'USR_MIGCHECK', 'COR-MIGCHECK', now(), 'USR_MIGCHECK');
INSERT INTO "tender" ("id", "organization_id", "project_id", "title", "scope_of_work", "status",
  "status_changed_at", "status_changed_by", "created_at", "created_by", "created_correlation_id",
  "updated_at", "updated_by")
VALUES ('TND_MIGCHECK_READ', 'ORG-MIGCHECK-CON', 'PRJ_MIGCHECK_READ', 'Road resurfacing',
  'Two kilometres', 'DRAFT', now(), 'USR_MIGCHECK', now(), 'USR_MIGCHECK', 'COR-MIGCHECK', now(),
  'USR_MIGCHECK');
${TENDER_READ_LOG_ROW('TAL_MIGCHECK_READ')}`;

/**
 * The rollback of `20261004120000_tender_approval_insert_guards` with a refused award-approval READ logged
 * (CON-002 PR 11, review round 2). The log is append-only audit evidence, so the down neither deletes nor
 * rewrites that row and is not refused by it: the older log constraint comes back `NOT VALID` (as marketplace's
 * `cancel_before_hold` does), keeping the READ row while checking every new one, and the insert guards go.
 * Up again validates the forward constraint over the same row.
 */
export const CONSTRUCTION_DATA_ROLLBACK = {
  migration: '20261004120000_tender_approval_insert_guards',
  label: 'a refused read of an award approval in the append-only log',
  steps: [
    {
      label: 'seed: a DRAFT tender and one refused READ of its award approval',
      sql: TENDER_READ_LOG_MIGCHECK,
    },
    { label: 'down: the rollback succeeds with the READ row in the log', runDownScript: true },
    {
      label: 'down: the READ row is still there, unaltered',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "tender_approval_log"
           WHERE id = 'TAL_MIGCHECK_READ' AND action = 'READ' AND outcome = 'REFUSED'
             AND refusal_code = 'READ_ROLE_NOT_HELD';
          IF row_count <> 1 THEN
            RAISE EXCEPTION 'the rollback did not keep the logged READ (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'down: the older log constraint refuses a new READ row',
      sql: TENDER_READ_LOG_ROW('TAL_MIGCHECK_AFTER_DOWN'),
      mustFail: 'ck_tender_approval_log_shape',
    },
    {
      label: 'down: the insert guard is gone (a tender may be inserted past DRAFT again)',
      sql: `
        INSERT INTO "tender" ("id", "organization_id", "project_id", "title", "scope_of_work", "status",
          "status_reason", "status_reason_code", "status_changed_at", "status_changed_by", "created_at",
          "created_by", "created_correlation_id", "updated_at", "updated_by")
        VALUES ('TND_MIGCHECK_CANCELLED', 'ORG-MIGCHECK-CON', 'PRJ_MIGCHECK_READ', 'Road resurfacing',
          'Two kilometres', 'CANCELLED', 'Funding was withdrawn', 'OWNER_REQUEST', now(), 'USR_MIGCHECK',
          now(), 'USR_MIGCHECK', 'COR-MIGCHECK', now(), 'USR_MIGCHECK');`,
    },
    { label: 'up again: the forward migration applies over the READ row', reapply: true },
    {
      label: 'up again: the READ row survived the round trip',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "tender_approval_log" WHERE id = 'TAL_MIGCHECK_READ';
          IF row_count <> 1 THEN
            RAISE EXCEPTION 'the logged READ did not survive down → up (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: the log accepts a new READ row',
      sql: TENDER_READ_LOG_ROW('TAL_MIGCHECK_AFTER_UP'),
    },
    {
      label: 'up again: a tender is inserted only as a DRAFT',
      sql: `
        INSERT INTO "tender" ("id", "organization_id", "project_id", "title", "scope_of_work", "status",
          "status_reason", "status_reason_code", "status_changed_at", "status_changed_by", "created_at",
          "created_by", "created_correlation_id", "updated_at", "updated_by")
        VALUES ('TND_MIGCHECK_REFUSED', 'ORG-MIGCHECK-CON', 'PRJ_MIGCHECK_READ', 'Road resurfacing',
          'Two kilometres', 'CANCELLED', 'Funding was withdrawn', 'OWNER_REQUEST', now(), 'USR_MIGCHECK',
          now(), 'USR_MIGCHECK', 'COR-MIGCHECK', now(), 'USR_MIGCHECK');`,
      mustFail: 'ck_tender_insert_draft',
    },
    {
      // As the database owner, the append-only log is lifted for this one script (DDL is transactional), as
      // the suites' own cleanup does: the probe rows must not hold up the chain reversal that follows.
      label: 'cleanup: the probe rows are removed before the chain reversal',
      sql: `
        ALTER TABLE "tender_approval_log" DISABLE TRIGGER "tg_tender_approval_log_append_only";
        DELETE FROM "tender_approval_log" WHERE id LIKE 'TAL_MIGCHECK_%';
        ALTER TABLE "tender_approval_log" ENABLE TRIGGER "tg_tender_approval_log_append_only";
        DELETE FROM "tender" WHERE id LIKE 'TND_MIGCHECK_%';
        DELETE FROM "project" WHERE id = 'PRJ_MIGCHECK_READ';`,
    },
  ],
};

/**
 * What each service's schema must contain after `up`, and must not contain
 * after `down`.
 *
 * Named objects rather than "some tables exist", because the objects listed
 * here are the ones that carry the invariants: an immutability trigger that
 * the down script drops but the forward migration forgets to recreate would
 * leave a ledger that is append-only in name only.
 *
 * `dataRollback` is optional and describes a rollback that has to be tested
 * against **rows**, not just against an empty schema.
 */
export const EXPECTED = {
  /**
   * audit-service, registered here the moment it had a real migration to
   * verify and not before.
   *
   * PR #38 deliberately left it out: `verify-migration-reversible.mjs` refuses
   * a service with no `EXPECTED` entry, and the only ways to make it pass then
   * were an empty entry that succeeds vacuously or a fabricated migration.
   * This is the entry that debt was waiting for.
   *
   * The tables list names every partition, not just the parent. `DROP TABLE
   * audit_event` would take all nineteen with it, so a down script that
   * dropped only the parent would still pass a parent-only check while leaving
   * nothing behind to notice — and, more to the point, a *forward* migration
   * that quietly stopped creating `audit_event_2028_02` would go unseen. The
   * eighteen months plus DEFAULT are the capacity claim ADR-053 § 11 makes, so
   * they are the thing asserted.
   *
   * The triggers list carries both halves of the append-only control, and the
   * second one is not redundant. PostgreSQL clones a row-level BEFORE UPDATE
   * OR DELETE trigger to every partition but does **not** clone a
   * statement-level BEFORE TRUNCATE trigger, so `audit_event_append_only`
   * alone leaves `TRUNCATE audit_event_2026_09` working. Both names must
   * survive a down/up cycle or the store is append-only in name only.
   *
   * The constraints are the ones that make a row evidence rather than a shape:
   * a blank source event id is not an idempotency key, a blank correlation id
   * joins to nothing, and `audit_event_changes_is_array` is what stops a
   * future writer putting a raw object where ADR-053 § 5 requires a bounded
   * array of redacted deltas.
   *
   * AUD-003 adds the chain head, and with it the two object kinds this list
   * could not express before. `audit_event_chain_idx` is the order the
   * verification walk reads in: without it the walk still returns the right
   * answer and does so by sequential scan over a month's partition, which is a
   * regression nothing else here would notice. `audit_chain_scope` is the
   * discriminator that keeps the platform chain from colliding with a tenant's;
   * a down script that dropped its table but left the type behind would leave
   * the second `up` to fail on a name that already exists.
   */
  audit: {
    // D-045: rasta_audit_migrator owns database rasta_audit, and the runtime
    // role lost CREATE on it — the scratch schema is the migrator's to create.
    connectAs: 'migrator',
    tables: [
      'audit_event',
      'audit_event_2026_09',
      'audit_event_2026_10',
      'audit_event_2026_11',
      'audit_event_2026_12',
      'audit_event_2027_01',
      'audit_event_2027_02',
      'audit_event_2027_03',
      'audit_event_2027_04',
      'audit_event_2027_05',
      'audit_event_2027_06',
      'audit_event_2027_07',
      'audit_event_2027_08',
      'audit_event_2027_09',
      'audit_event_2027_10',
      'audit_event_2027_11',
      'audit_event_2027_12',
      'audit_event_2028_01',
      'audit_event_2028_02',
      'audit_event_default',
      'processed_event',
      'organization_ref',
      // AUD-003. The chain's tip, and the one object in this service the
      // runtime role may UPDATE.
      'audit_chain_head',
      // 20261001110000_tender_evidence: the externally held receipt chain and the
      // record of who read which bid.
      'tender_receipt_link',
      'bid_access_evidence',
      // 20261001130000_tender_receipt_pending: receipts held until their predecessor arrives.
      'tender_receipt_pending',
      // 20261003120000_payment_reconciliation_evidence (D-046): who proposed and
      // approved a payment-reconciliation resolution, on which evidence.
      'payment_reconciliation_evidence',
    ],
    triggers: [
      'tg_tender_receipt_link_append_only',
      'tg_tender_receipt_link_no_truncate',
      'tg_bid_access_evidence_append_only',
      'tg_bid_access_evidence_no_truncate',
      'audit_event_append_only',
      'audit_event_append_only_truncate',
      // AUD-003, and the same asymmetry as above: the row-level trigger is what
      // refuses a rewind, a re-key and a multi-record advance, and it never
      // sees a TRUNCATE. Both names or the head is forward-only in name only.
      'audit_chain_head_forward_only',
      'audit_chain_head_no_truncate',
      'tg_payment_reconciliation_evidence_append_only',
      'tg_payment_reconciliation_evidence_no_truncate',
    ],
    indexes: [
      // Verification walks one chain in `sequence_no` order within a partition.
      'audit_event_chain_idx',
      // "Which chains does this month hold" — the parent index, not a clone.
      'audit_chain_head_month_idx',
      // AUD-003's correction half: the access path for `correctedBy`. Every
      // read publishes both directions of a correction link, and the reverse
      // direction is "which later rows name this one" — an index probe per
      // partition with this, a scan of every partition since the target
      // without it. It is listed for a second reason too: its migration adds
      // one index and nothing else, so an inventory that does not name it
      // makes that whole migration invisible to the up → down → up proof.
      'audit_event_correction_idx',
      // A receipt is one link and a link has one successor: the fork refusal is an index.
      'ux_tender_receipt_link_receipt',
      'ux_tender_receipt_link_previous',
      'ux_tender_receipt_link_event',
      'ix_bid_access_evidence_tender',
      'ux_tender_receipt_pending_previous',
      'ux_tender_receipt_pending_receipt',
      'ix_tender_receipt_pending_held',
      'ux_payment_reconciliation_evidence_audit_event',
      'ix_payment_reconciliation_evidence_intent',
    ],
    types: ['audit_chain_scope'],
    // The two trigger functions, named separately from the triggers that call
    // them. A `DROP TRIGGER` without the matching `DROP FUNCTION` leaves a
    // `refuse_*()` behind that the second `up` then fails to `CREATE`, and a
    // `DROP FUNCTION` the forward migration forgets to restore leaves a trigger
    // definition pointing at nothing -- which PostgreSQL refuses to create, so
    // the rollback and the re-apply are the only place either shows up.
    functions: [
      'refuse_mutation',
      'refuse_chain_head_regression',
      'tender_evidence_append_only',
      'payment_reconciliation_evidence_append_only',
    ],
    constraints: [
      'audit_event_source_event_id_not_blank',
      'audit_event_source_topic_not_blank',
      'audit_event_correlation_id_not_blank',
      'audit_event_occurrence_count_positive',
      'audit_event_changes_is_array',
      // AUD-002. The hierarchy projection is what `UNION_ADMIN` scoping is
      // decided from, so its integrity rules are listed for the same reason the
      // evidence table's are: a rollback that dropped them while the forward
      // migration forgot to restore them would leave a projection that can hold
      // a self-parented row -- a cycle the subtree walk would meet -- and a
      // PROJECTED row with no observation behind it, which accepts every stale
      // event that arrives after it.
      'organization_ref_parent_not_self',
      'organization_ref_projected_has_observation',
      'organization_ref_parent_not_blank',
      // AUD-003. Each of these is a rule that stops the head from describing a
      // chain nothing could produce, and each is invisible to a table-only
      // check: the scope shape is what makes "one head per tenant-or-platform
      // month" structural rather than conventional; the state rule refuses a
      // head that claims a length but names no record, which the next writer
      // would read as an empty chain and silently restart; the two segment
      // rules stop the recorded boundary between pre-chain legacy and removed
      // links from being placed after the record it opens; and the digest
      // length rule stops a short hash from being stored as if it were SHA-256.
      'audit_chain_head_scope_shape',
      'audit_chain_head_month_is_first_day',
      'audit_chain_head_state',
      'audit_chain_head_segment_start_ordered',
      'audit_chain_head_single_record_segment',
      'audit_chain_head_hash_is_sha256',
      'ck_tender_receipt_link_shape',
      'ck_bid_access_evidence_shape',
      'ck_bid_access_evidence_refusal_code',
      'ck_tender_receipt_pending_shape',
      // D-046: the version, the allow-listed values and which fields each event carries.
      'ck_payment_reconciliation_evidence_version',
      'ck_payment_reconciliation_evidence_values',
      'ck_payment_reconciliation_evidence_shape',
    ],
  },
  /**
   * notification-service, registered the moment it had a real migration to
   * verify and not before (ADR-053 plan, Step Zero: a vacuous entry is worse
   * than none).
   *
   * The constraints listed are ADR-054 § 4's delivery invariants made
   * structural, plus the two the semantic dedupe and the claim worker rest on.
   * `ck_delivery_suppressed_shape` is what makes "suppression is a decision,
   * not a failure" true of the row; `ux_delivery_intent_user_channel` is
   * invariant 6, the last line against a replayed consumer; and
   * `ck_in_app_action_path_relative` is the open-redirect refusal ADR § 10
   * wants at the database, not only in a DTO. A down script that dropped any
   * of them while the forward migration forgot to restore it would leave a
   * delivery table that enforces nothing while looking untouched.
   *
   * `notification_dedupe_intent_id_fkey` is listed by name for a reason the
   * others are not: it is the one foreign key hand-written after Prisma's
   * block, because it must be DEFERRABLE INITIALLY DEFERRED for the consumer's
   * single-statement dedupe decision to precede the intent row. A forward
   * migration that recreated it as an immediate constraint would pass a
   * table-only check and break every ingest.
   *
   * The trigger and its function are named separately, for the same reason
   * audit's are: a `DROP TRIGGER` without the matching `DROP FUNCTION` leaves a
   * `refuse_attempt_update()` behind that the second `up` then fails to CREATE.
   */
  notification: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_notification.
    connectAs: 'migrator',
    tables: [
      'processed_event',
      'notification_intent',
      'notification_dedupe',
      'recipient_resolution',
      'notification_delivery',
      'delivery_attempt',
      'in_app_notification',
      // NTF-003.
      'notification_preference',
      // NTF-004. The templates the email channel renders from, their immutable
      // published versions, and the quiet window a delivery defers into.
      'notification_template',
      'notification_template_version',
      'notification_quiet_hours',
      // The outbox arrived with NTF-002's audit events. Before them this
      // service consumed and never produced, so it had none — which is the
      // deviation ADR-054 § 3 recorded against AGENTS.md S-06. Listed here so
      // a down script that forgot to drop them, or a forward migration that
      // forgot to recreate them, fails the round trip rather than a review.
      'outbox_message',
      'outbox_stream_sequence',
    ],
    // NTF-002 adds the second pair: read state is write-once. The trigger and
    // its function are named separately for the same reason as the first pair.
    triggers: [
      'delivery_attempt_append_only',
      'in_app_notification_state_write_once',
      // NTF-004. A published template version is immutable; editing means
      // publishing a new version, because a delivery cites `(key, version)`.
      'trg_template_version_immutable',
    ],
    functions: [
      'refuse_attempt_update',
      'refuse_in_app_state_regression',
      'notification_template_version_immutable',
    ],
    indexes: [
      'ix_intent_claimable',
      'ix_in_app_unread',
      'ux_delivery_intent_user_channel',
      // NTF-003. The partial unique index is the half of the uniqueness rule
      // the composite one cannot express, because PostgreSQL treats NULLs as
      // distinct: without it two GLOBAL rows for one channel are both legal and
      // the winning layer depends on row order.
      'ux_preference_global_channel',
      // NTF-004. The predicate the mail worker claims on. Without it the
      // sweep is a sequential scan of every delivery this service has ever
      // written, most of which are in-app rows it will never send.
      'ix_delivery_sendable',
    ],
    types: [
      'preference_scope',
      'notification_severity',
      'notification_classification',
      'intent_status',
      'resolution_source',
      'notification_channel',
      'delivery_status',
      'attempt_outcome',
    ],
    // NTF-004 widened `notification_channel` with `EMAIL`, and the down script
    // has to rebuild the type to take it away again. A type-name check cannot
    // see that; this can.
    enumValues: [['notification_channel', 'EMAIL']],
    constraints: [
      'notification_dedupe_intent_id_fkey',
      'ck_intent_terminal_reason',
      'ck_intent_dispatched_is_resolved',
      'ck_intent_claim_triple',
      'ck_intent_claim_only_when_pending',
      'ck_intent_attempts_nonneg',
      'ck_intent_dedupe_key_is_sha256',
      'ck_dedupe_seen_count_positive',
      'ck_dedupe_window_ordered',
      'ck_delivery_suppressed_shape',
      'ck_delivery_sent_has_timestamp',
      'ck_delivery_dead_exhausted',
      'ck_delivery_attempts_bounded',
      'ck_delivery_next_attempt_only_when_open',
      'ck_attempt_no_positive',
      'ck_attempt_ordered',
      'ck_attempt_error_class_shape',
      'ck_in_app_dismiss_implies_read',
      'ck_in_app_action_path_relative',
      'ck_in_app_text_not_blank',
      'ck_in_app_expires_after_created',
      // NTF-003. `ck_preference_scope_key_shape` is what keeps a GLOBAL row
      // from carrying a key, or a RULE row from lacking one — either of which
      // would sit in the unique index under a shape the ladder never looks for.
      'ck_preference_scope_key_shape',
      // The outbox's own invariants, listed for the same reason supplier's are:
      // this is the gate that verifies them. `verify-outbox-claim-migration.mjs`
      // addresses migrations by name and this service's outbox arrived in one of
      // its own (`20260919060000_notification_outbox`), so that verifier defers
      // here — and a claim triple or a published-row rule that a down script
      // dropped and a forward migration forgot would otherwise be invisible.
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_published_is_clean',
      'ck_outbox_next_attempt_requires_failure',
    ],
  },
  economic: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_economic.
    connectAs: 'migrator',
    tables: [
      'wallet',
      'ledger_account',
      'journal',
      'ledger_entry',
      'transaction',
      'settlement',
      'payment_reconciliation_task',
      'payment_reconciliation_resolution',
      'payment_reconciliation_requeue',
      'payment_refund_decline',
    ],
    triggers: [
      'trg_ledger_entry_immutable',
      'trg_journal_immutable',
      'trg_journal_balanced',
      // The operator path's history (ADR-064 § 6): never deleted, decided once.
      'trg_payment_resolution_append_only',
      'trg_payment_requeue_append_only',
    ],
    // The queue's: a finished task names its resolution and holds no lease.
    constraints: [
      'ck_wallet_balances',
      'ck_payment_reconciliation_done_complete',
      'ck_payment_reconciliation_lease_pair',
      // Separation of duties on an operator resolution (ADR-064 § 6).
      'ck_payment_resolution_four_eyes',
      // The creator's stable identity: both or neither (ADR-064 § 6).
      'ck_payment_intent_creator_identity',
    ],
    // One obligation per business fact per payer. A down script that dropped
    // it without the forward migration restoring it would bring back the
    // double-settlement race it closes, silently.
    indexes: [
      'ux_transaction_source_fact',
      'ux_payment_reconciliation_open',
      'ux_payment_resolution_pending',
      // The operator view's tenant-leading access path (#218 r1).
      'ix_payment_resolution_org_intent',
    ],
    dataRollback: ECONOMIC_DATA_ROLLBACK,
  },
  /**
   * The constraints listed are the ones carrying a financial invariant, not a
   * sample: `ck_order_settled_after_receipt` is what makes "no settlement
   * without a recorded confirmation" true of the *row* as well as of the state
   * machine, and a down script that dropped it without the forward migration
   * restoring it would leave an order table that enforces nothing.
   */
  marketplace: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_marketplace.
    connectAs: 'migrator',
    /**
     * The init migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and its
     * down script deliberately leaves it: the bootstrap installs pg_trgm into
     * template1 for every database, so dropping it could remove an extension
     * the migration did not add (its header explains). Leaving it installed is
     * the one extension difference this rollback may make.
     */
    keptExtensions: {
      '20260829185748_init_marketplace': ['pg_trgm'],
    },
    /**
     * The one documented exception to "down.sql is the exact inverse".
     *
     * `20260830103500_cancel_before_hold/down.sql` restores the narrower
     * `ck_order_held_has_transaction` as `NOT VALID`, on purpose: by the time
     * anyone rolls it back the table may hold cancelled-before-hold orders only
     * the widened rule allowed, and validating would abort the rollback or
     * force someone to delete or falsify real orders (its header explains).
     * Same predicate, enforced on every write; only the retroactive claim
     * differs. Exactly this difference is allowed — nothing else, and if it
     * ever stops occurring the allowance itself fails.
     */
    inexactInverse: {
      '20260830103500_cancel_before_hold': {
        missing: [
          `constraint order.ck_order_held_has_transaction CHECK (((status = ANY (ARRAY['PENDING'::"OrderStatus", 'FAILED'::"OrderStatus"])) OR (economic_transaction_id IS NOT NULL))) deferrable=false/false valid=true`,
        ],
        unexpected: [
          `constraint order.ck_order_held_has_transaction CHECK (((status = ANY (ARRAY['PENDING'::"OrderStatus", 'FAILED'::"OrderStatus"])) OR (economic_transaction_id IS NOT NULL))) NOT VALID deferrable=false/false valid=false`,
        ],
      },
    },
    tables: ['product', 'offer', 'order', 'order_line', 'fulfillment', 'order_status_history'],
    triggers: [],
    constraints: [
      'ck_order_settled_after_receipt',
      'ck_order_completed_has_settlement',
      'ck_order_line_total_consistent',
      'ck_offer_available_non_negative',
      // Added by 20260917192908_supplier_performance_signals (ADR-052 § 1-b,
      // 1-c). Each keeps a structured attribution from ever being silently
      // absent once the row reaches the state that requires one — the same
      // shape as the constraints above, for a fact this step introduces
      // rather than one the init migration already carried.
      'ck_order_cancelled_has_cause',
      'ck_dispute_resolved_has_responsibility',
    ],
    // Added by 20260929120100_order_idempotency_key_unique (review of #141):
    // one Idempotency-Key places at most one order per organization, even
    // after its idempotency record is gone.
    indexes: ['uq_order_org_idempotency_key'],
    types: ['ResponsibilityAttribution'],
    dataRollback: MARKETPLACE_DATA_ROLLBACK,
  },
  /**
   * The constraints listed carry the claims a reader would otherwise have to
   * take on trust.
   *
   * `ck_document_scan_attributable` is what makes "we know which engine said
   * this" true of the row: any state but `PENDING` must name an engine and a
   * time. `ck_document_signature_only_when_infected` stops a clean document
   * from carrying a signature a consumer would act on.
   * `ck_document_deleted_has_actor` is the tombstone rule — a deletion with no
   * actor, time or reason is not an audit record. A down script that dropped
   * any of them without the forward migration restoring it would leave a
   * document table that enforces nothing while looking untouched.
   */
  document: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_document.
    connectAs: 'migrator',
    tables: ['upload_intent', 'document', 'access_grant', 'outbox_message'],
    triggers: [],
    constraints: [
      'ck_document_scan_attributable',
      'ck_document_signature_only_when_infected',
      'ck_document_deleted_has_actor',
      'ck_document_size_positive',
      'ck_document_owner_reference_complete',
      'ck_upload_intent_consumed_complete',
      'ck_grant_revoked_has_actor',
      // Added by 20260831180000_document_scan_lifecycle (ADR-049). The first
      // two are the quarantine policy expressed as a rule the database keeps:
      // an infection is held, and a hold belongs to an infection. The third
      // stops a FAILED scan from being undiagnosable, and the last two stop a
      // worker lease from outliving the work it claims.
      'ck_document_quarantine_complete',
      'ck_document_infected_is_quarantined',
      'ck_document_failure_reason_only_when_failed',
      'ck_document_scan_lease_complete',
      'ck_document_scan_lease_only_when_pending',
    ],
    dataRollback: DOCUMENT_DATA_ROLLBACK,
  },
  /**
   * supplier-service, and the reason it is verified **here** rather than by the
   * outbox verifiers.
   *
   * This service ships one initial migration that folds the domain schema,
   * ADR-050's durable claim and ADR-051 Phase B1 together, because it had no
   * previous deployed state to stay compatible with.
   * `verify-outbox-claim-migration.mjs` and `verify-outbox-b1-lib.test.mjs`
   * both address migrations *by name* — five separately named files — so adding
   * `supplier` to their service lists does not weaken them, it makes them throw
   * `20260902120000_outbox_durable_claim/migration.sql is missing`. They are
   * left alone deliberately, and each now carries an explicit exclusion entry
   * naming this service so the omission is a recorded decision rather than a
   * service nobody noticed was unverified.
   *
   * That means the outbox objects have to be verified somewhere, and this is
   * that somewhere: the constraint list below carries ADR-050's claim triple
   * and the published-row rule alongside the domain invariants, so a down
   * script that dropped any of them without the forward migration restoring it
   * fails here.
   *
   * The domain constraints listed are the ones carrying a claim a reader would
   * otherwise take on trust. `ck_qualification_decision_complete` is what makes
   * "a decision names its actor and its time" true of the row rather than of
   * the service that happens to write it; `ck_qualification_decided_after_submitted`
   * and `ck_suspension_reinstated_after_suspended` are what stop a decision from
   * predating the thing it decides.
   */
  supplier: {
    // The runtime role owns nothing and cannot create the scratch schema
    // (lib/supplier-privilege-split.bash); the migrator owns the database.
    connectAs: 'migrator',
    tables: [
      'supplier',
      'supplier_capability',
      'qualification',
      'qualification_evidence',
      'suspension',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      // ADR-052 step 2: the platform-wide performance formula.
      'performance_formula_version',
      'performance_formula_weight',
      // ADR-052 step 3: the append-only performance-event store.
      'performance_event',
      // ADR-052 step 4: the score snapshot and its provenance.
      'performance_score_snapshot',
      'performance_score_component',
      'performance_score_source_event',
      // ADR-052 step 5: orders that concluded, for the Q-78 denominator.
      'performance_concluded_outcome',
    ],
    // ADR-052 step 2. The freeze, the no-truncate pair, the deferred 100% sum
    // and the successor rule. A round trip that lost any one of them would
    // leave a formula table that accepts exactly the edit it exists to refuse.
    triggers: [
      'trg_performance_formula_version_guard',
      'trg_performance_formula_version_no_truncate',
      'trg_performance_formula_weight_guard',
      'trg_performance_formula_weight_no_truncate',
      'trg_performance_formula_weight_sum',
      'trg_performance_formula_version_sum',
      'trg_performance_formula_successor',
      // ADR-052 step 3. Both, because the row trigger never sees a TRUNCATE.
      'trg_performance_event_append_only',
      'trg_performance_event_no_truncate',
      // ADR-052 step 4. Insert-only on all three tables, the seal that keeps
      // provenance from being added after the fact, and the commit-time check
      // that the snapshot agrees with its formula version.
      'trg_performance_score_snapshot_append_only',
      'trg_performance_score_snapshot_no_truncate',
      'trg_performance_score_component_append_only',
      'trg_performance_score_component_no_truncate',
      'trg_performance_score_source_event_append_only',
      'trg_performance_score_source_event_no_truncate',
      'trg_performance_score_component_sealed',
      'trg_performance_score_source_event_sealed',
      'trg_performance_score_snapshot_consistent',
      // ADR-052 step 5. The concluded-outcome store is append-only too.
      'trg_performance_concluded_outcome_append_only',
      'trg_performance_concluded_outcome_no_truncate',
    ],
    functions: [
      'performance_formula_version_guard',
      'performance_formula_weight_guard',
      'performance_formula_weight_sum_check',
      'performance_formula_successor_check',
      'performance_event_append_only',
      'performance_score_append_only',
      'performance_score_child_sealed',
      'performance_score_snapshot_consistent',
      'performance_concluded_outcome_append_only',
    ],
    indexes: [
      'ux_performance_formula_version_number',
      // "At most one ACTIVE" is this partial index and nothing else.
      'ux_performance_formula_single_active',
      // ADR-052 rule 8: the idempotency key. Without it a redelivery is
      // counted twice and the score moves.
      'ux_performance_event_source',
      'ux_performance_event_compensation_target',
      // ADR-052 step 4: the targets of the composite foreign keys that keep a
      // snapshot's version number and cited events consistent and in-tenant.
      'ux_performance_formula_version_identity',
      'ux_performance_event_tenant_source',
      'ux_performance_score_snapshot_tenant',
      // ADR-052 step 5: rule 8 for concluded outcomes.
      'ux_performance_concluded_outcome_source',
    ],
    types: [
      'PerformanceFormulaStatus',
      'PerformanceComponent',
      'ResponsibilityAttribution',
      'PerformanceOutcomeKind',
      'PerformanceScoreStatus',
    ],
    constraints: [
      // Domain invariants.
      'ck_supplier_display_name_not_blank',
      'ck_supplier_actor_recorded',
      'ck_supplier_capability_actor_recorded',
      'ck_qualification_decision_complete',
      'ck_qualification_decided_after_submitted',
      'ck_qualification_note_requires_decision',
      'ck_qualification_text_not_blank',
      'ck_evidence_document_id_not_blank',
      'ck_evidence_text_not_blank',
      'ck_suspension_reinstatement_complete',
      'ck_suspension_reinstated_after_suspended',
      'ck_suspension_note_requires_reinstatement',
      'ck_suspension_text_not_blank',
      // ADR-050 / ADR-051 B1, folded into the initial migration and therefore
      // out of reach of the by-name outbox verifiers.
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      // ADR-052 step 2.
      'ck_formula_version_positive',
      'ck_formula_window_positive',
      'ck_formula_min_sample_positive',
      'ck_formula_min_coverage_range',
      'ck_formula_rating_mapping',
      'ck_formula_activation_complete',
      'ck_formula_retirement_complete',
      'ck_formula_status_stamps',
      'ck_formula_chronology',
      'ck_formula_text_not_blank',
      'ck_formula_weight_bp_range',
      // ADR-052 step 3.
      'performance_event_compensates_fkey',
      'ck_performance_event_not_self_compensating',
      'ck_performance_event_quality_unmeasured',
      'ck_performance_event_responsibility',
      'ck_performance_event_rating',
      'ck_performance_event_timeliness',
      'ck_performance_event_text_not_blank',
      // ADR-052 step 4.
      'performance_score_snapshot_version_fkey',
      'performance_score_component_snapshot_fkey',
      'performance_score_source_event_snapshot_fkey',
      'performance_score_source_event_event_fkey',
      'ck_score_snapshot_window',
      'ck_score_snapshot_score_only_when_published',
      'ck_score_snapshot_ranges',
      'ck_score_snapshot_text_not_blank',
      'ck_score_component_absent_is_null',
      'ck_score_component_ranges',
      'ck_score_component_present_has_samples',
      // ADR-052 step 5.
      'ck_performance_event_dispute',
      'ck_performance_concluded_outcome_text_not_blank',
    ],
  },
  /**
   * construction-service (CON-001, ADR-063). One initial migration that folds
   * the domain schema and the outbox together, as supplier's does, so its
   * outbox objects are verified here rather than by the by-name outbox
   * verifiers (`verify-outbox-claim-migration.mjs` lists it as folded).
   *
   * A scratch database, because `project.area` is `geography` and the
   * migration names it unqualified: it resolves only where PostGIS is on the
   * search path, which a throwaway schema in the service database is not.
   *
   * The domain constraints listed are the ones carrying a claim a reader would
   * otherwise take on trust: a cancellation always has a reason, a withdrawal
   * names who, when and why, a submission names its actor, and an operating
   * area is valid geometry.
   */
  construction: {
    // D-045: the runtime role owns nothing and lost CREATEDB, so the scratch
    // database is created — and migrated — as the migrator, which owns
    // rasta_construction (lib/service-privilege-split.bash).
    dataRollback: CONSTRUCTION_DATA_ROLLBACK,
    // The down of the insert guards restores the older log constraint NOT VALID, so a READ already logged is
    // kept (audit evidence is never deleted or rewritten) while every new row is checked: the one difference
    // from the state before the migration (CON-002 PR 11, review round 2; CONSTRUCTION_DATA_ROLLBACK).
    inexactInverse: {
      '20261004120000_tender_approval_insert_guards': {
        missing: [
          `constraint tender_approval_log.ck_tender_approval_log_shape CHECK (((workflow_key = ANY (ARRAY['tender.publication'::text, 'tender.award'::text, 'tender.cancellation'::text])) AND (action = ANY (ARRAY['REQUEST'::text, 'GRANT'::text, 'REJECT'::text, 'EXECUTE'::text, 'STALE'::text])) AND (outcome = ANY (ARRAY['GRANTED'::text, 'REFUSED'::text])) AND ((outcome = 'REFUSED'::text) = (refusal_code IS NOT NULL)) AND (btrim(actor_user_id) <> ''::text) AND (btrim(actor_organization_id) <> ''::text) AND ((step_order IS NULL) OR (step_order >= 1)))) deferrable=false/false valid=true`,
        ],
        unexpected: [
          `constraint tender_approval_log.ck_tender_approval_log_shape CHECK (((workflow_key = ANY (ARRAY['tender.publication'::text, 'tender.award'::text, 'tender.cancellation'::text])) AND (action = ANY (ARRAY['REQUEST'::text, 'GRANT'::text, 'REJECT'::text, 'EXECUTE'::text, 'STALE'::text])) AND (outcome = ANY (ARRAY['GRANTED'::text, 'REFUSED'::text])) AND ((outcome = 'REFUSED'::text) = (refusal_code IS NOT NULL)) AND (btrim(actor_user_id) <> ''::text) AND (btrim(actor_organization_id) <> ''::text) AND ((step_order IS NULL) OR (step_order >= 1)))) NOT VALID deferrable=false/false valid=false`,
        ],
      },
    },
    connectAs: 'migrator',
    scratchDatabase: true,
    tables: [
      'approval',
      'approval_policy',
      'approval_policy_step',
      'idempotency_key',
      'outbox_message',
      'outbox_stream_sequence',
      'policy_reconciliation_task',
      'processed_event',
      'progress_report',
      'project',
      'project_need',
      'tender',
      'criteria_template',
      'tender_criterion',
      'tender_invitation',
      'tender_key',
      // 20260930190000_contractor_standing, 20261001100000_tender_bids.
      'contractor_standing',
      'contractor_suspension',
      'standing_bootstrap',
      'bid',
      'bid_receipt',
      'bid_access_log',
      // 20261002150000_tender_evaluation (CON-002 PR 9).
      'bid_qualification',
      'bid_evaluation',
      'bid_evaluation_recusal',
      'bid_evaluation_score',
      // 20261003100000_tender_award (CON-002 PR 10).
      'tender_award',
      'tender_award_standing_check',
    ],
    // 20261003120000_actor_stable_identity (#188): one person is one evaluator of a bid.
    indexes: ['ux_bid_evaluation_person', 'ux_bid_recusal_person'],
    // 20260930170000_tender_criteria: a tender's criteria freeze with publication.
    // Also the publish-needs-criteria pair on `tender` and the template's append-only pair.
    // 20260930180000_tender_publication: a tender's key is never deleted and its
    // public half never changes.
    triggers: [
      'tg_tender_criterion_freeze',
      'tg_tender_publish_requires_criteria',
      'tg_tender_status_transition',
      'tg_criteria_template_append_only',
      'tg_criteria_template_no_truncate',
      'tg_tender_key_guard',
      // 20261001100000_tender_bids: the bid's deadline and edges, and two append-only logs.
      'tg_standing_bootstrap_guard',
      'tg_bid_guard',
      'tg_bid_receipt_append_only',
      'tg_bid_receipt_no_truncate',
      'tg_bid_access_log_append_only',
      'tg_bid_access_log_no_truncate',
      // 20261002150000_tender_evaluation: what evaluation records is append-only and only while EVALUATING.
      'tg_bid_qualification_guard',
      'tg_bid_status_requires_decision',
      'tg_bid_evaluation_guard',
      'tg_bid_recusal_guard',
      'tg_bid_score_guard',
      'tg_bid_qualification_append_only',
      'tg_bid_qualification_no_truncate',
      'tg_bid_evaluation_append_only',
      'tg_bid_evaluation_no_truncate',
      'tg_bid_recusal_append_only',
      'tg_bid_recusal_no_truncate',
      'tg_bid_score_append_only',
      'tg_bid_score_no_truncate',
      // 20261003100000_tender_award: an award only for an EVALUATED tender and a QUALIFIED bid of it,
      // the tender and the bids move only with it, and it commits only with both moved; append-only.
      'tg_tender_award_guard',
      'tg_tender_status_requires_award',
      'tg_bid_status_requires_award',
      'tg_tender_award_consistent',
      'tg_tender_award_append_only',
      'tg_tender_award_no_truncate',
      // The standing check of an award: its guard, and never deleted.
      'tg_award_standing_check_guard',
      'tg_award_standing_check_no_delete',
      'tg_award_standing_check_no_truncate',
      'tg_award_standing_check_conflict_announced',
    ],
    functions: [
      'tender_criterion_freeze',
      'tender_publish_requires_criteria',
      'tender_status_transition_guard',
      'criteria_template_append_only',
      'tender_key_guard',
      'standing_bootstrap_guard',
      'bid_guard',
      'bid_append_only',
      'bid_qualification_guard',
      'bid_decision_recorded',
      'bid_evaluation_guard',
      'bid_recusal_guard',
      'bid_score_guard',
      'tender_award_guard',
      'tender_award_recorded',
      'bid_award_recorded',
      'tender_award_consistent',
      'award_standing_check_guard',
      'award_standing_check_conflict_announced',
    ],
    constraints: [
      'ck_project_text_not_blank',
      'ck_project_actor_recorded',
      'ck_project_estimate_nonneg',
      'ck_project_cancellation_has_reason',
      'ck_project_version_positive',
      'ck_project_timestamps_ordered',
      'ck_project_area_valid',
      'ck_need_text_not_blank',
      'ck_need_actor_recorded',
      'ck_need_quantity_positive',
      'ck_need_estimate_nonneg',
      'ck_need_version_positive',
      'ck_need_submission_complete',
      'ck_need_withdrawal_complete',
      'ck_need_timestamps_ordered',
      // A completed idempotency key always names the resource it created.
      'ck_idempotency_completed_has_result',
      'ck_idempotency_claim_token_not_blank',
      // The tenant-bound foreign key: a need can only reference a project of
      // its own organization.
      'project_need_organization_id_project_id_fkey',
      // 20260926180000_approvals_and_progress (CON-001 PR 2): the authority is
      // never the oversight role, a decision names who and when and never
      // predates its request, a rejection says why, and every child is bound
      // to its parent's tenant.
      'ck_project_approval_round_nonneg',
      'ck_policy_author_role',
      'ck_policy_submission_complete',
      'ck_policy_rejection_complete',
      'ck_policy_activation_complete',
      'ck_policy_retirement_complete',
      // 20260930130000_policy_suspension (Q-83): a suspension names who, when
      // and why, exactly when the policy is SUSPENDED.
      'ck_policy_suspension_complete',
      // 20260930150000_policy_reconciliation_task (Q-83, D-041): a task's
      // lease is a time and its token or neither, DONE names when, and the
      // task is bound to its policy's tenant.
      'ck_reconciliation_text_not_blank',
      'ck_reconciliation_attempts_nonneg',
      'ck_reconciliation_done_complete',
      'ck_reconciliation_lease_pair',
      'policy_reconciliation_task_organization_id_policy_id_fkey',
      'ck_step_authority_not_oversight',
      'ck_step_amount_range',
      'ck_approval_decision_complete',
      'ck_approval_rejection_has_reason',
      'ck_approval_superseded_complete',
      'ck_approval_authority_not_oversight',
      'ck_progress_basis_points_range',
      'ck_progress_submission_complete',
      'ck_progress_submission_sequence_positive',
      'ck_progress_discard_complete',
      'approval_organization_id_project_id_fkey',
      'approval_organization_id_policy_id_fkey',
      'approval_policy_step_organization_id_policy_id_fkey',
      'progress_report_organization_id_project_id_fkey',
      // 20260930160000_tender_core (CON-002 PR 2, ADR-065): a tender is bound to
      // its project's tenant, names who acted, has a real bidding window, is
      // never published on a default, and a cancellation says why.
      'tender_organization_id_project_id_fkey',
      'ck_tender_text_not_blank',
      'ck_tender_actor_recorded',
      'ck_tender_version_positive',
      'ck_tender_timestamps_ordered',
      'ck_tender_window_ordered',
      'ck_tender_published_complete',
      'ck_tender_cancellation_has_reason',
      // 20260930170000_tender_criteria (CON-002 PR 4a, ADR-067 § 1).
      'tender_criterion_organization_id_tender_id_fkey',
      'ck_criteria_template_text_not_blank',
      'ck_criteria_template_version_positive',
      'ck_criteria_template_is_array',
      'ck_criteria_template_actor_recorded',
      'ck_criterion_text_not_blank',
      'ck_criterion_weight_range',
      'ck_criterion_position_positive',
      'ck_criterion_max_score',
      'ck_criterion_actor_recorded',
      // 20260930180000_tender_publication (CON-002 PR 4b, ADR-065, ADR-066 § 2).
      'ck_tender_publication_complete',
      'ck_tender_published_after_created',
      'tender_invitation_organization_id_tender_id_fkey',
      'ck_invitation_not_self',
      'ck_invitation_text_not_blank',
      'tender_key_organization_id_tender_id_fkey',
      'ck_tender_key_wrap_shape',
      'ck_tender_key_text_not_blank',
      'ck_standing_org_not_blank',
      'ck_suspension_text_not_blank',
      'ck_suspension_order',
      'ck_standing_bootstrap_singleton',
      'ck_standing_bootstrap_complete',
      'bid_organization_id_tender_id_fkey',
      'bid_receipt_organization_id_tender_id_fkey',
      'bid_access_log_organization_id_tender_id_fkey',
      'ck_bid_not_own_tender',
      'ck_bid_revision_positive',
      'ck_bid_seal_shape',
      'ck_bid_text_not_blank',
      'ck_bid_withdrawal_recorded',
      'ck_bid_received_after_submitted',
      'ck_bid_receipt_shape',
      'ck_bid_access_outcome',
      'ck_tender_evaluation_complete',
      'ck_bid_access_refusal_code',
      'ck_bid_qualification_reason',
      'ck_bid_qualification_text_not_blank',
      'ck_bid_evaluation_text_not_blank',
      'ck_bid_recusal_text_not_blank',
      'ck_bid_score_shape',
      'bid_qualification_organization_id_tender_id_fkey',
      'bid_evaluation_organization_id_tender_id_fkey',
      'bid_evaluation_recusal_organization_id_tender_id_fkey',
      'bid_evaluation_score_organization_id_tender_id_fkey',
      'bid_evaluation_score_organization_id_evaluation_id_fkey',
      'ck_tender_award_shape',
      'ck_tender_award_not_own',
      'ck_tender_award_justified',
      'ck_tender_award_actor_pair',
      'tender_award_organization_id_tender_id_fkey',
      'tender_award_bid_id_fkey',
      'ck_award_standing_check_shape',
      'tender_award_standing_check_organization_id_tender_id_fkey',
      // 20261003120000_actor_stable_identity (#188 part B): each person a later check compares
      // carries the token's issuer and subject, both or neither, never blank.
      'ck_tender_created_by_identity',
      'ck_tender_published_by_identity',
      'ck_tender_evaluated_by_identity',
      'ck_tender_opening_proposed_by_identity',
      'ck_policy_created_by_identity',
      'ck_policy_submitted_by_identity',
      'ck_bid_qualification_decided_by_identity',
      'ck_bid_evaluation_evaluator_identity',
      'ck_bid_recusal_evaluator_identity',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
  /**
   * contract-service (CON-003 PR 1, ADR-068). One initial migration that folds the
   * domain schema and the outbox together, as supplier's and construction's do, so its
   * outbox objects are verified here rather than by the by-name outbox verifiers
   * (`verify-outbox-claim-migration.mjs` lists it as folded).
   *
   * The domain objects listed are the ones carrying a claim a reader would otherwise
   * take on trust: the price is positive, the parties are two organizations, and what a
   * contract was made from never changes and the contract is never erased.
   */
  contract: {
    // D-045: the runtime role owns nothing and lost CREATEDB, so the scratch schema is
    // created — and migrated — as the migrator, which owns rasta_contract.
    connectAs: 'migrator',
    tables: ['contract', 'outbox_message', 'outbox_stream_sequence'],
    types: ['ContractStatus'],
    triggers: ['tg_contract_guard', 'tg_contract_no_truncate'],
    functions: ['contract_guard'],
    indexes: [
      'ux_contract_org_tender',
      'ux_contract_org_id',
      'ix_contract_org_status',
      'ix_contract_contractor',
    ],
    constraints: [
      'ck_contract_text_not_blank',
      'ck_contract_amount_positive',
      'ck_contract_parties_distinct',
      'ck_contract_matrix_digest',
      'ck_contract_actor_recorded',
      'ck_contract_version_positive',
      'ck_contract_timestamps_ordered',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
  /*
   * The five services whose initial migration had no down.sql until the
   * platform-safety pass (lane 6), so the whole-chain check could not reach
   * any of their migrations. The lists name the tables and the hand-written
   * invariants; the exact-inverse snapshot (see `snapshotQuery`) covers every
   * other object without having to be listed here.
   */
  identity: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_identity.
    connectAs: 'migrator',
    tables: [
      'audit_correction_command',
      'idempotency_key',
      'membership',
      'organization_ref',
      'outbox_message',
      'outbox_stream_sequence',
      'permission',
      'processed_event',
      'registration_request',
      'role',
      'role_permission',
      'security_event_outbox',
      'user',
    ],
    triggers: ['tg_security_event_outbox_guard'],
    functions: ['security_event_outbox_guard'],
    // One live membership per (user, organization): a down script that dropped
    // it without the forward migration restoring it would bring back the
    // concurrent double membership it closes, silently.
    indexes: ['ux_membership_live_user_org'],
    dataRollback: IDENTITY_DATA_ROLLBACK,
    constraints: [
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      'ck_security_event_outbox_claim_triple',
      'ck_security_event_outbox_published_was_claimed',
      'ck_security_event_outbox_window_bounds',
      'ck_security_event_outbox_occurrence_count_range',
    ],
  },
  organization: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_organization.
    connectAs: 'migrator',
    // ltree / geography, unqualified in its migrations: see `scratchDatabase`
    // in verify-migration-reversible.mjs.
    scratchDatabase: true,
    // `CREATE EXTENSION IF NOT EXISTS btree_gist` for the policy no-overlap
    // exclusion; its down script leaves it, for the reason its header gives
    // (the bootstrap installs it too, so the migration may not have added it).
    keptExtensions: {
      '20260925150000_policy_timeline_and_primary_contact': ['btree_gist'],
    },
    tables: [
      'idempotency_key',
      'organization',
      'organization_contact',
      'organization_location',
      'organization_policy',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
    ],
    triggers: [],
    constraints: [
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      'ck_policy_effective_range',
      'ex_policy_no_overlap',
    ],
  },
  asset: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_asset.
    connectAs: 'migrator',
    // ltree / geography, unqualified in its migrations: see `scratchDatabase`
    // in verify-migration-reversible.mjs.
    scratchDatabase: true,
    tables: [
      'asset',
      'asset_document_ref',
      'asset_location',
      'asset_timeline_entry',
      'asset_transfer',
      'idempotency_key',
      'insurance_claim',
      'insurance_policy',
      'organization_ref',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      'technical_inspection',
    ],
    triggers: [],
    dataRollback: ASSET_DATA_ROLLBACK,
    constraints: [
      'ck_claim_approved_amount_non_negative',
      'ck_claim_claimed_amount_non_negative',
      'ck_claim_decided_iff_decision_recorded',
      'ck_claim_rejected_has_no_approved_amount',
      'ck_claim_settled_iff_settlement_recorded',
      'ck_idempotency_claim_token_not_blank',
      'ck_idempotency_completed_has_response',
      'ck_idempotency_key_not_blank',
      'ck_idempotency_state',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      'ck_policy_insured_value_non_negative',
      'ck_policy_premium_non_negative',
    ],
  },
  fleet: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_fleet.
    connectAs: 'migrator',
    tables: [
      'asset_ref',
      'assignment',
      'availability_window',
      'driver',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      'usage_record',
    ],
    triggers: [],
    constraints: [
      'ck_assignment_period',
      'ck_availability_period',
      'ck_driver_status_reason',
      'ck_usage_has_measure',
      'ck_usage_non_negative',
      'ck_usage_period',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
    // Added by 20261005130000_availability_window_one_live (review #225 r1):
    // one live window per machine, a partial index only the migration holds.
    indexes: ['ux_availability_window_live'],
  },
  maintenance: {
    // D-045: the runtime role owns nothing and cannot create the scratch schema
    // or database; the migrator owns rasta_maintenance.
    connectAs: 'migrator',
    tables: [
      'asset_ref',
      'asset_usage_meter',
      'labor_entry',
      'maintenance_cost',
      'maintenance_request',
      'maintenance_schedule',
      'outbox_message',
      'outbox_stream_sequence',
      'part_usage',
      'processed_event',
      'repair_order',
    ],
    triggers: [],
    constraints: [
      'ck_cost_provenance',
      'ck_labor_entry_amounts',
      'ck_part_usage_amounts',
      'ck_repair_order_cancellation',
      'ck_repair_order_period',
      'ck_repair_order_totals',
      'ck_request_downtime',
      'ck_request_period',
      'ck_request_severity_matches_type',
      'ck_request_terminal_attribution',
      'ck_request_total_non_negative',
      'ck_schedule_anchors_non_negative',
      'ck_schedule_has_interval',
      'ck_schedule_intervals_positive',
      'ck_usage_meter_non_negative',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
};

/**
 * A DO block that raises unless every named object is present (or absent).
 *
 * `prisma db execute` reports no rows, only an exit status — so the assertion
 * has to be expressed as an error the database raises. That is a feature here:
 * the failure message names the object, not just "expected 6, got 5".
 *
 * `indexes`, `types` and `functions` are optional and were added for AUD-003,
 * where the objects carrying the claim are neither tables nor constraints: the
 * chain-order index the verification walk depends on, the enum that
 * discriminates a tenant chain from the platform chain, and the trigger
 * function that actually refuses a rewind. A down script that dropped the
 * enum's table but left the enum behind, a forward migration that quietly
 * stopped creating the index, or a rollback that dropped a trigger and orphaned
 * its function all pass a table-and-constraint check while leaving a store
 * whose verification either cannot run, runs by sequential scan, or cannot be
 * re-applied at all.
 */
/**
 * The connection a verification runs on, and the variable it came from.
 *
 * A service whose EXPECTED entry says `connectAs: 'migrator'` is verified as its
 * migrator — the role that owns its database and runs its migrations (D-045) —
 * and **only** as that: `DATABASE_URL_<SVC>_MIGRATOR` is required, and the
 * generic `DATABASE_URL` is never used in its place (Codex review of #178).
 * A shell's DATABASE_URL naming some other role would otherwise be taken
 * silently, and the scratch schema made — or refused — by the wrong owner.
 * Every other service keeps the old order: DATABASE_URL, then
 * DATABASE_URL_<SVC>.
 *
 * Returns `{ key, url }`, or `{ key, error }` naming what to set.
 */
export function verifierConnection(service, env = process.env) {
  const serviceKey = `DATABASE_URL_${service.replaceAll('-', '_').toUpperCase()}`;
  if (EXPECTED[service]?.connectAs === 'migrator') {
    const key = `${serviceKey}_MIGRATOR`;
    if (env[key]) return { key, url: env[key] };
    return {
      key,
      error:
        `${key} is not set. ${service}-service is verified as its migrator only — DATABASE_URL ` +
        'is not used in its place. Copy .env.migrator.example to .env.migrator, or export it.',
    };
  }
  if (env.DATABASE_URL) return { key: 'DATABASE_URL', url: env.DATABASE_URL };
  if (env[serviceKey]) return { key: serviceKey, url: env[serviceKey] };
  return {
    key: serviceKey,
    error: `${serviceKey} is not set. Copy .env.example to .env, or set DATABASE_URL.`,
  };
}

/** Who a verification is connected as; `psql -At` prints `current|session|superuser`. */
export const CONNECTED_ROLE_PROBE =
  'SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname = current_user';

/**
 * For a `connectAs: 'migrator'` service, the reason the connection behind
 * `probeOutput` (CONNECTED_ROLE_PROBE's) is not exactly that service's
 * migrator, or null when it is (Codex round 3 on #176). A superuser — or any
 * other role the URL happened to name — would make the scratch schemas and pass
 * checks the migrator itself might fail, so the verification would prove
 * nothing about the role migrations really run as. Other services: always null.
 */
export function verifierRoleProblem(service, probeOutput) {
  if (EXPECTED[service]?.connectAs !== 'migrator') return null;
  const expected = `rasta_${service.replaceAll('-', '_')}_migrator`;
  const [current, session, superuser] = String(probeOutput).trim().split('|');
  if (!current) return `could not tell which role the ${service} verification is connected as`;
  if (superuser === 't') return `connected as ${current}, a superuser — not ${expected}`;
  if (current !== expected || session !== expected) {
    return `connected as ${session === current ? current : `${session} (SET ROLE ${current})`} — not ${expected}`;
  }
  return null;
}

export function assertionScript(expected, present, schema) {
  const {
    tables,
    triggers,
    constraints,
    indexes = [],
    types = [],
    functions = [],
    enumValues = [],
  } = expected;
  const not = present ? 'NOT ' : '';
  const verb = present ? 'missing' : 'still present';

  const checks = [
    ...tables.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_tables
                       WHERE schemaname = '${schema}' AND tablename = '${name}') THEN
        RAISE EXCEPTION 'table % is ${verb}', '${name}';
      END IF;`,
    ),
    ...triggers.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_trigger t
                         JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = '${schema}' AND t.tgname = '${name}') THEN
        RAISE EXCEPTION 'trigger % is ${verb}', '${name}';
      END IF;`,
    ),
    ...constraints.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_constraint con
                         JOIN pg_namespace n ON n.oid = con.connamespace
                       WHERE n.nspname = '${schema}' AND con.conname = '${name}') THEN
        RAISE EXCEPTION 'constraint % is ${verb}', '${name}';
      END IF;`,
    ),
    // `pg_class`/`pg_namespace` rather than `pg_indexes`, because an index on a
    // *partitioned* parent has no `pg_indexes` row of its own in every server
    // version, and `audit_event_chain_idx` is exactly that shape.
    ...indexes.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = '${schema}' AND c.relname = '${name}'
                         AND c.relkind IN ('i', 'I')) THEN
        RAISE EXCEPTION 'index % is ${verb}', '${name}';
      END IF;`,
    ),
    ...types.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_type t
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                       WHERE n.nspname = '${schema}' AND t.typname = '${name}') THEN
        RAISE EXCEPTION 'type % is ${verb}', '${name}';
      END IF;`,
    ),
    ...functions.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_proc p
                         JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = '${schema}' AND p.proname = '${name}') THEN
        RAISE EXCEPTION 'function % is ${verb}', '${name}';
      END IF;`,
    ),
    // A *value* inside an enum, which a type-name check cannot see. PostgreSQL
    // has no `ALTER TYPE ... DROP VALUE`, so a down script that has to remove
    // one rebuilds the whole type and re-points every column at the new one.
    // That is several statements in a specific order, and every way of getting
    // it wrong leaves a type with the right name — which is all the check above
    // ever asked about.
    ...enumValues.map(
      ([type, value]) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_enum e
                         JOIN pg_type t ON t.oid = e.enumtypid
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                       WHERE n.nspname = '${schema}' AND t.typname = '${type}'
                         AND e.enumlabel = '${value}') THEN
        RAISE EXCEPTION 'enum value %.% is ${verb}', '${type}', '${value}';
      END IF;`,
    ),
  ].join('\n');

  return `DO $$\nBEGIN\n${checks}\nEND\n$$;`;
}

// -----------------------------------------------------------------------------
// Exact inverse
//
// `assertionScript` checks that *named* objects exist or do not. That catches a
// down script that forgot a table, but not one that restored an object with a
// different definition, restored a weaker CHECK under the same name, or left
// its `_prisma_migrations` row behind so a later `migrate deploy` silently
// skipped it — which is exactly how supplier's blank-text hardening could
// "pass" while its rollback was incomplete: after the whole-chain reversal,
// its ledger row survived, the re-deploy applied only the initial migration,
// and every constraint was back under its old name with the old predicate.
//
// So each migration's down.sql is also held to the state *before* that
// migration, compared as a whole: a catalogue snapshot of the schema — every
// relation, column, constraint, index, trigger, function, enum, domain,
// sequence, view, policy, rule and comment, each rendered by PostgreSQL's own
// `pg_get_*def` — taken from a reference schema built by applying each
// migration.sql in turn.
// -----------------------------------------------------------------------------

/** A schema name safe to interpolate into SQL. */
export function assertSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Refusing schema name ${JSON.stringify(schema)}: lowercase identifiers only.`);
  }
  return schema;
}

/**
 * One row per catalogue object in `schema`, each a single line of text with
 * the schema's own name removed, so two schemas holding the same objects
 * produce identical rows. Prisma's `_prisma_migrations` table is excluded: its
 * rows are asserted separately, and its structure belongs to Prisma.
 * Extension members are excluded too — they are the extension's, not a
 * migration's.
 *
 * The extensions themselves are not (Codex post-merge review of #105,
 * finding 3): one row per `pg_extension` — name, version and schema — for the
 * whole database, since that is where an extension lives. A down script that
 * leaves behind an extension its migration created, drops one that was there
 * before, or leaves one at another version, differs here like any other
 * object. These rows are not stripped of the schema name — they are not the
 * schema's — but an extension in the schema under test, or in
 * `extensionHome`, reads `schema=(target)`: a migration's
 * `CREATE EXTENSION IF NOT EXISTS` lands in the first schema on the search
 * path, which is the reference schema when the reference is built and the
 * target schema (`public`, in a scratch database) when Prisma deploys. The
 * two runs put the same extension in different places by construction, and
 * only a difference a down script makes should show.
 */
export function snapshotQuery(schema, extensionHome = schema) {
  assertSchemaName(schema);
  assertSchemaName(extensionHome);
  const strip = (expression) =>
    `replace(replace(${expression}, '"${schema}".', ''), '${schema}.', '')`;
  return `
    WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = '${schema}'),
    ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
    ledger AS (
      SELECT c.oid FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relname = '_prisma_migrations'
    ),
    owned AS (
      -- Relations a migration created: not the ledger, and not an extension's
      -- (postgis puts spatial_ref_sys, geometry_columns and its composite
      -- types into public). A composite type's membership is recorded on its
      -- pg_type row, not on the relation.
      SELECT c.* FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM ns)
        AND c.relkind NOT IN ('i', 'I')
        AND c.oid NOT IN (SELECT objid FROM ext)
        AND c.reltype NOT IN (SELECT objid FROM ext)
        AND c.oid NOT IN (SELECT oid FROM ledger)
    ),
    rel AS (
      -- Plus the indexes on those relations — and only those, so an
      -- extension's index or the ledger's primary key never appears.
      SELECT * FROM owned
      UNION ALL
      SELECT c.* FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE i.indrelid IN (SELECT oid FROM owned)
    ),
    items AS (
      SELECT 'relation ' || r.relname || ' kind=' || r.relkind::text
             || ' persistence=' || r.relpersistence::text
             || ' rls=' || r.relrowsecurity || '/' || r.relforcerowsecurity
             -- NULL means "the owner's default privileges"; a GRANT followed
             -- by its REVOKE leaves the same privileges spelled out. Compared
             -- through acldefault so that exact inverse is not a false failure
             -- (supplier's runtime-privileges migration).
             || ' acl=' || coalesce(
                  r.relacl,
                  acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner)
                )::text
             || ' partkey=' || coalesce(pg_get_partkeydef(r.oid), '-')
             || ' bound=' || coalesce(pg_get_expr(r.relpartbound, r.oid), '-') AS item
      FROM rel r WHERE r.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
      UNION ALL
      SELECT 'column ' || r.relname || '.' || a.attname
             || ' ' || format_type(a.atttypid, a.atttypmod)
             || ' notnull=' || a.attnotnull
             || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
             || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
             || ' collation=' || coalesce(co.collname, '-')
      FROM rel r
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
        AND co.collname <> 'default'
      WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
      UNION ALL
      SELECT 'constraint ' || coalesce(r.relname, t.typname) || '.' || con.conname
             || ' ' || pg_get_constraintdef(con.oid)
             || ' deferrable=' || con.condeferrable || '/' || con.condeferred
             || ' valid=' || con.convalidated
      FROM pg_constraint con
      LEFT JOIN pg_class r ON r.oid = con.conrelid
      LEFT JOIN pg_type t ON t.oid = con.contypid
      WHERE con.connamespace = (SELECT oid FROM ns)
        AND (con.conrelid = 0 OR con.conrelid IN (SELECT oid FROM rel))
      UNION ALL
      SELECT 'index ' || r.relname || ' ' || pg_get_indexdef(r.oid)
      FROM rel r WHERE r.relkind IN ('i', 'I')
      UNION ALL
      SELECT 'trigger ' || r.relname || '.' || tg.tgname || ' ' || pg_get_triggerdef(tg.oid)
             || ' enabled=' || tg.tgenabled::text
      FROM pg_trigger tg JOIN rel r ON r.oid = tg.tgrelid
      WHERE NOT tg.tgisinternal
      UNION ALL
      SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
             || ' kind=' || p.prokind::text
             || ' ' || CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END
      FROM pg_proc p
      WHERE p.pronamespace = (SELECT oid FROM ns) AND p.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'enum ' || t.typname || ' '
             || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid)
      FROM pg_type t
      WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'e'
        AND t.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'domain ' || t.typname || ' ' || format_type(t.typbasetype, t.typtypmod)
             || ' notnull=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
      FROM pg_type t
      WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'd'
        AND t.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'sequence ' || r.relname || ' ' || format_type(s.seqtypid, NULL)
             || ' start=' || s.seqstart || ' increment=' || s.seqincrement
             || ' min=' || s.seqmin || ' max=' || s.seqmax
             || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
      FROM pg_sequence s JOIN rel r ON r.oid = s.seqrelid
      UNION ALL
      SELECT 'sequence-owner ' || s.relname || ' ' || t.relname || '.' || a.attname
      FROM pg_depend dep
      JOIN rel s ON s.oid = dep.objid AND s.relkind = 'S'
      JOIN pg_class t ON t.oid = dep.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
      WHERE dep.classid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
      UNION ALL
      SELECT 'view ' || r.relname || ' ' || pg_get_viewdef(r.oid)
      FROM rel r WHERE r.relkind IN ('v', 'm')
      UNION ALL
      SELECT 'policy ' || pol.tablename || '.' || pol.policyname || ' ' || pol.permissive
             || ' ' || pol.roles::text || ' ' || pol.cmd
             || ' using=' || coalesce(pol.qual, '-') || ' check=' || coalesce(pol.with_check, '-')
      FROM pg_policies pol
      JOIN owned r ON r.relname = pol.tablename
      WHERE pol.schemaname = '${schema}'
      UNION ALL
      SELECT 'rule ' || ru.tablename || '.' || ru.rulename || ' ' || ru.definition
      FROM pg_rules ru
      JOIN owned r ON r.relname = ru.tablename
      WHERE ru.schemaname = '${schema}'
      UNION ALL
      SELECT 'comment ' || r.relname || coalesce('.' || a.attname, '') || ' ' || dsc.description
      FROM pg_description dsc
      JOIN rel r ON r.oid = dsc.objoid AND dsc.classoid = 'pg_class'::regclass
      LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = dsc.objsubid AND dsc.objsubid > 0
    )
    SELECT ${strip('item')} AS item FROM items
    UNION ALL
    -- Database-wide, so rendered as they are, outside the schema stripping.
    SELECT 'extension ' || e.extname || ' version=' || e.extversion || ' schema='
           || CASE WHEN n.nspname IN ('${schema}', '${extensionHome}') THEN '(target)'
                   ELSE n.nspname END
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`;
}

/** The table snapshots are recorded into, in a schema of the verifier's own. */
export function snapshotStoreScript(metaSchema) {
  assertSchemaName(metaSchema);
  return `DROP SCHEMA IF EXISTS "${metaSchema}" CASCADE;
CREATE SCHEMA "${metaSchema}";
CREATE TABLE "${metaSchema}".snapshot (label text NOT NULL, item text NOT NULL);`;
}

/** Records `schema`'s current state under `label`. */
export function recordSnapshotScript(metaSchema, label, schema, extensionHome = schema) {
  assertSchemaName(metaSchema);
  if (!/^[A-Za-z0-9_:.-]+$/.test(label)) throw new Error(`Unsafe snapshot label ${label}`);
  return `INSERT INTO "${metaSchema}".snapshot (label, item)
SELECT '${label}', item FROM (${snapshotQuery(schema, extensionHome)}) s;`;
}

/**
 * Raises unless `schema` is exactly the state recorded under `label`, listing
 * what is missing and what is extra — as PostgreSQL renders each — so a
 * failure says which object a down script got wrong, not just that one did.
 *
 * `keptExtensions` names extensions this down script may leave installed
 * (`EXPECTED[service].keptExtensions`). Such an extension is tolerated as
 * extra only as the **exact** row recorded under `keptFrom` — the target's own
 * state right after `prisma migrate deploy` — name, version and schema alike
 * (Codex review of #117, finding 4): a down script that leaves it at another
 * version, or moves it to another schema, still fails. Nothing else is
 * tolerated — not another extension, and not a missing one. Unlike
 * `allowance`, it cannot be required to match: whether the migration's
 * `CREATE EXTENSION IF NOT EXISTS` created anything depends on the cluster
 * (the bootstrap pre-installs it into template1), so it is pinned statically
 * instead — see the lib test.
 *
 * `extensionHome`: see `snapshotQuery`.
 */
export function assertSnapshotScript(
  metaSchema,
  label,
  schema,
  context,
  allowance = { missing: [], unexpected: [] },
  { keptExtensions = [], keptFrom = null, extensionHome = schema } = {},
) {
  assertSchemaName(metaSchema);
  if (!/^[A-Za-z0-9_:.-]+$/.test(label)) throw new Error(`Unsafe snapshot label ${label}`);
  for (const name of keptExtensions) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe extension name ${name}`);
  }
  if (keptExtensions.length > 0 && keptFrom === null) {
    throw new Error('keptExtensions needs keptFrom: the snapshot whose exact rows it may keep');
  }
  if (keptFrom !== null && !/^[A-Za-z0-9_:.-]+$/.test(keptFrom)) {
    throw new Error(`Unsafe snapshot label ${keptFrom}`);
  }
  const safeContext = context.replaceAll("'", "''");
  const literalArray = (items) =>
    items.length === 0
      ? 'ARRAY[]::text[]'
      : `ARRAY[${items.map((item) => `'${item.replaceAll("'", "''")}'`).join(', ')}]::text[]`;
  const allowedMissing = literalArray(allowance.missing ?? []);
  const allowedUnexpected = literalArray(allowance.unexpected ?? []);
  const kept = literalArray(keptExtensions);
  const live = snapshotQuery(schema, extensionHome);
  const recorded = `SELECT item FROM "${metaSchema}".snapshot WHERE label = '${label}'`;
  return `DO $exact$
DECLARE
  missing text[];
  unexpected text[];
BEGIN
  IF NOT EXISTS (${recorded}) AND EXISTS (${live}) THEN
    RAISE EXCEPTION '${safeContext}: no reference snapshot "${label}", and the schema is not empty';
  END IF;
  missing := ARRAY(${recorded} EXCEPT ALL SELECT item FROM (${live}) l);
  unexpected := ARRAY(SELECT item FROM (${live}) l EXCEPT ALL ${recorded});

  -- A documented allowance must match exactly: its items must really be part
  -- of the difference, or it has gone stale — which is itself a failure, so
  -- the exception cannot outlive the reason for it.
  IF NOT (${allowedMissing} <@ missing) OR NOT (${allowedUnexpected} <@ unexpected) THEN
    RAISE EXCEPTION E'${safeContext}: a documented inexact-inverse allowance no longer matches\\n expected but missing:\\n  %\\n present but not expected:\\n  %',
      array_to_string(missing, E'\\n  '), array_to_string(unexpected, E'\\n  ');
  END IF;
  missing := ARRAY(SELECT unnest(missing) EXCEPT ALL SELECT unnest(${allowedMissing}));
  unexpected := ARRAY(SELECT unnest(unexpected) EXCEPT ALL SELECT unnest(${allowedUnexpected}));
  -- An extension this down script is documented to leave installed: by exact
  -- name (btree_gist must not also excuse btree_gin), and only as the exact
  -- row the target had right after its deploy — same version, same schema.
  unexpected := ARRAY(
    SELECT u FROM unnest(unexpected) u
    WHERE NOT (
      split_part(u, ' ', 1) = 'extension'
      AND split_part(u, ' ', 2) = ANY (${kept})
      AND u IN (SELECT item FROM "${metaSchema}".snapshot WHERE label = ${keptFrom === null ? 'NULL' : `'${keptFrom}'`})
    )
  );

  IF cardinality(missing) > 0 OR cardinality(unexpected) > 0 THEN
    RAISE EXCEPTION E'${safeContext}: not the exact expected schema\\n expected but missing:\\n  %\\n present but not expected:\\n  %',
      coalesce(nullif(array_to_string(ARRAY(SELECT unnest(missing) ORDER BY 1), E'\\n  '), ''), '(none)'),
      coalesce(nullif(array_to_string(ARRAY(SELECT unnest(unexpected) ORDER BY 1), E'\\n  '), ''), '(none)');
  END IF;
END
$exact$;`;
}

/**
 * Raises unless the ledger holds exactly `applied`, one row each, every one
 * finished and none rolled back. After a down script, that is every earlier
 * migration and not this one; after a re-deploy, all of them.
 *
 * Every row counts (Codex post-merge review of #105, finding 4). Reading only
 * finished, non-rolled-back rows let a down script that marked its row rolled
 * back — or a half-applied deploy's unfinished row — pass as removed, and
 * `migrate deploy` treats neither like an absent row. So: an unfinished or
 * rolled-back row anywhere fails, a duplicate fails, and `removed` (the
 * migration whose down script just ran) must have no row at all.
 */
export function ledgerAssertionScript(applied, context, removed = null) {
  const safeName = (name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe migration name ${name}`);
    return `'${name}'`;
  };
  const names = applied.map(safeName);
  const expected = names.length > 0 ? `ARRAY[${names.join(', ')}]::text[]` : `ARRAY[]::text[]`;
  const removedCheck =
    removed === null
      ? ''
      : `
  IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${safeName(removed)}) THEN
    RAISE EXCEPTION E'${context.replaceAll("'", "''")}: _prisma_migrations still has a row for %, in any state', ${safeName(removed)};
  END IF;`;
  const safeContext = context.replaceAll("'", "''");
  return `DO $ledger$
DECLARE
  actual text[];
  irregular text[];
BEGIN${removedCheck}
  irregular := ARRAY(
    SELECT migration_name || CASE WHEN finished_at IS NULL THEN ' (unfinished)' ELSE ' (rolled back)' END
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
    ORDER BY 1
  );
  IF cardinality(irregular) > 0 THEN
    RAISE EXCEPTION E'${safeContext}: _prisma_migrations holds rows that are not cleanly applied: %', irregular;
  END IF;
  -- Every row, duplicates included: two rows for one name is not one migration.
  SELECT coalesce(array_agg(migration_name ORDER BY migration_name), ARRAY[]::text[]) INTO actual
  FROM "_prisma_migrations";
  IF actual IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) FROM unnest(${expected}) x) THEN
    RAISE EXCEPTION E'${safeContext}: _prisma_migrations holds %, expected %', actual, ${expected};
  END IF;
END
$ledger$;`;
}

// ---------------------------------------------------------------------------
// Scratch databases: one per run, marked, dropped only by the run that made it
// ---------------------------------------------------------------------------

/** Every scratch database's name starts with this. */
export const SCRATCH_DATABASE_PREFIX = 'rasta_scratch_';

/** The comment a scratch database carries: `rasta-scratch:<purpose>:<run id>:<created at>`. */
export const SCRATCH_MARKER_PREFIX = 'rasta-scratch:';

const SCRATCH_NAME = /^rasta_scratch_[a-z0-9_]{1,49}$/;
const LABEL = /^[a-z0-9_]{1,24}$/;
const PURPOSE = /^[a-z0-9-]{1,40}$/;
const RUN_ID = /^[a-z0-9]{16}$/;
const MARKER =
  /^rasta-scratch:([a-z0-9-]{1,40}):([a-z0-9]{16}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/**
 * A new scratch database for this run: a name no other run can hold (the
 * reserved prefix, `label` and a random run id) and the marker it is created
 * with, which repeats that run id and records when it was made.
 *
 * Unique per run on purpose (review of #133, round 2): two runs against one
 * server — two worktrees sharing the development PostgreSQL — must never be
 * able to drop each other's database, and a crash between CREATE and COMMENT
 * must not leave behind a name the next run needs.
 */
export function newScratchDatabase(
  purpose,
  label,
  { now = new Date(), runId = randomRunId() } = {},
) {
  if (typeof label !== 'string' || !LABEL.test(label)) {
    throw new Error(`Not a scratch database label: ${label}`);
  }
  assertPurpose(purpose);
  if (!RUN_ID.test(runId)) throw new Error(`Not a scratch run id: ${runId}`);
  const name = `${SCRATCH_DATABASE_PREFIX}${label}_${runId}`;
  assertScratchDatabaseName(name);
  return { name, marker: `${SCRATCH_MARKER_PREFIX}${purpose}:${runId}:${now.toISOString()}` };
}

function randomRunId() {
  return randomBytes(10).toString('hex').slice(0, 16);
}

function assertScratchDatabaseName(database) {
  if (
    typeof database !== 'string' ||
    !SCRATCH_NAME.test(database) ||
    database === 'postgres' ||
    database.startsWith('template')
  ) {
    throw new Error(`Not a scratch database name: ${database}`);
  }
}

function assertPurpose(purpose) {
  if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) {
    throw new Error(`Not a scratch database purpose: ${purpose}`);
  }
}

function assertScratch(scratch) {
  assertScratchDatabaseName(scratch?.name);
  if (typeof scratch.marker !== 'string' || !MARKER.test(scratch.marker)) {
    throw new Error(`Not a scratch database marker: ${scratch.marker}`);
  }
}

/**
 * The SQL of one scratch database's life, for a caller that owns it but is not
 * a superuser — the service roles CI verifies as.
 *
 * **Only the run that made it drops it.** `inspect` reads — and changes
 * nothing — whether the database is absent, or carries exactly this run's
 * marker, is owned by this role and is not the one the session is connected
 * to; `prepare` checks the same again before it alters anything. Anything else
 * is refused and left as it is, connectable.
 *
 * **Why not `DROP DATABASE … WITH (FORCE)`.** FORCE must terminate every
 * backend in the database, and a role that is not a superuser may terminate
 * only its own: an autovacuum worker — which a freshly migrated database
 * attracts within a second and which runs under no ordinary role — fails the
 * whole statement with "permission denied to terminate process" (main,
 * cd0c39a; reproduced on PostgreSQL 16.13). Instead, `prepare` closes the
 * database to new connections and terminates only this role's own sessions
 * there, and `drop` is a plain `DROP DATABASE`: PostgreSQL itself signals
 * autovacuum workers and waits up to five seconds for every other backend.
 * Another role's session is waited for, never killed.
 */
export function scratchDatabaseSql(scratch) {
  assertScratch(scratch);
  const { name, marker } = scratch;
  const notOurs = `d.datname = current_database()
      OR pg_get_userbyid(d.datdba) <> current_user
      OR shobj_description(d.oid, 'pg_database') IS DISTINCT FROM '${marker}'`;
  return {
    create: `CREATE DATABASE "${name}" TEMPLATE template1;`,
    mark: `COMMENT ON DATABASE "${name}" IS '${marker}';`,
    inspect: `SELECT CASE
  WHEN d.oid IS NULL THEN 'absent'
  WHEN d.datname = current_database() THEN 'refuse:it is the database this session is connected to'
  WHEN pg_get_userbyid(d.datdba) <> current_user THEN 'refuse:it is owned by another role'
  WHEN shobj_description(d.oid, 'pg_database') IS DISTINCT FROM '${marker}'
    THEN 'refuse:it does not carry this run''s scratch marker'
  ELSE 'marked'
END
FROM (SELECT 1) AS one LEFT JOIN pg_database AS d ON d.datname = '${name}';`,
    prepare: `DO $drop$
DECLARE
  d record;
BEGIN
  SELECT oid, datname, datdba INTO d FROM pg_database WHERE datname = '${name}';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF ${notOurs} THEN
    RAISE EXCEPTION 'rasta-scratch: refusing to touch database %: not this run''s scratch database', '${name}';
  END IF;
  EXECUTE format('ALTER DATABASE %I ALLOW_CONNECTIONS false', '${name}');
  PERFORM pg_terminate_backend(pid)
    FROM pg_stat_activity
   WHERE datname = '${name}' AND usename = current_user AND pid <> pg_backend_pid();
END
$drop$;`,
    drop: `DROP DATABASE IF EXISTS "${name}";`,
  };
}

/**
 * The SQLSTATE of the error psql reported, from the structured field — never
 * the message text, which is localized and may contain anything, a database
 * name included. Needs `VERBOSITY=verbose`, where an error line is
 * `<severity>:  <SQLSTATE>: <message>`; the severity is localized, the code
 * is not. Notices and warnings (classes 00 and 01) are skipped.
 */
export function sqlstateFrom(stderr) {
  let found = null;
  for (const match of String(stderr ?? '').matchAll(/^[^\s:]+:\s+([0-9A-Z]{5}):/gm)) {
    const code = match[1];
    if (!code.startsWith('00') && !code.startsWith('01')) found = code;
  }
  return found;
}

/**
 * Query parameters only Prisma understands. Everything else — `sslmode`,
 * `sslrootcert`, `connect_timeout`, `application_name` and the rest of
 * libpq's — is kept, so psql connects exactly as configured.
 */
const PRISMA_ONLY_PARAMETERS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
];

/**
 * `target` with `params` as its query, each name and value percent-encoded.
 *
 * Not `URLSearchParams`: it writes a space as `+`, which libpq's URI parser
 * does not decode — `options=-c TimeZone=UTC` (L7-37) would reach the server
 * as `-c+TimeZone=UTC` and the connection be refused. Prisma reads either.
 */
function withLibpqQuery(target, params) {
  const query = params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  target.search = '';
  return query ? `${target.toString()}?${query}` : target.toString();
}

/** `url` as libpq should see it: Prisma's own parameters removed, libpq's kept. */
export function libpqUrl(url) {
  const target = new URL(url);
  const kept = [...target.searchParams].filter(([name]) => !PRISMA_ONLY_PARAMETERS.includes(name));
  return withLibpqQuery(target, kept);
}

/**
 * How to hand `url` to psql without putting its password on the command line,
 * where any local user can read it (`ps`, `/proc/<pid>/cmdline`) for as long
 * as the process runs (D-045 follow-up). `target` is the libpq URL with the
 * password removed — from the userinfo and from a `password=` parameter alike
 * — and `env` carries it as `PGPASSWORD`, which libpq reads when the URL has
 * none. Spread `env` over the child's environment; it is empty when the URL
 * has no password, so an inherited `PGPASSWORD` or `.pgpass` still applies.
 */
export function libpqInvocation(url) {
  const target = new URL(libpqUrl(url));
  const password = target.password
    ? decodeURIComponent(target.password)
    : target.searchParams.get('password');
  target.password = '';
  const kept = [...target.searchParams].filter(([name]) => name !== 'password');
  return { target: withLibpqQuery(target, kept), env: password ? { PGPASSWORD: password } : {} };
}

/**
 * Runs one SQL script with psql against `url`'s database. Returns
 * `{ ok, stdout, output, sqlstate }`; `stdout` is unaligned tuples only.
 */
export function psqlRunner(url) {
  const { target, env } = libpqInvocation(url);
  return (script) => {
    const result = spawnSync(
      'psql',
      [target, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', script],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? (result.error ? String(result.error) : '');
    return {
      ok: result.status === 0,
      stdout,
      output: `${stdout}${stderr}`,
      sqlstate: result.status === 0 ? null : sqlstateFrom(stderr),
    };
  };
}

/**
 * The first line of a down.sql that must run outside a transaction (`DROP INDEX
 * CONCURRENTLY`, …). Such a file is run with plain `--file` and must be safe to
 * run again — see `downFileProblems`.
 */
export const NO_TRANSACTION_MARKER = '-- rasta:no-transaction';

const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_QUOTE_OPEN = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/**
 * Splits a SQL script into its top-level statements the way PostgreSQL's and psql's lexers see
 * it, so that nothing inside a string, an identifier, a comment or a dollar-quoted body can be
 * mistaken for code, and nothing that is code can hide in one.
 *
 *   - `'…'` strings, with `''` for a quote, and backslash escapes in an `E'…'` string only;
 *   - `"…"` identifiers, with `""` for a quote (kept verbatim: a name is part of a statement);
 *   - `$$…$$` and `$tag$…$tag$` bodies (a `$` straight after an identifier character is part of
 *     that identifier, not a quote);
 *   - block comments (opened by slash-star), which nest, and `-- …` line comments.
 *
 * Returns `statements` (trimmed, in order: a string is reduced to `''`, a dollar-quoted body to
 * `$$`, a comment to a space), `metaCommands` (every backslash met in code — psql would run it as
 * a command, outside the server's SQL altogether) and `problems` (an unterminated string,
 * identifier, comment or dollar quote). A script with a problem is never to be run.
 */
export function lexSql(sql) {
  const statements = [];
  const metaCommands = [];
  const problems = [];
  let current = '';
  let i = 0;
  let dollarEnd = -1;
  const length = sql.length;
  const flush = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = '';
  };
  const continuesIdentifier = (at) =>
    at >= 0 && at !== dollarEnd - 1 && IDENTIFIER_CHAR.test(sql[at] ?? '');

  while (i < length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      while (i < length && sql[i] !== '\n') i += 1;
      current += ' ';
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) problems.push('an unterminated /* comment');
      current += ' ';
      continue;
    }

    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !continuesIdentifier(i - 2);
      let closed = false;
      i += 1;
      while (i < length) {
        if (escapes && sql[i] === '\\') {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          closed = true;
          break;
        } else {
          i += 1;
        }
      }
      if (!closed) problems.push('an unterminated string');
      current += "''";
      continue;
    }

    if (c === '"') {
      let name = '"';
      let closed = false;
      i += 1;
      while (i < length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          name += '""';
          i += 2;
        } else if (sql[i] === '"') {
          name += '"';
          i += 1;
          closed = true;
          break;
        } else {
          name += sql[i];
          i += 1;
        }
      }
      if (!closed) problems.push('an unterminated "identifier"');
      current += name;
      continue;
    }

    if (c === '$' && !continuesIdentifier(i - 1)) {
      DOLLAR_QUOTE_OPEN.lastIndex = i;
      const open = DOLLAR_QUOTE_OPEN.exec(sql);
      if (open) {
        const end = sql.indexOf(open[0], i + open[0].length);
        if (end < 0) {
          problems.push(`an unterminated ${open[0]} quote`);
          i = length;
        } else {
          i = end + open[0].length;
        }
        dollarEnd = i;
        current += '$$';
        continue;
      }
    }

    if (c === '\\') {
      const lineStart = sql.lastIndexOf('\n', i) + 1;
      const lineEnd = sql.indexOf('\n', i);
      metaCommands.push(sql.slice(lineStart, lineEnd < 0 ? length : lineEnd).trim());
    }

    if (c === ';') {
      flush();
    } else {
      current += c;
    }
    i += 1;
  }
  flush();
  return { statements, metaCommands, problems };
}

const TRANSACTION_CONTROL =
  /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const LEDGER_DELETE = /^DELETE\s+FROM\s+"_prisma_migrations"\s+WHERE\s+"migration_name"\s*=\s*''$/i;
/** An index name, plain or quoted, with an optional schema before it. */
const INDEX_NAME = String.raw`(?:(?:[a-z_][a-z0-9_$]*|"[^"]+")\.)?(?:[a-z_][a-z0-9_$]*|"[^"]+")`;
/**
 * The only statements a no-transaction file may hold besides its one final ledger DELETE: each
 * either does nothing or finishes the job when run again.
 */
const NO_TRANSACTION_ALLOWED = [
  new RegExp(`^DROP\\s+INDEX\\s+CONCURRENTLY\\s+IF\\s+EXISTS\\s+${INDEX_NAME}$`, 'i'),
  new RegExp(
    `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY\\s+IF\\s+NOT\\s+EXISTS\\s+${INDEX_NAME}\\s+ON\\s+\\S[\\s\\S]*$`,
    'i',
  ),
];

/**
 * How a down.sql is to be run, and what is wrong with it for that mode.
 * Returns `{ mode, problems }`, `mode` being one of
 *
 *   `single-transaction` — the default: `psql --single-transaction`, the whole file
 *                          atomic, `SET LOCAL` effective, no partial rollback;
 *   `own-transaction`    — the file is itself `BEGIN; … COMMIT;` as a whole. Run with
 *                          plain `--file`: under `--single-transaction` its COMMIT would
 *                          end psql's transaction early, and a statement after it would
 *                          then run on its own;
 *   `no-transaction`     — the first line is `-- rasta:no-transaction`: for a statement
 *                          that cannot run in a transaction. Run with plain `--file`,
 *                          so it must be safe to run again.
 */
export function downFileMode(sql) {
  const lexed = lexSql(sql);
  const { statements } = lexed;
  const problems = [
    ...lexed.problems.map((problem) => `the file has ${problem}`),
    ...lexed.metaCommands.map(
      (line) => `a psql meta-command is not allowed in a down.sql: "${line.slice(0, 60)}"`,
    ),
  ];
  const control = statements.filter((statement) => TRANSACTION_CONTROL.test(statement));
  const marked = sql.split('\n', 1)[0].trim() === NO_TRANSACTION_MARKER;
  if (/rasta:no-transaction/.test(sql) && !marked) {
    problems.push(`the ${NO_TRANSACTION_MARKER} marker must be the first line of the file`);
  }

  if (marked) {
    if (control.length > 0) {
      problems.push(
        'a no-transaction file must not contain transaction control (BEGIN, COMMIT, …)',
      );
    }
    // Plain --file: a failure part-way leaves what ran, so what ran must be harmless to run again.
    // An allow-list, not a deny-list: anything not named here is refused.
    const last = statements.at(-1);
    const ledgerLast = last !== undefined && LEDGER_DELETE.test(last);
    if (!ledgerLast) {
      problems.push(
        'a no-transaction file must end with its ledger DELETE, so a failure leaves the row',
      );
    }
    for (const statement of ledgerLast ? statements.slice(0, -1) : statements) {
      if (!NO_TRANSACTION_ALLOWED.some((allowed) => allowed.test(statement))) {
        problems.push(
          `a no-transaction file may hold only DROP INDEX CONCURRENTLY IF EXISTS, ` +
            `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS and its one final ledger DELETE: ` +
            `"${statement.slice(0, 60)}" is none of them`,
        );
      }
    }
    return { mode: 'no-transaction', problems };
  }

  if (control.length === 0) return { mode: 'single-transaction', problems };

  const wrapped =
    control.length === 2 &&
    /^(BEGIN|START\s+TRANSACTION)\b/i.test(statements[0]) &&
    /^(COMMIT|END)\b/i.test(statements.at(-1));
  if (!wrapped) {
    problems.push(
      'transaction control is allowed only as one BEGIN first and one COMMIT last (the whole file), ' +
        'or not at all; a file that must run outside a transaction declares ' +
        `${NO_TRANSACTION_MARKER} on its first line`,
    );
  }
  return { mode: 'own-transaction', problems };
}

/**
 * Runs one SQL **file** the way the runbook runs a rollback by hand:
 *
 *   psql -X -v ON_ERROR_STOP=1 --single-transaction --file <down.sql>
 *
 * The whole file is one transaction: it applies completely or not at all, so a
 * down that fails on a late statement cannot leave data deleted and the ledger
 * row present, and `SET LOCAL lock_timeout` (which has no effect outside a
 * transaction) works. `-X` keeps a user's `.psqlrc` from changing ON_ERROR_STOP
 * or autocommit.
 *
 * Two kinds of file run with plain `--file` instead, decided by `downFileMode`
 * from the file itself: one that is wrapped in its own `BEGIN … COMMIT` as a
 * whole (its COMMIT would end psql's transaction early, and anything after it
 * would run on its own), and one that declares `-- rasta:no-transaction` on its
 * first line. A file that fits none of the shapes is refused, not run.
 *
 * `schema` becomes the session's `search_path`, as Prisma's `?schema=` does for
 * the commands it runs; psql has no such parameter, and an unqualified name in
 * a down would otherwise resolve against `public`. A separate `-c`, run before
 * the file in the same session, rather than `PGOPTIONS`, which a URL's own
 * `options` parameter would silently override.
 */
export function psqlFileRunner(url, schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`psqlFileRunner: "${schema}" is not a plain lowercase identifier`);
  }
  const { target, env } = libpqInvocation(url);
  return (file) => {
    const { mode, problems } = downFileMode(readFileSync(file, 'utf8'));
    if (problems.length > 0) {
      return {
        ok: false,
        output: `${file}: not a runnable down.sql:\n  ${problems.join('\n  ')}\n`,
      };
    }
    const result = spawnSync(
      'psql',
      [
        target,
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        ...(mode === 'single-transaction' ? ['--single-transaction'] : []),
        '-c',
        `SET search_path TO "${schema}"`,
        '--file',
        file,
      ],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    const stderr = result.stderr ?? (result.error ? String(result.error) : '');
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${stderr}`, mode };
  };
}

/** SQLSTATE 55006 — `object_in_use`: another backend is still in the database after PostgreSQL's own wait. */
const OBJECT_IN_USE = '55006';

/**
 * Creates this run's scratch database and marks it. `run(sql)` executes
 * against a database other than the new one (see `psqlRunner`). If the mark
 * fails, the database this call has just created is dropped again — it is the
 * one case where provenance is certain without the marker — and the result of
 * that cleanup is reported with the failure, never ignored.
 */
export function createScratchDatabase(run, scratch) {
  const sql = scratchDatabaseSql(scratch);
  const created = run(sql.create);
  if (!created.ok) return { ok: false, output: created.output };
  const marked = run(sql.mark);
  if (!marked.ok) {
    const cleaned = run(sql.drop);
    return {
      ok: false,
      output:
        `marking ${scratch.name} failed:\n${marked.output}` +
        (cleaned.ok
          ? `\n(the unmarked database was dropped again)`
          : `\nand dropping the unmarked database failed too — remove ${scratch.name} by hand:\n${cleaned.output}`),
    };
  }
  return { ok: true, output: '' };
}

/**
 * Drops this run's scratch database: `inspect`, and only if it carries this
 * run's marker, `prepare` and `drop` — retrying the drop while another backend
 * is still leaving, decided on SQLSTATE 55006 alone. Returns `{ ok, refused,
 * output, attempts }` and never throws, so a caller's cleanup path can report
 * and carry on. An absent database is `ok` with 0 attempts.
 */
export function dropScratchDatabase(
  run,
  scratch,
  { attempts = 3, pauseMs = 1000, pause = sleepSync } = {},
) {
  const sql = scratchDatabaseSql(scratch);
  const inspected = run(sql.inspect);
  if (!inspected.ok) return { ok: false, refused: false, output: inspected.output, attempts: 0 };
  const state = inspected.stdout.trim();
  if (state === 'absent') return { ok: true, refused: false, output: '', attempts: 0 };
  if (state !== 'marked') {
    return {
      ok: false,
      refused: true,
      output: `refusing to drop "${scratch.name}": ${state.replace(/^refuse:/, '')}`,
      attempts: 0,
    };
  }
  const prepared = run(sql.prepare);
  if (!prepared.ok) return { ok: false, refused: false, output: prepared.output, attempts: 0 };
  let last = { ok: false, output: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = run(sql.drop);
    if (last.ok) return { ok: true, refused: false, output: last.output, attempts: attempt };
    if (last.sqlstate !== OBJECT_IN_USE) {
      return { ok: false, refused: false, output: last.output, attempts: attempt };
    }
    if (attempt < attempts) pause(pauseMs);
  }
  return { ok: false, refused: false, output: last.output, attempts };
}

/**
 * Marked scratch databases older than `maxAgeMs` — a crashed run's leftovers.
 * Read-only: they are reported for a person to remove, never dropped here,
 * since nothing proves the run that made them has finished.
 */
export function staleScratchDatabases(
  run,
  { now = new Date(), maxAgeMs = 24 * 60 * 60 * 1000 } = {},
) {
  const listed = run(`SELECT datname || ' ' || coalesce(shobj_description(oid, 'pg_database'), '')
  FROM pg_database WHERE datname LIKE 'rasta\\_scratch\\_%' ORDER BY datname;`);
  if (!listed.ok) return [];
  const stale = [];
  for (const line of listed.stdout.split('\n')) {
    const [name, marker] = line.trim().split(' ');
    const match = MARKER.exec(marker ?? '');
    if (!name || !match) continue;
    const createdAt = new Date(match[3]);
    if (now.getTime() - createdAt.getTime() > maxAgeMs) stale.push({ name, createdAt: match[3] });
  }
  return stale;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
