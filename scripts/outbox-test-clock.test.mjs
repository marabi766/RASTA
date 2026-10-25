// Self-tests of the eligibility-clock guard (scripts/eligibility-clock-guard.mjs
// and its derive / sql / scope modules). The first test runs the guard over
// this repository; the rest pin each refusal on small fixtures, so a mutant
// that disables a refusal branch fails here.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  deriveGate,
  expressionHash,
  gateIndex,
  hazards,
  helperHazards,
  leaseSignatures,
  repositoryHazards,
  reviewedTemplates,
  templateHash,
} from './eligibility-clock-guard.mjs';
import { stripComments } from './eligibility-clock-sql.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The repository's own gate, derived once and only when a test needs it, so the
// fixture-repository tests below stand on their own (a mutant that breaks the
// derivation fails them, not just the module import).
let realCache;
const real = () => {
  if (!realCache) {
    const gate = deriveGate(root);
    realCache = {
      gate,
      index: gateIndex(gate),
      reviewed: reviewedTemplates(root),
      signatures: leaseSignatures(root, gate.flow),
    };
  }
  return realCache;
};
const check = (source, file = 'fixture.ts', approved = real().reviewed) =>
  hazards(source, file, real().index, approved, real().signatures);
const WRITE =
  /direct (?:SQL|ORM) eligibility write|unprovable ORM data flow|unclassified SQL write/;
const refused = (source, reason = WRITE) =>
  assert.ok(
    check(source).some((error) => reason.test(error)),
    `${source}\n=> ${JSON.stringify(check(source))}`,
  );
const allowed = (source) => assert.deepEqual(check(source), [], source);

