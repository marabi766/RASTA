import { isDeepStrictEqual } from 'node:util';

// Counts and money stay decimal strings: PostgreSQL count/SUM can exceed JS's safe integer.
function count(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid count');
  return BigInt(value);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
    throw new Error('Missing table inventory');
  }
  const tables = Object.entries(snapshot.tables);
  if (!tables.length) throw new Error('Empty table inventory');
  for (const [, rows] of tables) count(rows);
  if (!Array.isArray(snapshot.migrations) || !snapshot.migrations.length) {
    throw new Error('Missing migration ledger');
  }
  for (const row of snapshot.migrations) {
    if (!row.migration_name || !row.checksum || !row.finished_at || row.rolled_back_at !== null) {
      throw new Error('Incomplete migration');
    }
  }
}

/** A missing table or ledger, changed row count, or any changed migration field is a failure. */
export function compareSnapshots(source, restored) {
  validateSnapshot(source);
  validateSnapshot(restored);
  return {
    tablesEqual: isDeepStrictEqual(source.tables, restored.tables),
    migrationsEqual: isDeepStrictEqual(source.migrations, restored.migrations),
  };
}

/** Missing coverage is a failure: the drill always installs its synthetic postings fixture. */
export function ledgerPassed(ledger) {
  if (!ledger) throw new Error('Missing ledger result');
  return (
    count(ledger.journalsChecked) > 0n &&
    count(ledger.walletsChecked) > 0n &&
    count(ledger.entriesChecked) > 0n &&
    count(ledger.journalMismatches) === 0n &&
    count(ledger.walletMismatches) === 0n
  );
}

// All non-system tables, across schemas (including extension tables, audit and _prisma_migrations).
// format(%I) quotes catalog identifiers; no operator-supplied SQL is interpolated.
export const INVENTORY_SQL = `
SELECT format('SELECT %L AS name, count(*)::text AS rows FROM %I.%I',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname
\\gexec
`;

export const MIGRATIONS_SQL = (schema) => `
SELECT coalesce(json_agg(row_to_json(m) ORDER BY migration_name, id), '[]'::json)
FROM "${schema}"._prisma_migrations m;
`;

// Reuses the invariant, without importing service code:
// services/economic-service/src/wallet/wallet.repository.ts:115-139 (credits minus debits,
// WALLET = available, ESCROW = pending, sum = ledger), and balance-audit.ts:235-273.
// Journal sums follow services/economic-service/prisma/migrations/
// 20260828202043_init_economic/migration.sql:596-627 (per journal AND currency).
// numeric SUM avoids bigint overflow; only counts leave this read-only query.
export const LEDGER_SQL = `
WITH bad_journals AS (
  SELECT j.id FROM public.journal j LEFT JOIN public.ledger_entry e ON e.journal_id = j.id
  GROUP BY j.id
  HAVING count(e.id) < 2 OR EXISTS (
    SELECT 1 FROM public.ledger_entry entry WHERE entry.journal_id = j.id
    GROUP BY entry.currency
    HAVING sum(CASE WHEN entry.direction = 'DEBIT' THEN entry.amount_minor::numeric
                    ELSE -entry.amount_minor::numeric END) <> 0
  )
), balances AS (
  SELECT a.id, a.organization_id, a.currency, a.purpose, a.account_type,
    coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor::numeric
                      ELSE -e.amount_minor::numeric END), 0) AS balance
  FROM public.ledger_account a LEFT JOIN public.ledger_entry e ON e.account_id = a.id
  GROUP BY a.id
), bad_wallets AS (
  SELECT w.id FROM public.wallet w
  LEFT JOIN balances a ON a.id = w.ledger_account_id
  LEFT JOIN balances escrow ON escrow.organization_id = w.organization_id
    AND escrow.currency = w.currency AND escrow.purpose = 'ESCROW'
  WHERE a.id IS NULL OR a.purpose <> 'WALLET' OR a.account_type <> 'LIABILITY'
    OR a.organization_id <> w.organization_id OR a.currency <> w.currency
    OR w.available_balance_minor <> a.balance
    OR w.pending_balance_minor <> coalesce(escrow.balance, 0)
    OR w.ledger_balance_minor::numeric <> a.balance + coalesce(escrow.balance, 0)
    OR w.available_balance_minor < 0 OR w.pending_balance_minor < 0 OR w.ledger_balance_minor < 0
    OR w.pending_balance_minor <> (SELECT coalesce(sum(h.amount_minor::numeric), 0)
        FROM public.wallet_hold h WHERE h.wallet_id = w.id AND h.status = 'ACTIVE')
)
SELECT json_build_object(
  'journalsChecked', (SELECT count(*)::text FROM public.journal),
  'entriesChecked', (SELECT count(*)::text FROM public.ledger_entry),
  'walletsChecked', (SELECT count(*)::text FROM public.wallet),
  'journalMismatches', (SELECT count(*)::text FROM bad_journals),
  'walletMismatches', (SELECT count(*)::text FROM bad_wallets));
`;

