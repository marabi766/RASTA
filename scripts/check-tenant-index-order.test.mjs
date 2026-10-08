import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPTIONS,
  SERVICES,
  TABLE_EXEMPTIONS,
  TABLE_FINDINGS_PENDING,
  checkTenantIndexOrder,
  checkTenantLeadingIndex,
  readMigrationTexts,
  replayMigrations,
  stripNonDdl,
} from './check-tenant-index-order-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsOf = (service) =>
  readMigrationTexts(join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations'));

const TENANT_TABLE = `CREATE TABLE "t" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "parent_id" TEXT,
  CONSTRAINT "t_pkey" PRIMARY KEY ("id")
);`;

const check = (sql, exemptions = {}) => checkTenantIndexOrder(replayMigrations([sql]), exemptions);

for (const service of SERVICES) {
  test(`${service}-service: every composite tenant index leads with organization_id or is exempted`, () => {
    const { errors, checked } = checkTenantIndexOrder(
      replayMigrations(migrationsOf(service)),
      EXEMPTIONS[service] ?? {},
    );
    assert.deepEqual(errors, []);
    assert.ok(checked > 0, 'an empty check proves nothing');
  });
}

// The four keys L7-44 found, each as it stood before its fix migration. If the
// fix migration is removed, reverted or reordered, these come back.
test('the pre-fix notification and document keys are refused', () => {
  const withoutFix = (service, fix) =>
    replayMigrations(
      readMigrationTexts(
        join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations'),
      ).filter((text) => !text.includes(fix)),
    );
  const notification = checkTenantIndexOrder(
    withoutFix('notification', 'L7-44'),
    EXEMPTIONS.notification,
  );
  assert.deepEqual(notification.errors.map((error) => error.split(':')[0]).sort(), [
    'notification_quiet_hours_pkey',
    'ux_preference_global_channel',
    'ux_preference_owner_scope_channel',
  ]);
  const document = checkTenantIndexOrder(withoutFix('document', 'L7-44'), EXEMPTIONS.document);
  assert.deepEqual(
    document.errors.map((error) => error.split(':')[0]),
    ['ix_document_owner_resource'],
  );
});

test('the fixes keep what each key refuses, and drop only exact prefixes', () => {
  const { indexes } = replayMigrations(migrationsOf('notification'));
  assert.deepEqual(indexes.get('ux_preference_owner_scope_channel').columns, [
    'organization_id',
    'user_id',
    'scope',
    'scope_key',
    'channel',
  ]);
  assert.deepEqual(indexes.get('ux_preference_global_channel').columns, [
    'organization_id',
    'user_id',
    'channel',
  ]);
  assert.deepEqual(indexes.get('notification_quiet_hours_pkey').columns, [
    'organization_id',
    'user_id',
  ]);
  assert.equal(indexes.has('ix_preference_owner'), false);
  assert.equal(indexes.has('ix_quiet_hours_org'), false);

  const document = replayMigrations(migrationsOf('document')).indexes;
  assert.equal(document.has('ix_document_owner_resource'), false);
  assert.deepEqual(document.get('ix_document_org_owner_resource').columns, [
    'organization_id',
    'owner_resource_type',
    'owner_resource_id',
  ]);
});

test('a key adopted with ADD CONSTRAINT ... USING INDEX takes the prebuilt index and its columns', () => {
  const { indexes } = replayMigrations([
    `CREATE TABLE "t" ("organization_id" TEXT, "user_id" TEXT, CONSTRAINT "t_pkey" PRIMARY KEY ("user_id", "organization_id"));
     CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "t_pkey_next" ON "t" ("organization_id", "user_id");`,
    `ALTER TABLE "t" DROP CONSTRAINT "t_pkey";
     ALTER TABLE "t" ADD CONSTRAINT "t_pkey" PRIMARY KEY USING INDEX "t_pkey_next";`,
  ]);
  assert.equal(indexes.has('t_pkey_next'), false);
  assert.deepEqual(indexes.get('t_pkey'), {
    table: 't',
    columns: ['organization_id', 'user_id'],
    unique: true,
    kind: 'primary key',
  });
});

test('refuses a composite index, unique index, primary key and unique constraint that lead elsewhere', () => {
  const { errors, checked } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "organization_id");
    CREATE UNIQUE INDEX "ux_b" ON "t" ("parent_id", "user_id") WHERE "parent_id" IS NOT NULL;
    ALTER TABLE "t" ADD CONSTRAINT "uq_c" UNIQUE ("user_id", "parent_id");
    CREATE TABLE "u" ("organization_id" TEXT, "k" TEXT, PRIMARY KEY ("k", "organization_id"));`);
  assert.equal(checked, 4);
  assert.deepEqual(
    errors.map((error) => error.split(':')[0]),
    ['ix_a', 'u_pkey', 'uq_c', 'ux_b'],
  );
});

test('accepts organization-leading and single-column indexes, and ignores non-tenant tables', () => {
  const { errors, checked } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("organization_id", "user_id" DESC);
    CREATE INDEX "ix_b" ON "t"("parent_id");
    CREATE TABLE "plain" ("a" TEXT, "b" TEXT);
    CREATE INDEX "ix_plain" ON "plain"("a", "b");`);
  assert.deepEqual(errors, []);
  assert.equal(checked, 1);
});

