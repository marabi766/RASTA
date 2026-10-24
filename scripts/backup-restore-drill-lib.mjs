import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Row counts and money stay decimal strings: PostgreSQL count/SUM can exceed JS's safe integer.
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
  for (const [, table] of tables) {
    count(table.rows);
    if (
      !['application', 'migration', 'extension'].includes(table.kind) ||
      !/^[a-f0-9]{32}$/.test(table.digest)
    )
      throw new Error('Invalid table evidence');
  }
  const state = snapshot.databaseState;
  if (!state?.owner || !Object.hasOwn(state, 'acl') || !Array.isArray(state.settings)) {
    throw new Error('Missing database state');
  }
  const objects = snapshot.objectState;
  if (
    !objects ||
    !Array.isArray(objects.schemas) ||
    !objects.schemas.length ||
    !Array.isArray(objects.relations) ||
    !objects.relations.length ||
    !Array.isArray(objects.defaultPrivileges) ||
    !Array.isArray(objects.sequences)
  ) {
    throw new Error('Missing object state');
  }
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
    databaseStateEqual: isDeepStrictEqual(source.databaseState, restored.databaseState),
    objectStateEqual: isDeepStrictEqual(source.objectState, restored.objectState),
  };
}

/** Missing coverage is a failure: the drill always installs its synthetic postings fixture. */
export function ledgerPassed(ledger) {
  if (
    !ledger ||
    !Array.isArray(ledger.amountsByCurrency) ||
    !ledger.amountsByCurrency.length ||
    ledger.fixtureAmount !== '9007199254740993'
  )
    throw new Error('Missing ledger amounts');
  for (const row of ledger.amountsByCurrency) {
    if (!row.currency) throw new Error('Missing currency');
    count(row.total);
  }
  return (
    count(ledger.journalsChecked) > 0n &&
    count(ledger.walletsChecked) > 0n &&
    count(ledger.entriesChecked) > 0n &&
    count(ledger.journalMismatches) === 0n &&
    count(ledger.walletMismatches) === 0n
  );
}

export function compareLedgers(source, restored) {
  return ledgerPassed(source) && ledgerPassed(restored) && isDeepStrictEqual(source, restored);
}

/** The same acceptance gate is exercised by the SQL drift tests and the operator command. */
export function drillPassed(databases, expectedCount, sourceLedger, restoredLedger) {
  return (
    expectedCount > 0 &&
    databases.length === expectedCount &&
    databases.every(
      (db) => db.tablesEqual && db.migrationsEqual && db.databaseStateEqual && db.objectStateEqual,
    ) &&
    compareLedgers(sourceLedger, restoredLedger)
  );
}

// Explicit exclusions are bootstrap infrastructure, never service databases.
export const EXCLUDED_DATABASES = {
  keycloak: 'identity-provider storage; outside logical service drill',
  temporal: 'workflow engine storage; outside logical service drill',
  temporal_visibility: 'workflow visibility storage; outside logical service drill',
};
export const DATABASES_SQL = `SELECT coalesce(json_agg(datname ORDER BY datname), '[]'::json)
FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres';`;

export function checkDatabaseCoverage(actual, expected) {
  if (
    !Array.isArray(actual) ||
    !actual.length ||
    !expected.length ||
    new Set(actual).size !== actual.length ||
    !isDeepStrictEqual(
      actual.filter((db) => !Object.hasOwn(EXCLUDED_DATABASES, db)).sort(),
      [...expected].sort(),
    )
  )
    throw new Error('Database coverage mismatch');
}