/** A throwaway repository: a root manifest, one service with a schema, and `files`. */
function repository(files, run) {
  const dir = mkdtempSync(join(tmpdir(), 'eligibility-guard-'));
  const base = {
    'package.json': '{"name":"fixture-root","scripts":{}}',
    'services/sample/package.json': '{"name":"@rasta/sample"}',
    'services/sample/prisma/schema.prisma': [
      'model Hold {',
      '  id        String   @id',
      '  expiresAt DateTime @map("expires_at")',
      '  heldAt    DateTime @map("held_at")',
      '  note      String',
      '  @@map("hold")',
      '}',
    ].join('\n'),
    'services/sample/src/main.ts': "import './hold.repository';\n",
    'services/sample/src/clock.ts':
      'export async function databaseNow(tx: any): Promise<Date> {\n' +
      '  const rows = await tx.$queryRawUnsafe(`SELECT now() AS now`);\n' +
      '  return rows[0].now;\n}\n',
  };
  try {
    for (const [path, content] of Object.entries({ ...base, ...files })) {
      if (content === null) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const product = (body) => ({
  'services/sample/src/hold.repository.ts': `import { databaseNow } from './clock';\n${body}\n`,
});
const DUE =
  'export async function dueItems(tx: any) { return tx.$queryRawUnsafe(`SELECT id FROM hold WHERE expires_at <= now()`); }';

test('the repository: every enforced test, fixture and script write goes through the helpers or a reviewed probe', () => {
  const { gate, index, reviewed, signatures } = real();
  assert.deepEqual(repositoryHazards(root, { gate, index, reviewed, signatures }), []);
});

test('F1: derivation reads every product SQL literal; the four tables the name filter missed are gated', () => {
  const { gate, index } = real();
  for (const [key, evidence] of [
    ['stock_reservation.expires_at', 'inventory-service/src/reservation/reservation.repository.ts'],
    ['asset_transfer_fence.expires_at', 'fleet-service/src/fleet/fleet.repository.ts'],
    [
      'asset_transfer_release.expires_at',
      'maintenance-service/src/maintenance/maintenance.repository.ts',
    ],
    [
      'notification_dedupe.expires_at',
      'notification-service/src/notification/notification.repository.ts',
    ],
  ]) {
    const entry = gate.gated.get(key);
    assert.ok(entry, key);
    assert.ok(
      entry.evidence.some((e) => e.includes(evidence)),
      `${key}: ${entry.evidence}`,
    );
    assert.ok(entry.fields.has('expiresAt'), key);
    // None of these is read from a method the r1 name filter matched.
    assert.ok(
      entry.evidence.every(
        (e) => !/\((?:[^,]*claim[^,]*|DueParkedInsurance|findParkedInsurance),/i.test(e),
      ),
      key,
    );
  }
  // The DB-clock value read in the same flow (transactionNow -> ${at}) gates too.
  assert.ok(
    gate.gated
      .get('stock_reservation.expires_at')
      .evidence.some((e) => /reservation\.repository\.ts:\d+ \(dueOf, db-clock value\)/.test(e)),
  );
  // The r1 columns are still derived.
  for (const key of [
    'policy_reconciliation_task.next_attempt_at',
    'policy_reconciliation_task.lease_until',
    'tender.bid_closing_at',
    'tender.close_lease_until',
    'tender.close_next_attempt_at',
    'document.scan_next_attempt_at',
    'document.scan_lease_expires_at',
    'insurance_pending_verification.first_seen_at',
    'insurance_pending_verification.last_attempt_at',
    'security_event_outbox.claim_expires_at',
    'notification_intent.next_resolution_at',
    'demand_aggregation.closes_at',
    'demand_aggregation.sweep_lease_until',
    'demand_aggregation.sweep_next_attempt_at',
    'rfq.quotation_closing_at',
    'outbox_message.next_attempt_at',
    'outbox_message.claim_expires_at',
  ])
    assert.ok(gate.gated.has(key), key);
  // Each gated column is refused as an SQL and an ORM write on every table/model mapping it.
  for (const entry of gate.gated.values()) {
    refused(`sql(\`UPDATE ${entry.table} SET "${entry.column}" = NULL\`);`);
    for (const delegate of entry.delegates)
      for (const field of entry.fields)
        if (index.fieldsByDelegate.get(delegate)?.has(field))
          refused(`db.${delegate}.update({ where: {}, data: { ${field}: null } });`);
  }
});

test('F1: the method name does not matter (mutant: restoring the claim-name filter is caught)', () => {
  repository(product(DUE.replace('dueItems', 'sweepOldRows')), (dir) => {
    const derived = deriveGate(dir, { reviewedSites: [] });
    assert.deepEqual([...derived.gated.keys()], ['hold.expires_at']);
    assert.match(derived.gated.get('hold.expires_at').evidence[0], /sweepOldRows, sql clock/);
  });
});

test('F1: every clock spelling classifies, with arithmetic, casts and a projected alias', () => {
  for (const clock of [
    'now()',
    'CURRENT_TIMESTAMP',
    'clock_timestamp()',
    'statement_timestamp()',
    'transaction_timestamp()',
    'LOCALTIMESTAMP',
    "now() - interval '1 second'",
    'now()::timestamptz',
  ])
    repository(
      product(
        `export async function f(tx: any) { return tx.$queryRawUnsafe(\`SELECT id FROM hold WHERE expires_at <= ${clock}\`); }`,
      ),
      (dir) =>
        assert.ok(deriveGate(dir, { reviewedSites: [] }).gated.has('hold.expires_at'), clock),
    );
  repository(
    product(
      'export async function f(tx: any) { return tx.$queryRawUnsafe(`SELECT h.id FROM hold h, (SELECT clock_timestamp() AS now) t WHERE h.held_at <= t.now`); }',
    ),
    (dir) => assert.ok(deriveGate(dir, { reviewedSites: [] }).gated.has('hold.held_at')),
  );
});

test('F1: a value read from the DB clock in the same flow is clock-gated (SQL and Prisma)', () => {
  repository(
    product(
      'export async function release(tx: any) {\n' +
        '  const at = await databaseNow(tx);\n' +
        '  return tx.$queryRawUnsafe(`SELECT id FROM hold WHERE expires_at <= $1`, at);\n}\n' +
        'export async function later(tx: any) {\n' +
        '  const at = await databaseNow(tx);\n' +
        '  return tx.$queryRaw`SELECT id FROM hold WHERE held_at <= ${at}`;\n}\n' +
        'export async function orm(tx: any) {\n' +
        '  return tx.hold.findMany({ where: { heldAt: { lte: await databaseNow(tx) } } });\n}',
    ),
    (dir) => {
      const derived = deriveGate(dir, { reviewedSites: [] });
      assert.ok(derived.gated.has('hold.expires_at'));
      assert.ok(derived.gated.has('hold.held_at'));
      assert.ok(derived.sites.every((s) => /db-clock value/.test(s.source)));
    },
  );
});

test('F1: an unproven compared value, a non-DateTime column, a missing column and a stray clock throw', () => {
  repository(
    product(
      'export async function f(tx: any, cutoff: Date) { return tx.$queryRawUnsafe(`SELECT id FROM hold WHERE held_at <= $1`, cutoff); }\n' +
        DUE,
    ),
    (dir) => {
      assert.throws(
        () => deriveGate(dir, { reviewedSites: [] }),
        /hold\.held_at compared with a value of unproven origin/,
      );
      // A reviewed site classifies it; the column is then not gated.
      const reviewedSite = {
        site: 'services/sample/src/hold.repository.ts#f',
        columns: ['held_at'],
        verdict: 'not-db-clock',
        reason: 'request input',
      };
      assert.deepEqual(
        [...deriveGate(dir, { reviewedSites: [reviewedSite] }).gated.keys()],
        ['hold.expires_at'],
      );
    },
  );
  for (const [sql, reason] of [
    ['SELECT id FROM hold WHERE note <= now()', /clock compared with non-DateTime hold\.note/],
    ['SELECT id FROM hold WHERE missing_at <= now()', /unclassified clock column missing_at/],
    ['SELECT id FROM hold WHERE now() <= now()', /clock comparison without a column/],
    ['SELECT id FROM hold ORDER BY now()', /clock use outside a comparison/],
  ])
    repository(
      product(`export async function f(tx: any) { return tx.$queryRawUnsafe(\`${sql}\`); }`),
      (dir) => assert.throws(() => deriveGate(dir, { reviewedSites: [] }), reason, sql),
    );
});

test('F1: reviews are narrow: stale entries, not-eligibility off the DB clock and contradictions throw', () => {
  repository(product(DUE), (dir) => {
    const stale = {
      site: 'services/sample/src/gone.ts#f',
      columns: ['x'],
      verdict: 'not-db-clock',
      reason: 'r',
    };
    assert.throws(() => deriveGate(dir, { reviewedSites: [stale] }), /stale site reviews/);
    const contradicts = {
      site: 'services/sample/src/hold.repository.ts#dueItems',
      columns: ['expires_at'],
      verdict: 'not-db-clock',
      reason: 'r',
    };
    assert.throws(
      () => deriveGate(dir, { reviewedSites: [contradicts] }),
      /contradicts a DB-clock comparison/,
    );
    // A gauge or retention purge may be classified not-eligibility, with a reason.
    const gauge = { ...contradicts, verdict: 'not-eligibility' };
    assert.throws(() => deriveGate(dir, { reviewedSites: [gauge] }), /no gated clock columns/);
  });
  repository(
    product(
      'export async function f(tx: any, cutoff: Date) { return tx.$queryRawUnsafe(`SELECT id FROM hold WHERE held_at <= $1`, cutoff); }\n' +
        DUE,
    ),
    (dir) => {
      const wrong = {
        site: 'services/sample/src/hold.repository.ts#f',
        columns: ['held_at'],
        verdict: 'not-eligibility',
        reason: 'r',
      };
      assert.throws(
        () => deriveGate(dir, { reviewedSites: [wrong] }),
        /not-eligibility applies to DB-clock sites only/,
      );
    },
  );
  // The application clock is listed but does not gate.
  repository(
    product(
      'export async function f(tx: any) { return tx.$queryRawUnsafe(`SELECT id FROM hold WHERE held_at <= $1`, new Date()); }\n' +
        DUE,
    ),
    (dir) => {
      const derived = deriveGate(dir, { reviewedSites: [] });
      assert.deepEqual([...derived.gated.keys()], ['hold.expires_at']);
      assert.ok(
        derived.sites.some((s) => s.column === 'held_at' && s.verdict === 'application-clock'),
      );
    },
  );
});

test('C: retention and gauge comparisons are classified not-eligibility with a reason; none is silently skipped', () => {
  const { gate } = real();
  const notEligibility = gate.sites.filter((s) => s.verdict === 'not-eligibility');
  for (const [file, column] of [
    ['packages/nest-common/src/outbox/outbox-sql.ts', 'published_at'],
    ['packages/nest-common/src/outbox/outbox-sql.ts', 'created_at'],
    ['services/construction-service/src/tender/award-standing-check.repository.ts', 'created_at'],
    ['services/audit-service/src/audit/tender-evidence.repository.ts', 'held_at'],
  ])
    assert.ok(
      notEligibility.some((s) => s.file === file && s.column === column && s.reason),
      `${file} ${column}`,
    );
  assert.ok(!gate.gated.has('outbox_message.published_at'));
  assert.ok(!gate.gated.has('tender_award_standing_check.created_at'));
  for (const site of gate.sites)
    assert.ok(
      ['gated', 'not-eligibility', 'not-db-clock', 'application-clock'].includes(site.verdict),
    );
});

test('F1: the formerly exempt notificationDedupe model is refused by (table, column), whatever the clock', () => {
  refused(
    'w.prisma.client.notificationDedupe.updateMany({ where: { organizationId }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });',
  );
  refused('db.notificationDedupe.create({ data: { dedupeKey: k, expiresAt: x } });');
  refused('db.stockReservation.update({ where, data: { expiresAt: new Date() } });');
  refused('db.assetTransferFence.create({ data: { assetId: a, expiresAt: x } });');
  refused('db.assetTransferRelease.createMany({ data: [{ assetId: a, expiresAt: x }] });');
});

test('F2: ORM data is followed through map builders, variables, spreads, helpers and method families', () => {
  for (const source of [
    'db.outboxMessage.createMany({ data: ids.map((id) => ({ id, nextAttemptAt: x })) });',
    'db.outboxMessage.createMany({ data: ids.flatMap((id) => [{ id, nextAttemptAt: x }]) });',
    'db.outboxMessage.createMany({ data: Array.from(ids, (id) => ({ id, nextAttemptAt: x })) });',
    'const data = { nextAttemptAt: x }; db.outboxMessage.update({ where, data });',
    'const args = { where, data: { nextAttemptAt: x } }; db.outboxMessage.update(args);',
    'const patch = { nextAttemptAt: x }; db.outboxMessage.update({ where, data: { ...patch } });',
    'const data = {}; data.nextAttemptAt = x; db.outboxMessage.update({ where, data });',
    'const data = Object.assign({}, { nextAttemptAt: x }); db.outboxMessage.update({ where, data });',
    'const rows = []; rows.push({ nextAttemptAt: x }); db.outboxMessage.createMany({ data: rows });',
    "function seed(over) { return db.outboxMessage.create({ data: { id: 'a', ...over } }); } seed({ nextAttemptAt: x });",
    'const row = (o) => ({ id: 1, ...o }); db.outboxMessage.create({ data: row({ nextAttemptAt: x }) });',
    'db.outboxMessage.update({ where, data: cond ? { nextAttemptAt: x } : {} });',
    'db.outboxMessage.update({ where, data: { ["nextAttemptAt"]: x } });',
    "db.outboxMessage.update({ where, data: { ['next' + 'AttemptAt']: x } });",
  ])
    refused(source, /direct ORM eligibility write \(outboxMessage\.nextAttemptAt\)/);
  // Positive controls: a followed builder or helper without a gated field is allowed, so
  // an unfollowed one (refused as unprovable) cannot pass for a followed one.
  allowed('db.outboxMessage.createMany({ data: ids.map((id) => ({ id, attempts: 0 })) });');
  allowed('db.outboxMessage.createMany({ data: ids.flatMap((id) => [{ id, attempts: 0 }]) });');
  allowed('const data = { attempts: 0 }; db.outboxMessage.update({ where, data });');
  for (const method of [
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
  ])
    refused(`db.outboxMessage.${method}({ data: [{ nextAttemptAt: new Date() }] });`);
  refused('db.outboxMessage.upsert({ where, create: { id }, update: { nextAttemptAt: x } });');
  allowed(
    "function seed(over) { return db.outboxMessage.create({ data: { id: 'a', ...over } }); } seed({ attempts: 1 });",
  );
});

test('F2/H: a data flow that cannot be followed into a gated model refuses', () => {
  for (const [source, reason] of [
    ['db.outboxMessage.update({ where, data: { [col]: x } });', /computed key/],
    ['export function f(d) { return db.outboxMessage.update({ where, data: d }); }', /parameter d/],
    [
      'const row = await db.outboxMessage.findFirst(); await db.outboxMessage.create({ data: { ...row } });',
      /unresolved call/,
    ],
    ['await db.outboxMessage.create({ data: makeRow() });', /unresolved call makeRow/],
    ['db.outboxMessage.update(args);', /unprovable ORM data flow/],
    ['db.outboxMessage.update({ where, data: row.patch });', /property row\.patch/],
  ])
    refused(source, reason);
  // An unknown receiver of a Prisma write with untraceable data might be a gated model: refused.
  refused(
    'db.someModel.create({ data: makeRow() });',
    /unprovable ORM data flow into an unknown model/,
  );
});

test('F2: SQL writes are refused in any SET position, row constructor, conflict update, COPY and insert list', () => {
  for (const source of [
    'sql(`UPDATE outbox_message SET attempts = 1, next_attempt_at = now()`);',
    'sql(`UPDATE outbox_message SET (attempts, next_attempt_at) = (1, now())`);',
    "sql(`INSERT INTO outbox_message (id) VALUES ('a') ON CONFLICT (id) DO UPDATE SET next_attempt_at = now()`);",
    'sql(`COPY outbox_message (id, next_attempt_at) FROM STDIN`);',
    "sql(`INSERT INTO stock_reservation (id, expires_at) VALUES ('a', now())`);",
    'sql(`UPDATE asset_transfer_release SET expires_at = now()`);',
    'sql(`UPDATE "outbox_message" SET "NEXT_ATTEMPT_AT" = $1`);',
    'sql(`UPDATE outbox_message SET next_attempt_at /* gap */ = $1`);',
    'sql("UPDATE outbox_message SET next_" + "attempt_at = " + "CURRENT_TIMESTAMP");',
    'const q = `UPDATE outbox_message SET next_attempt_at = now()`; await db.$executeRawUnsafe(q);',
    'await db.$executeRaw(Prisma.sql`UPDATE outbox_message SET next_attempt_at = ${x}`);',
    'await pg.query(`UPDATE outbox_message SET next_attempt_at = $1`, [x]);',
  ])
    refused(source);
  for (const value of [
    '$1',
    '${new Date()}',
    'NULL',
    "'2031-01-01'::timestamptz",
    "now() - interval '1 second'",
  ])
    refused(`sql(\`UPDATE outbox_message SET next_attempt_at = ${value}\`);`);
});

test('F2/F: a dynamic column anywhere in a SET or insert list, a dynamic table and split assembly refuse', () => {
  for (const [source, reason] of [
    [
      'sql(`UPDATE outbox_message SET attempts = 1, ${col} = now()`);',
      /splice \$\{col\} cannot be resolved/,
    ],
    [
      "sql(`INSERT INTO outbox_message (id, ${col}) VALUES ('a', now())`);",
      /splice \$\{col\} cannot be resolved/,
    ],
    [
      'sql(`UPDATE outbox_message SET ${set} WHERE id = $1`);',
      /splice \$\{set\} cannot be resolved/,
    ],
    ['sql(`UPDATE ${table} SET next_attempt_at = now()`);', /dynamic table/],
    ['sql(`INSERT INTO outbox_message SELECT * FROM other`);', /insert without a column list/],
    [
      "sql(['UPDATE outbox_message SET next_attempt_at', '= now()'].join(' '));",
      /outbox_message\.next_attempt_at/,
    ],
    [
      "sql(['UPDATE outbox_message SET next_', 'attempt_at = now()'].join(''));",
      /outbox_message\.next_attempt_at/,
    ],
    [
      "const cols = ['next_attempt_at']; sql(`UPDATE outbox_message SET ${cols.map((c) => `${c} = now()`).join(', ')}`);",
      /via splice/,
    ],
    [
      "const parts = []; parts.push('next_attempt_at = now()'); sql(`UPDATE outbox_message SET ${parts.join(', ')}`);",
      /cannot be resolved/,
    ],
    [
      "const parts = ['attempts = 1']; add(parts); sql(`UPDATE outbox_message SET ${parts.join(', ')}`);",
      /cannot be resolved/,
    ],
    [
      "let q = 'UPDATE outbox_message SET '; q += 'next_attempt_at = now()'; await db.$executeRawUnsafe(q);",
      /empty SET list/,
    ],
    [
      "const q = 'UPDATE outbox_message SET ' + col + ' = now()'; await db.$executeRawUnsafe(q);",
      /cannot be resolved/,
    ],
    [
      "const COLUMNS = { a: 'attempts' }; COLUMNS.b = 'next_attempt_at'; sql(`UPDATE outbox_message SET ${COLUMNS[k]} = now()`);",
      /cannot be resolved/,
    ],
  ])
    refused(source, reason);
  // Provably harmless splices stay allowed.
  allowed(
    "const cols = ['attempts']; sql(`UPDATE outbox_message SET ${cols.map((c) => `${c} = 1`).join(', ')}`);",
  );
  allowed('sql(`UPDATE ${table} SET attempts = 1`);');
});

test('F2: `--` inside a string literal does not hide a later assignment; a real comment does', () => {
  refused("sql(`UPDATE outbox_message SET note = 'a -- b', next_attempt_at = now()`);");
  refused("sql(`UPDATE outbox_message SET note = '--', next_attempt_at = now()`);");
  refused('sql(`UPDATE outbox_message SET note = $$ -- $$, next_attempt_at = now()`);');
  allowed(
    'sql(`UPDATE outbox_message SET attempts = 1 -- , next_attempt_at = now()\n WHERE id = $1`);',
  );
  assert.match(stripComments("a = '--x', b -- c\nd"), /^a = '--x', b\s+\nd$/);
  assert.match(stripComments("x /* y */ z '/* kept */'"), /^x\s+z '\/\* kept \*\/'$/);
});

test('F2 false positives stay allowed: assertion objects and read-only SELECTs', () => {
  for (const expression of ['new Date(0)', "new Date('2099-01-01')", 'new Date(x)']) {
    allowed(`expect(row).toMatchObject({ nextAttemptAt: ${expression} });`);
    allowed(`expect(row).toEqual(expect.objectContaining({ nextAttemptAt: ${expression} }));`);
    refused(`db.outboxMessage.update({ where, data: { nextAttemptAt: ${expression} } });`);
  }
  for (const expression of [
    "interval '0 seconds'",
    'make_interval(secs => 0)',
    "interval 'PT0S'",
  ]) {
    allowed(
      `sql(\`SELECT next_attempt_at = now() + ${expression} AS equal FROM outbox_message\`);`,
    );
    refused(`sql(\`UPDATE outbox_message SET next_attempt_at = now() + ${expression}\`);`);
  }
  allowed('sql(`UPDATE outbox_message SET attempts = 1 WHERE next_attempt_at <= now()`);');
  allowed('sql(`ALTER TABLE outbox_message ALTER COLUMN next_attempt_at SET DEFAULT now()`);');
});

test('F2/B: scope is the import graph from test entry points; production roots are never enforced', () => {
  const write =
    'export async function seed(db: any) { await db.$executeRawUnsafe(`UPDATE hold SET expires_at = now()`); }\n';
  repository(
    {
      ...product(
        `${DUE}\nexport async function own(tx: any) { return tx.$executeRawUnsafe(\`UPDATE hold SET expires_at = now()\`); }`,
      ),
      // Test entry points.
      'services/sample/test/hold.int-spec.ts':
        "import { own } from '../src/hold.repository';\nimport { seed } from './support';\nimport { local } from '../src/test-support';\nimport { shared } from '@rasta/testing';\nit('x', async () => { await own(1); await seed(1); await local(1); await shared(1); });\n",
      'scripts/protocol.pg.test.mjs':
        "import { fixture } from './protocol-fixture.mjs';\nawait fixture();\n",
      'apps/web/e2e/flow.spec.ts': "import { e2e } from './support/db';\nawait e2e();\n",
      'tests/e2e/src/run.test.ts': "import { drive } from './drive';\nawait drive();\n",
      // Reached only through those imports, so enforced whatever their names.
      'services/sample/test/support.ts': write,
      'services/sample/src/test-support.ts': write.replace('seed', 'local'),
      'packages/testing/package.json': '{"name":"@rasta/testing"}',
      'packages/testing/src/index.ts': write.replace('seed', 'shared'),
      'scripts/protocol-fixture.mjs': write.replace('seed(db: any)', 'fixture(db)'),
      'apps/web/e2e/support/db.ts': write.replace('seed', 'e2e'),
      'tests/e2e/src/drive.ts': write.replace('seed', 'drive'),
      // Not reached from any entry point: not test code.
      'scripts/orphan.mjs': write.replace('seed(db: any)', 'orphan(db)'),
      // An SQL fixture file, read with fs.
      'services/sample/test/fixtures/seed.sql': 'UPDATE hold SET expires_at = now();',
    },
    (dir) => {
      const derived = deriveGate(dir, { reviewedSites: [] });
      const errors = repositoryHazards(dir, { gate: derived, reviewed: [], reviewedImports: [] });
      const files = errors.map((e) => e.split(':')[0]).sort();
      assert.deepEqual(files, [
        'apps/web/e2e/support/db.ts',
        'packages/testing/src/index.ts',
        'scripts/protocol-fixture.mjs',
        'services/sample/src/test-support.ts',
        'services/sample/test/fixtures/seed.sql',
        'services/sample/test/support.ts',
        'tests/e2e/src/drive.ts',
      ]);
      assert.ok(
        errors.every((e) => /direct SQL eligibility write \(hold\.expires_at\)/.test(e)),
        errors.join('\n'),
      );
    },
  );
});

test('F2/H: unresolved and computed imports in enforced files refuse; a reviewed one passes, a stale one refuses', () => {
  repository(
    {
      ...product(DUE),
      'services/sample/test/a.int-spec.ts':
        "import { gone } from './missing';\nimport { other } from '@rasta/nowhere';\nconst m = await import(name);\nconst n = await import(other);\n",
    },
    (dir) => {
      const gateHere = deriveGate(dir, { reviewedSites: [] });
      const listed = {
        file: 'services/sample/test/a.int-spec.ts',
        argument: 'other',
        loads: 'test fixture',
      };
      const stale = { file: 'services/sample/test/a.int-spec.ts', argument: 'gone', loads: 'x' };
      const errors = repositoryHazards(dir, {
        gate: gateHere,
        reviewed: [],
        reviewedImports: [listed, stale],
      });
      const has = (pattern) =>
        assert.ok(
          errors.some((e) => pattern.test(e)),
          errors.join('\n'),
        );
      has(/unresolved import '\.\/missing'/);
      has(/unresolved import '@rasta\/nowhere'/);
      has(/a\.int-spec\.ts:3: computed import specifier/);
      has(/stale reviewed computed import \(gone\)/);
      assert.ok(
        !errors.some((e) => /a\.int-spec\.ts:4: computed import/.test(e)),
        errors.join('\n'),
      );
    },
  );
});

test('F4: a reviewed template is bound to its file and its exact substitutions', () => {
  const source =
    'import { eligibilityClockSql } from "@rasta/testing"; eligibilityClockSql`UPDATE outbox_message SET next_attempt_at = ${fixed}`;';
  const ast = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  let template;
  (function find(n) {
    if (ts.isTaggedTemplateExpression(n)) template = n.template;
    ts.forEachChild(n, find);
  })(ast);
  const entry = {
    file: 'services/a/test/probe.int-spec.ts',
    template: templateHash(template),
    expressions: expressionHash(template, ast),
  };
  assert.deepEqual(check(source, entry.file, [entry]), []);
  // Same template, another file.
  assert.ok(
    check(source, 'services/b/test/other.int-spec.ts', [entry]).some((e) =>
      /unreviewed eligibility SQL probe/.test(e),
    ),
  );
  // Same file, other substitutions.
  assert.ok(
    check(source.replace('${fixed}', '${new Date()}'), entry.file, [entry]).some((e) =>
      /unreviewed eligibility SQL probe/.test(e),
    ),
  );
  // A shadowed or unimported tag earns nothing.
  assert.ok(
    check(
      source.replace('import { eligibilityClockSql } from "@rasta/testing"; ', ''),
      entry.file,
      [entry],
    ).length > 0,
  );
  assert.ok(
    check(source.replace('"@rasta/testing"', '"./lookalike"'), entry.file, [entry]).length > 0,
  );
  // A second, unreviewed write in the same file is still refused.
  assert.equal(
    check(`${source} sql(\`UPDATE outbox_message SET next_attempt_at = now()\`);`, entry.file, [
      entry,
    ]).length,
    1,
  );
});

test('F4: a reviewed generic template cannot write a gated column chosen at run time', () => {
  const generic = (call) =>
    `import { eligibilityClockSql } from "@rasta/testing";\nconst update = (set) => eligibilityClockSql\`UPDATE outbox_message SET \${set} WHERE id = 'a'\`;\n${call}`;
  const entryFor = (source) => {
    const ast = ts.createSourceFile('g.ts', source, ts.ScriptTarget.Latest, true);
    let template;
    (function find(n) {
      if (ts.isTaggedTemplateExpression(n) && !template) template = n.template;
      ts.forEachChild(n, find);
    })(ast);
    return {
      file: 'g.ts',
      template: templateHash(template),
      expressions: expressionHash(template, ast),
    };
  };
  const plain = generic("update('attempts = 1');");
  assert.deepEqual(check(plain, 'g.ts', [entryFor(plain)]), []);
  const gated = generic("update('next_attempt_at = now()');");
  assert.ok(
    check(gated, 'g.ts', [entryFor(gated)]).some((e) => /next_attempt_at\) via splice/.test(e)),
  );
  const opaque = generic('update(input);');
  assert.ok(
    check(opaque, 'g.ts', [entryFor(opaque)]).some((e) => /cannot be resolved statically/.test(e)),
  );
  // A gated fragment is allowed only when it is itself a reviewed probe.
  const fragment = generic('update(eligibilityClockSql`next_attempt_at = now()`);');
  const fragmentAst = ts.createSourceFile('g.ts', fragment, ts.ScriptTarget.Latest, true);
  const entries = [];
  (function find(n) {
    if (ts.isTaggedTemplateExpression(n))
      entries.push({
        file: 'g.ts',
        template: templateHash(n.template),
        expressions: ts.isTemplateExpression(n.template)
          ? expressionHash(n.template, fragmentAst)
          : null,
      });
    ts.forEachChild(n, find);
  })(fragmentAst);
  assert.deepEqual(check(fragment, 'g.ts', entries), []);
  assert.ok(check(fragment, 'g.ts', [entries[0]]).length > 0);
});

test('F4: a reviewed entry no live template matches is stale', () => {
  repository(product(DUE), (dir) => {
    const stale = {
      file: 'services/sample/test/x.int-spec.ts',
      template: 'a'.repeat(64),
      expressions: null,
    };
    const errors = repositoryHazards(dir, {
      gate: deriveGate(dir, { reviewedSites: [] }),
      reviewed: [stale],
    });
    assert.ok(
      errors.some((e) =>
        /stale reviewed template for services\/sample\/test\/x\.int-spec\.ts/.test(e),
      ),
    );
  });
});

test('declared lease parameter names cover claimDue index 1 and notification index 2', () => {
  const { signatures } = real();
  assert.ok(signatures.get('claimDue').has(1));
  assert.ok(signatures.get('claimPending').has(2));
  for (const zero of ['0', '0.0', '-0', '(0)', '0x0']) {
    refused(`w.reconciliations.claimDue(500, ${zero}, 'TOKEN_A');`, /zero positional lease/);
    refused(`w.repository.claimPending('worker', 10, ${zero});`, /zero positional lease/);
    refused(`w.repository["claimSendable"]('worker', 10, ${zero});`, /zero positional lease/);
  }
  refused(
    'const lease = 0; w.reconciliations.claimDue(500, lease, "TOKEN_A");',
    /zero positional lease/,
  );
  allowed('w.reconciliations.claimDue(500, 60, "TOKEN_A");');
  for (const field of [
    'leaseSeconds',
    'baseSeconds',
    'backoffSeconds',
    'delaySeconds',
    'claimLeaseSeconds',
  ])
    refused(`sweeperWith({ "${field}": 0 });`, /zero lease\/backoff option/);
});

test('the helper is the one write path: its SQL must be static; malformed allowlists fail closed', () => {
  assert.deepEqual(
    helperHazards('const a = `UPDATE x SET y = now() WHERE id = ANY($1)`;', 'h.ts'),
    [],
  );
  assert.match(
    helperHazards('const a = `UPDATE x SET ${c} = now()`;', 'h.ts')[0],
    /helper SQL must be a static literal/,
  );
  assert.match(check('db.update({ data: { nextAttemptAt:')[0], /unparseable test source/);
  repository({}, (dir) => {
    mkdirSync(join(dir, 'packages/testing/src'), { recursive: true });
    const path = join(dir, 'packages/testing/src/eligibility-clock.ts');
    assert.throws(() => reviewedTemplates(dir));
    writeFileSync(path, 'const reviewedClockTemplates = getTemplates();');
    assert.throws(() => reviewedTemplates(dir), /malformed clock template allowlist/);
    writeFileSync(
      path,
      "const reviewedClockTemplates = [{ file: 'a', template: 'short', expressions: null }];",
    );
    assert.throws(() => reviewedTemplates(dir), /malformed clock template allowlist/);
    writeFileSync(path, 'const reviewedClockTemplates = [];');
    assert.throws(() => reviewedTemplates(dir), /missing clock template allowlist/);
  });
});

test('claim SQL retains the unqualified transaction clock required by the boundary fixture', () => {
  const source = readFileSync(join(root, 'packages/nest-common/src/outbox/outbox-sql.ts'), 'utf8');
  const start = source.indexOf('export async function claimPendingSql');
  const claim = source.slice(start, source.indexOf('export async function', start + 1));
  assert.ok(claim.includes('<= now()'), 'claim SQL must use unqualified now()');
  assert.doesNotMatch(
    claim,
    /pg_catalog\.now|CURRENT_TIMESTAMP|(?:transaction|statement|clock)_timestamp/i,
  );
});