test('a column added later makes a table tenant-owned', () => {
  const { errors } = check(`CREATE TABLE "t" ("id" TEXT, "user_id" TEXT);
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    ALTER TABLE "t" ADD COLUMN "organization_id" TEXT;`);
  assert.equal(errors.length, 1);
});

test('follows DROP INDEX, DROP CONSTRAINT, ALTER INDEX RENAME and DROP TABLE', () => {
  const { errors } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    DROP INDEX "ix_a";
    CREATE INDEX "ix_b" ON "t"("user_id", "id");
    ALTER INDEX "ix_b" RENAME TO "ix_c";
    ALTER TABLE "t" ADD CONSTRAINT "uq_d" UNIQUE ("user_id", "id");
    ALTER TABLE "t" DROP CONSTRAINT "uq_d";
    CREATE TABLE "gone" ("organization_id" TEXT, "k" TEXT);
    CREATE INDEX "ix_gone" ON "gone"("k", "organization_id");
    DROP TABLE "gone";`);
  assert.deepEqual(
    errors.map((error) => error.split(':')[0]),
    ['ix_c'],
  );
});

test('an exemption silences exactly its index; a stale or needless one is an error', () => {
  const sql = `${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    CREATE INDEX "ix_ok" ON "t"("organization_id", "id");
    CREATE INDEX "ix_single" ON "t"("user_id");`;
  const ex = (index) => ({ index, reason: 'r' });
  assert.deepEqual(check(sql, { ix_a: ex('t (user_id, id)') }).errors, []);
  const stale = check(sql, {
    ix_a: ex('t (user_id, id)'),
    ix_missing: ex('t (x)'),
    ix_ok: ex('t (organization_id, id)'),
    ix_single: ex('t (user_id)'),
  }).errors;
  assert.equal(stale.length, 3);
  assert.match(
    stale.find((e) => e.startsWith('ix_missing')),
    /no such index/,
  );
  assert.match(
    stale.find((e) => e.startsWith('ix_ok')),
    /already leads/,
  );
  assert.match(
    stale.find((e) => e.startsWith('ix_single')),
    /not composite/,
  );
});

test('the outbox is plumbing and is not judged', () => {
  const { errors, checked } =
    check(`CREATE TABLE "outbox_message" ("id" TEXT, "organization_id" TEXT, "created_at" TIMESTAMP);
    CREATE INDEX "ix_outbox_claimable" ON "outbox_message"("created_at", "id");`);
  assert.deepEqual(errors, []);
  assert.equal(checked, 0);
});

test('DDL inside comments, strings and function bodies is not DDL', () => {
  const sql = `${TENANT_TABLE}
    -- CREATE INDEX "ix_comment" ON "t"("user_id", "id");
    /* CREATE INDEX "ix_block" ON "t"("user_id", "id"); */
    DO $body$ BEGIN EXECUTE 'CREATE INDEX "ix_dyn" ON "t"("user_id", "id")'; END $body$;
    SELECT 'CREATE INDEX "ix_str" ON "t"(''user_id'', "id")';`;
  assert.deepEqual(check(sql).errors, []);
  assert.doesNotMatch(stripNonDdl(sql), /ix_comment|ix_block|ix_dyn|ix_str/);
});

test('reads unquoted identifiers, schema-qualified names and expression keys', () => {
  const { indexes } = replayMigrations([
    `CREATE TABLE public.audit_x (organization_id varchar, occurred_at timestamptz, id text,
       PRIMARY KEY (occurred_at, id)) PARTITION BY RANGE (occurred_at);
     CREATE INDEX audit_x_org_idx ON public.audit_x (organization_id, occurred_at DESC);
     CREATE INDEX ix_expr ON audit_x ((lower(id)), organization_id);`,
  ]);
  assert.deepEqual(indexes.get('audit_x_pkey').columns, ['occurred_at', 'id']);
  assert.deepEqual(indexes.get('audit_x_org_idx').columns, ['organization_id', 'occurred_at']);
  assert.equal(indexes.get('ix_expr').columns[0], '((lower(id)))');
});

// L7-44, economic-service: every report classified as a legitimate exemption
// (none needed a fix migration). Without the exemptions the check reports
// exactly these twelve, so each one is load-bearing.
const ECONOMIC_EXEMPT = [
  'commission_rule_transaction_type_status_valid_from_idx',
  'ix_payment_intent_unfinished_refund',
  'ix_payment_reconciliation_open_window',
  'ledger_entry_account_id_posted_at_idx',
  'reward_level_status_min_points_idx',
  'reward_rule_id_source_reference_key',
  'reward_rule_trigger_event_status_valid_from_idx',
  'settlement_payee_organization_id_settled_at_idx',
  'transaction_counterparty_organization_id_status_idx',
  'transaction_leg_transaction_id_role_key',
  'uq_ledger_account_identity',
  'uq_wallet_hold_active_reference',
];

test('economic-service: without its exemptions exactly the classified indexes are reported', () => {
  const { errors } = checkTenantIndexOrder(replayMigrations(migrationsOf('economic')), {});
  assert.deepEqual(errors.map((error) => error.split(':')[0]).sort(), [...ECONOMIC_EXEMPT].sort());
  assert.deepEqual(Object.keys(EXEMPTIONS.economic).sort(), [...ECONOMIC_EXEMPT].sort());
});

test('every economic exemption says which query or invariant it serves', () => {
  for (const name of ECONOMIC_EXEMPT) {
    const { reason } = EXEMPTIONS.economic[name];
    assert.ok(typeof reason === 'string' && reason.length > 60, name);
    // A named query (Class.method) or the invariant or foreign key it enforces.
    assert.match(reason, /[A-Z][A-Za-z]+\.[a-z][A-Za-z]+|invariant|foreign key|_fkey/, name);
  }
});

// L7-44, the four services opted in by this change: every report classified as
// a legitimate exemption (none needed a fix migration). Without the exemptions
// the check reports exactly these twelve, so each one is load-bearing.
const OPTED_IN = {
  fleet: ['asset_transfer_release_pkey'],
  identity: [
    'ix_security_event_outbox_claimable',
    'ix_security_event_outbox_closed_windows',
    'membership_user_id_status_idx',
  ],
  maintenance: ['asset_transfer_release_pkey', 'ux_request_open_per_asset'],
  marketplace: [
    'ix_offer_product_status',
    'ix_offer_status_price',
    'ix_order_history_order',
    'ix_order_supplier_status',
    'uq_offer_price_version',
    'uq_order_line_offer',
  ],
};

test('fleet, identity, maintenance and marketplace: without their exemptions exactly the classified indexes are reported', () => {
  for (const [service, names] of Object.entries(OPTED_IN)) {
    const { errors } = checkTenantIndexOrder(replayMigrations(migrationsOf(service)), {});
    assert.deepEqual(errors.map((error) => error.split(':')[0]).sort(), [...names].sort(), service);
    assert.deepEqual(Object.keys(EXEMPTIONS[service]).sort(), [...names].sort(), service);
  }
});

test('every exemption in those four services says which query or invariant it serves', () => {
  for (const [service, names] of Object.entries(OPTED_IN)) {
    for (const name of names) {
      const { reason } = EXEMPTIONS[service][name];
      assert.ok(typeof reason === 'string' && reason.length > 60, `${service}.${name}`);
      // A named query (Class.method) or the invariant the index enforces.
      assert.match(
        reason,
        /[A-Z][A-Za-z]+\.[a-z][A-Za-z]+|invariant|ON CONFLICT|foreign key|_fkey/,
        `${service}.${name}`,
      );
    }
  }
});

test('an inherited property is never an exemption (Codex on #217)', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const sql = `${TENANT_TABLE}\n    CREATE INDEX "${name}" ON "t"("user_id", "id");`;
    const { errors } = check(sql, {});
    assert.equal(errors.length, 1, name);
    assert.match(errors[0], /must lead with organization_id/, name);
  }
});

test('an exemption is bound to its definition: the same name on other columns is refused', () => {
  const sql = `${TENANT_TABLE}\n    CREATE INDEX "ix_a" ON "t"("user_id", "parent_id");`;
  const { errors } = check(sql, {
    ix_a: { index: 't (user_id, id)', reason: 'was on (user_id, id)' },
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /exempted as t \(user_id, id\), but the index is t \(user_id, parent_id\)/,
  );
});

test('an exemption without { index, reason } fails closed', () => {
  const sql = `${TENANT_TABLE}\n    CREATE INDEX "ix_a" ON "t"("user_id", "id");`;
  for (const exemption of [
    'a bare reason',
    { index: 't (user_id, id)' },
    { index: 't (user_id, id)', reason: ' ' },
    null,
  ]) {
    assert.match(check(sql, { ix_a: exemption }).errors[0], /must be \{ index, reason \}/);
  }
});

test('every committed exemption names the definition of the index it exempts', () => {
  for (const service of SERVICES) {
    for (const [name, exemption] of Object.entries(EXEMPTIONS[service] ?? {})) {
      assert.match(exemption.index, /^[a-z_]+ \([a-z_]+(, [a-z_]+)+\)$/, `${service}.${name}`);
      assert.ok(exemption.reason.length > 20, `${service}.${name}`);
    }
  }
});

// #218 r1: a tenant table with no index leading with organization_id at all —
// the composite check above never looks at it, because its only keys are
// single-column or not there.
const leadingCheck = (sql, tableExemptions = {}, pending = []) =>
  checkTenantLeadingIndex(replayMigrations([sql]), tableExemptions, undefined, pending);

test('refuses a tenant table whose only indexes do not lead with organization_id', () => {
  const { errors, checked } = leadingCheck(
    `${TENANT_TABLE} CREATE UNIQUE INDEX "ux_t_parent" ON "t" ("parent_id") WHERE "parent_id" IS NOT NULL;`,
  );
  assert.equal(checked, 1);
  assert.deepEqual(errors, [
    't: tenant table with no index leading with organization_id; add one, or exempt the table with its reason',
  ]);
});

test('accepts any index that leads with organization_id, a single-column one included', () => {
  for (const index of [
    'CREATE INDEX "ix_t_org" ON "t" ("organization_id");',
    'CREATE INDEX "ix_t_org_user" ON "t" ("organization_id", "user_id");',
    'ALTER TABLE "t" ADD CONSTRAINT "t_org_key" UNIQUE ("organization_id", "id");',
  ]) {
    assert.deepEqual(leadingCheck(`${TENANT_TABLE} ${index}`).errors, [], index);
  }
});

test('judges the final state: an index dropped later no longer counts', () => {
  const { errors } = leadingCheck(
    `${TENANT_TABLE} CREATE INDEX "ix_t_org" ON "t" ("organization_id"); DROP INDEX "ix_t_org";`,
  );
  assert.equal(errors.length, 1);
});

test('ignores tables without organization_id and the outbox', () => {
  const { errors, checked } = leadingCheck(
    `CREATE TABLE "plain" ("id" TEXT, CONSTRAINT "plain_pkey" PRIMARY KEY ("id"));
     CREATE TABLE "outbox_message" ("id" TEXT, "organization_id" TEXT, CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id"));`,
  );
  assert.deepEqual(errors, []);
  assert.equal(checked, 0);
});

test('a table exemption needs a reason, and goes stale once the table complies or is gone', () => {
  assert.deepEqual(
    leadingCheck(TENANT_TABLE, { t: 'read only by id, never by tenant' }).errors,
    [],
  );
  assert.deepEqual(leadingCheck(TENANT_TABLE, { t: '  ' }).errors, [
    't: its table exemption must be a reason',
  ]);
  assert.match(
    leadingCheck(`${TENANT_TABLE} CREATE INDEX "ix" ON "t" ("organization_id");`, { t: 'why' })
      .errors[0],
    /remove its table exemption/,
  );
  assert.match(leadingCheck(TENANT_TABLE, { t: 'why', gone: 'why' }).errors[0], /no such table/);
  assert.match(
    leadingCheck(`CREATE TABLE "p" ("id" TEXT);`, { p: 'why' }).errors[0],
    /not a tenant table/,
  );
});

test('a pending finding is reported, not failed — and is an error once it no longer fires', () => {
  const pending = leadingCheck(TENANT_TABLE, {}, ['t']);
  assert.deepEqual(pending.errors, []);
  assert.equal(pending.notes.length, 1);
  assert.match(
    leadingCheck(`${TENANT_TABLE} CREATE INDEX "ix" ON "t" ("organization_id");`, {}, ['t'])
      .errors[0],
    /remove it from TABLE_FINDINGS_PENDING/,
  );
  assert.match(leadingCheck(TENANT_TABLE, {}, ['t', 'nope']).errors[0], /not a tenant table here/);
  assert.match(
    leadingCheck(TENANT_TABLE, { t: 'why' }, ['t']).errors[0],
    /both pending and table-exempted/,
  );
});

test('economic-service: payment_reconciliation_resolution was the one table without a tenant-leading index, and its fix migration closes it', () => {
  const sql = migrationsOf('economic');
  const fix = sql.findIndex((text) => text.includes('"ix_payment_resolution_org_intent"'));
  assert.ok(fix > 0, 'the fix migration is there');
  const before = checkTenantLeadingIndex(replayMigrations(sql.slice(0, fix)), {});
  assert.deepEqual(
    before.errors.map((error) => error.split(':')[0]),
    ['payment_reconciliation_resolution'],
  );
  const after = checkTenantLeadingIndex(replayMigrations(sql), TABLE_EXEMPTIONS.economic ?? {});
  assert.deepEqual(after.errors, []);
  assert.equal(TABLE_FINDINGS_PENDING.economic, undefined);
});

for (const service of SERVICES) {
  test(`${service}-service: every tenant table has an index leading with organization_id, is exempted, or is on the pending list`, () => {
    const state = replayMigrations(migrationsOf(service));
    const pending = TABLE_FINDINGS_PENDING[service] ?? [];
    const { errors, notes, checked } = checkTenantLeadingIndex(
      state,
      TABLE_EXEMPTIONS[service] ?? {},
      undefined,
      pending,
    );
    assert.deepEqual(errors, []);
    assert.equal(notes.length, pending.length);
    assert.ok(checked > 0, 'an empty check proves nothing');
  });
}

test('the pending list names only opted-in services', () => {
  for (const service of Object.keys(TABLE_FINDINGS_PENDING)) {
    assert.ok(SERVICES.includes(service), service);
  }
});

// L7-44, asset-service: every report classified as a legitimate exemption
// (none needed a fix migration). Without the exemptions the check reports
// exactly these ten, so each one is load-bearing.
const ASSET_EXEMPT = [
  'asset_document_ref_asset_id_kind_idx',
  'asset_location_asset_id_recorded_at_idx',
  'asset_timeline_entry_asset_id_occurred_at_idx',
  'asset_timeline_entry_source_event_id_asset_id_key',
  'asset_transfer_asset_id_transferred_at_idx',
  'insurance_claim_asset_id_incident_at_idx',
  'insurance_policy_asset_id_status_idx',
  'insurance_policy_valid_to_status_idx',
  'technical_inspection_asset_id_inspected_at_idx',
  'ux_insurance_policy_number_active',
];

test('asset-service: without its exemptions exactly the classified indexes are reported', () => {
  const { errors } = checkTenantIndexOrder(replayMigrations(migrationsOf('asset')), {});
  assert.deepEqual(errors.map((error) => error.split(':')[0]).sort(), [...ASSET_EXEMPT].sort());
  assert.deepEqual(Object.keys(EXEMPTIONS.asset).sort(), [...ASSET_EXEMPT].sort());
});

test('every asset exemption says which query or invariant it serves', () => {
  for (const name of ASSET_EXEMPT) {
    const { reason } = EXEMPTIONS.asset[name];
    assert.ok(typeof reason === 'string' && reason.length > 60, name);
    assert.match(reason, /[A-Z][A-Za-z]+\.[a-z][A-Za-z]+/, name);
  }
});

test('asset-service: every tenant table already has an index leading with organization_id', () => {
  const { errors, checked } = checkTenantLeadingIndex(replayMigrations(migrationsOf('asset')), {});
  assert.deepEqual(errors, []);
  assert.ok(checked > 0);
  assert.equal(TABLE_EXEMPTIONS.asset, undefined);
});

// The tables #218's table-level check reported outside economic, classified by
// their services. Without the table exemptions exactly these are reported, so
// each is load-bearing; construction's was classified in #208 (review round 2).
const TABLES_CLASSIFIED = {
  construction: ['policy_reconciliation_task'],
  contract: ['policy_reconciliation_task'],
  supplier: ['qualification_evidence', 'supplier_capability', 'suspension'],
  notification: ['delivery_attempt'],
  audit: [
    'audit_chain_head',
    'bid_access_evidence',
    'tender_receipt_link',
    'tender_receipt_pending',
  ],
  fleet: ['asset_transfer_fence', 'asset_transfer_release'],
  maintenance: ['asset_transfer_fence', 'asset_transfer_release'],
};

test('without their table exemptions exactly the classified tables are reported', () => {
  for (const [service, tables] of Object.entries(TABLES_CLASSIFIED)) {
    const { errors } = checkTenantLeadingIndex(replayMigrations(migrationsOf(service)), {});
    assert.deepEqual(
      errors.map((error) => error.split(':')[0]).sort(),
      [...tables].sort(),
      service,
    );
    assert.deepEqual(Object.keys(TABLE_EXEMPTIONS[service]).sort(), [...tables].sort(), service);
    assert.equal(TABLE_FINDINGS_PENDING[service], undefined, service);
  }
});

test('every table exemption says which query reads the table', () => {
  for (const [service, tables] of Object.entries(TABLES_CLASSIFIED)) {
    for (const table of tables) {
      const reason = TABLE_EXEMPTIONS[service][table];
      assert.ok(typeof reason === 'string' && reason.length > 60, `${service}.${table}`);
      assert.match(reason, /[A-Z][A-Za-z]+\.[a-z][A-Za-z]+/, `${service}.${table}`);
    }
  }
});

test('no table is pending any more: every one #218 reported is classified (#208)', () => {
  assert.deepEqual(TABLE_FINDINGS_PENDING, {});
});