/** Schema files are independent of bootstrap's RASTA_SERVICES; discovery fails closed. */
export function discoverSchemaServices(root) {
  const services = readdirSync(join(root, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-service'))
    .filter((entry) => readdirSync(join(root, 'services', entry.name)).includes('prisma'))
    .map((entry) => {
      const schema = readFileSync(
        join(root, 'services', entry.name, 'prisma/schema.prisma'),
        'utf8',
      );
      if (!schema.trim()) throw new Error(`Empty schema: ${entry.name}`);
      return entry.name.slice(0, -'-service'.length).replaceAll('-', '_');
    })
    .sort();
  if (!services.length) throw new Error('Empty schema discovery');
  return services;
}

export function checkServiceCoverage(discovered, configured) {
  const missing = discovered.filter((name) => !configured.includes(name));
  const extra = configured.filter((name) => !discovered.includes(name));
  if (
    !discovered.length ||
    !configured.length ||
    missing.length ||
    extra.length ||
    new Set(configured).size !== configured.length
  ) {
    throw new Error(
      `Service coverage mismatch: missing from RASTA_SERVICES [${missing}]; absent schemas [${extra}]`,
    );
  }
}

// Use role names, never cluster-local OIDs. ACL text and all arrays use C ordering.
export const OBJECT_STATE_SQL = `
WITH namespaces AS (
  SELECT * FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
), relations AS (
  SELECT c.*, n.nspname FROM pg_class c JOIN namespaces n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
)
SELECT json_build_object(
  'schemas', (SELECT coalesce(json_agg(json_build_object('name', nspname,
    'owner', pg_get_userbyid(nspowner)) ORDER BY nspname COLLATE "C"), '[]'::json) FROM namespaces),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', nspname || '.' || relname,
    'kind', relkind, 'owner', pg_get_userbyid(relowner),
    'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(relacl) a))
    ORDER BY nspname COLLATE "C", relname COLLATE "C"), '[]'::json) FROM relations),
  'defaultPrivileges', (SELECT coalesce(json_agg(json_build_object(
    'role', pg_get_userbyid(d.defaclrole), 'schema', coalesce(n.nspname, '*'),
    'kind', d.defaclobjtype,
    'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(d.defaclacl) a))
    ORDER BY pg_get_userbyid(d.defaclrole) COLLATE "C", coalesce(n.nspname, '*') COLLATE "C", d.defaclobjtype),
    '[]'::json) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace));
`;

// Read every sequence directly; pg_sequences alone does not expose is_called.
export const SEQUENCES_SQL = `
SELECT format('SELECT json_build_object(''name'', %L, ''last_value'', last_value::text,
  ''is_called'', is_called) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
\\gexec
`;

export const DATABASE_STATE_SQL = `
SELECT json_build_object('owner', pg_get_userbyid(d.datdba),
  'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(d.datacl) a),
  'settings', coalesce((SELECT json_agg(json_build_object(
    'role', CASE WHEN s.setrole = 0 THEN '*' ELSE pg_get_userbyid(s.setrole) END,
    'config', (SELECT json_agg(v ORDER BY v COLLATE "C") FROM unnest(s.setconfig) v))
    ORDER BY s.setrole = 0 DESC, pg_get_userbyid(s.setrole) COLLATE "C")
    FROM pg_db_role_setting s WHERE s.setdatabase = d.oid), '[]'::json))
FROM pg_database d WHERE d.datname = current_database();
`;

export function summarizeTables(tables) {
  const summary = {};
  for (const kind of ['application', 'migration', 'extension']) {
    const selected = Object.values(tables).filter((table) => table.kind === kind);
    summary[kind] = {
      tables: selected.length,
      nonEmptyTables: selected.filter((table) => count(table.rows) > 0n).length,
      rows: selected.reduce((total, table) => total + count(table.rows), 0n).toString(),
    };
  }
  return summary;
}

// All non-system tables, across schemas (including extension tables, audit and _prisma_migrations).
// format(%I) quotes catalog identifiers; no operator-supplied SQL is interpolated.
export const INVENTORY_SQL = `
SELECT format('SELECT json_build_object(''name'', %L, ''rows'', count(*)::text,
  ''kind'', %L, ''digest'', md5(coalesce(string_agg(row_to_json(t)::text, E''\\n''
  ORDER BY row_to_json(t)::text COLLATE "C"), ''''))) FROM %I.%I t',
  n.nspname || '.' || c.relname,
  CASE WHEN EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
    AND d.objid = c.oid AND d.deptype = 'e') THEN 'extension'
    WHEN c.relname = '_prisma_migrations' THEN 'migration' ELSE 'application' END,
  n.nspname, c.relname)
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
// numeric SUM avoids bigint overflow; counts and amounts leave PostgreSQL as text.
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
  'walletMismatches', (SELECT count(*)::text FROM bad_wallets),
  'amountsByCurrency', (SELECT json_agg(t ORDER BY currency) FROM
    (SELECT currency, sum(amount_minor::numeric)::text AS total FROM public.ledger_entry
     GROUP BY currency) t),
  'fixtureAmount', (SELECT amount_minor::text FROM public.ledger_entry WHERE id = 'LGE_DRILL_CREDIT'));
`;

// The dev seed intentionally has no wallets/postings (economic prisma/seed.ts:30).
// Synthetic backup-test data ONLY, in a fresh owned cluster: no provider, rate, event or API.
// Like test/helpers.ts:324-350, a wallet balance must be justified by postings.
// The fixture amount is compared as text, alongside table digests and per-currency sums.
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