// The dev seed intentionally has no wallets/postings (economic prisma/seed.ts:30).
// Synthetic backup-test data ONLY, in a fresh owned cluster: no provider, rate, event or API.
// Like test/helpers.ts:324-350, a wallet balance must be justified by postings.
// The amount exceeds Number.MAX_SAFE_INTEGER to exercise exact restore/comparison.
export const FIXTURE_SQL = `
BEGIN;
INSERT INTO public.ledger_account
 (id, organization_id, account_type, account_code, purpose, currency, created_by)
VALUES ('ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'LIABILITY', 'DRILL-WALLET', 'WALLET', 'IRR', 'restore-drill'),
 ('ACC_DRILL_ESCROW', 'ORG-RESTORE-DRILL', 'LIABILITY', 'DRILL-ESCROW', 'ESCROW', 'IRR', 'restore-drill');
INSERT INTO public.journal
 (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
VALUES ('JRN_DRILL_TOPUP', 'ORG-RESTORE-DRILL', 'WALLET_TOP_UP', 'Synthetic restore fixture', now(), 'restore-drill', 'restore-drill'),
 ('JRN_DRILL_HOLD', 'ORG-RESTORE-DRILL', 'FUNDS_HELD', 'Synthetic restore hold', now(), 'restore-drill', 'restore-drill');
INSERT INTO public.ledger_entry
 (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
VALUES
 ('LGE_DRILL_DEBIT', 'JRN_DRILL_TOPUP', 'ACC_SEED_PAYMENT_CLEARING', 'ORG-PLATFORM', 'DEBIT', 9007199254740993, 'IRR', now()),
 ('LGE_DRILL_CREDIT', 'JRN_DRILL_TOPUP', 'ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'CREDIT', 9007199254740993, 'IRR', now()),
 ('LGE_DRILL_HOLD_DEBIT', 'JRN_DRILL_HOLD', 'ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'DEBIT', 2500, 'IRR', now()),
 ('LGE_DRILL_HOLD_CREDIT', 'JRN_DRILL_HOLD', 'ACC_DRILL_ESCROW', 'ORG-RESTORE-DRILL', 'CREDIT', 2500, 'IRR', now());
INSERT INTO public.wallet
 (id, organization_id, currency, ledger_account_id, ledger_balance_minor, available_balance_minor, pending_balance_minor, updated_at)
VALUES ('WLT_DRILL', 'ORG-RESTORE-DRILL', 'IRR', 'ACC_DRILL_WALLET', 9007199254740993, 9007199254738493, 2500, now());
INSERT INTO public.wallet_hold
 (id, organization_id, wallet_id, amount_minor, currency, reference, reference_type, placed_journal_id, placed_at, placed_by)
VALUES ('HLD_DRILL', 'ORG-RESTORE-DRILL', 'WLT_DRILL', 2500, 'IRR', 'DRILL', 'RESTORE_TEST', 'JRN_DRILL_HOLD', now(), 'restore-drill');
COMMIT;
`;
