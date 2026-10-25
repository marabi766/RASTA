import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  deriveColumns,
  expressionHash,
  hazards,
  leaseSignatures,
  repositoryHazards,
  reviewedTemplates,
  templateHash,
} from './eligibility-clock-guard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const columns = deriveColumns(root);
const reviewed = reviewedTemplates(root);
const signatures = leaseSignatures(root);
const check = (source) => hazards(source, 'fixture.ts', columns, reviewed, signatures);
const refused = (source, reason = /direct .* eligibility write/) => {
  assert.ok(
    check(source).some((error) => reason.test(error)),
    source,
  );
};

function fixture(checkFixture) {
  const dir = mkdtempSync(join(tmpdir(), 'eligibility-guard-'));
  try {
    for (const path of [
      'services/sample/src',
      'services/sample/test/nested',
      'services/sample/prisma',
      'packages/sample/src',
      'scripts',
    ])
      mkdirSync(join(dir, path), { recursive: true });
    return checkFixture(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scanned test writes use allowlisted eligibility helpers or reviewed SQL probe templates', () => {
  assert.deepEqual(repositoryHazards(root, columns, reviewed, signatures), []);
});

test('F1a: claim SQL and Prisma mappings derive the column set, including resolution, scanning and age gates', () => {
  for (const column of [
    'next_resolution_at',
    'scan_lease_expires_at',
    'first_seen_at',
    'last_attempt_at',
    'next_attempt_at',
    'claim_expires_at',
    'close_lease_until',
    'sweep_lease_until',
  ]) {
    assert.ok(columns.has(column), column);
    assert.ok(
      columns.get(column).evidence.some((e) => e.includes('schema.prisma:')),
      column,
    );
    assert.ok(
      columns.get(column).evidence.some((e) => e.includes('.ts:')),
      column,
    );
  }
  for (const [column, entry] of columns) {
    refused(`sql(\`UPDATE task SET "${column}" = NULL\`);`);
    for (const field of entry.fields) refused(`update({data:{ ${field}: null }});`);
  }
});

test('F1a: new product columns are discovered; missing or non-DateTime schema fields refuse classification', () => {
  fixture((dir) => {
    const product = join(dir, 'services/sample/src/queue.ts');
    const schema = join(dir, 'services/sample/prisma/schema.prisma');
    writeFileSync(
      product,
      'export async function claimNew() { return sql(`SELECT id FROM queue WHERE "new_gate" <= CURRENT_TIMESTAMP`); }',
    );
    writeFileSync(
      schema,
      'model Queue {\n id String @id\n newGate DateTime @map("new_gate")\n @@map("queue")\n}',
    );
    assert.ok(deriveColumns(dir).has('new_gate'));
    writeFileSync(
      schema,
      'model Queue {\n id String @id\n newGate String @map("new_gate")\n @@map("queue")\n}',
    );
    assert.throws(() => deriveColumns(dir), /unclassified clock column new_gate/);
    writeFileSync(schema, 'model Queue {\n id String @id\n @@map("queue")\n}');
    assert.throws(() => deriveColumns(dir), /unclassified clock column new_gate/);
    rmSync(schema);
    assert.throws(() => deriveColumns(dir), /unclassified clock column/);
    writeFileSync(
      schema,
      'model Queue {\n id String @id\n newGate DateTime @map("new_gate")\n @@map("queue")\n}',
    );
    writeFileSync(
      product,
      'export async function claimNew() { return sql(`SELECT id FROM queue WHERE COALESCE(new_gate, now()) <= now()`); }',
    );
    assert.throws(() => deriveColumns(dir), /unclassified clock comparison/);
  });
});

test('F1b: declared lease parameter names cover claimDue index 1 and notification index 2', () => {
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
  assert.deepEqual(check('w.reconciliations.claimDue(500, 60, "TOKEN_A");'), []);
});

test('F1c: zero lease/backoff/delay options and all zero SQL forms are refused on writes', () => {
  for (const field of [
    'leaseSeconds',
    'baseSeconds',
    'backoffSeconds',
    'retryBackoffBaseSeconds',
    'delaySeconds',
    'claimLeaseSeconds',
    'visibilityDelaySeconds',
  ])
    refused(`sweeperWith({"${field}": 0});`, /zero lease\/backoff option/);
  for (const expression of [
    'make_interval(secs => 0)',
    "$2::int * interval '1 second'",
    "interval 'PT0S'",
    "interval '0 mon'",
    "interval '0 msec'",
    "interval '00:00:00'",
    "interval '0.0 seconds'",
  ])
    refused(`sql(\`UPDATE task SET next_attempt_at = now() + ${expression}\`, 0);`);
});

test('F1d: SQL writes are refused independently of their value, case, quoting or construction', () => {
  for (const expression of [
    '$1',
    '${new Date()}',
    'CURRENT_TIMESTAMP',
    'clock_timestamp()',
    'pg_catalog.now()',
    "now() - interval '500 microseconds'",
    "now() - interval '1 second'",
    'NULL',
    "'2031-01-01'::timestamptz",
  ]) {
    for (const column of ['next_attempt_at', 'NEXT_ATTEMPT_AT', '"next_attempt_at"'])
      refused(`sql(\`UPDATE task SET ${column} = ${expression}\`);`);
    refused(`sql(\`INSERT INTO task (id, next_attempt_at) VALUES ('ID', ${expression})\`);`);
  }
  refused('sql("UPDATE task SET next_" + "attempt_at = " + "CURRENT_TIMESTAMP");');
  refused('sql(`UPDATE task SET next_attempt_at /* gap */ = $1`);');
  refused(
    'sql(`UPDATE notification_intent SET ${column} = $1`);',
    /unclassified SQL write columns/,
  );
});

test('F1d: ORM writes reject variables, shorthand, strings, ternaries, globals and constants', () => {
  for (const expression of [
    'nextAttemptAt',
    'date.toISOString()',
    'condition ? a : b',
    'new globalThis.Date()',
    'new Date(0)',
    "new Date('2031-01-01')",
    'null',
  ])
    refused(`db.task.update({data:{ nextAttemptAt: ${expression} }});`);
  refused('db.task.update({data:{nextAttemptAt}});');
});

test('ORM data writes default to refusal across method families and computed keys', () => {
  for (const method of [
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
    'unknownWrite',
  ]) {
    refused(`db.task.${method}({data:[{nextAttemptAt:new Date()}]});`);
    refused(`db.task.${method}({data:{["nextAttemptAt"]:new Date()}});`);
    refused(`db.task.${method}({data:{['next' + 'AttemptAt']:new Date()}});`);
    refused(`db.task.${method}({data:{[column]:new Date()}});`, /unclassified ORM write columns/);
  }
  assert.deepEqual(check('expect(row).toMatchObject({data:{["nextAttemptAt"]:new Date(0)}});'), []);
});

test('F1e: traversal includes nested helpers, restored src specs and JS/MJS/TSX service tests plus real-PG scripts', () => {
  fixture((dir) => {
    const paths = [
      'services/sample/test/nested/helpers.ts',
      'services/sample/test/setup.js',
      'services/sample/test/setup.mjs',
      'services/sample/test/setup.cjs',
      'services/sample/test/setup.tsx',
      'services/sample/src/queue.spec.ts',
      'packages/sample/src/queue.spec.ts',
      'scripts/protocol.pg.test.mjs',
    ];
    for (const path of paths)
      writeFileSync(join(dir, path), 'sql(`UPDATE task SET next_resolution_at = $1`);');
    const errors = repositoryHazards(dir, columns, reviewed, signatures);
    assert.equal(errors.length, paths.length);
    for (const path of paths)
      assert.ok(
        errors.some((e) => e.startsWith(path + ':')),
        path,
      );
  });
});

test('F1f: explicit DB offsets and discarded row counts receive no general exemption', () => {
  refused(
    "await ownerSql([`UPDATE tender_award_standing_check SET next_attempt_at = now() - interval '1 second' WHERE tender_id = $1`]);",
  );
  assert.deepEqual(check("await setEligibilityFixture(prisma, 'awardDue', [tenderId]);"), []);
});

test('F2: clock-independent constant Dates and computed Dates in assertion objects are allowed; matching writes refuse', () => {
  for (const expression of ['new Date(0)', "new Date('2099-01-01')", 'new Date(x)']) {
    assert.deepEqual(check(`expect(row).toMatchObject({nextAttemptAt: ${expression}});`), []);
    refused(`db.task.update({data:{nextAttemptAt: ${expression}}});`);
  }
});

test('F2: zero intervals in SELECT assertions are allowed; the same expression in a write refuses', () => {
  for (const expression of [
    "interval '0 seconds'",
    'make_interval(secs => 0)',
    "interval 'PT0S'",
  ]) {
    assert.deepEqual(
      check(`sql(\`SELECT next_attempt_at = now() + ${expression} AS equal FROM task\`);`),
      [],
    );
    refused(`sql(\`UPDATE task SET next_attempt_at = now() + ${expression}\`);`);
  }
});

test('unknown templates, fake helper names and a second write cannot borrow a probe exemption', () => {
  const template = ts.createSourceFile(
    'probe.ts',
    '`UPDATE task SET next_attempt_at = now()`',
    ts.ScriptTarget.Latest,
    true,
  ).statements[0].expression;
  const approved = new Set([templateHash(template)]);
  assert.deepEqual(
    hazards(
      'import {eligibilityClockSql as approved} from "@rasta/testing"; approved`UPDATE task SET next_attempt_at = now()`;',
      'fixture.ts',
      columns,
      approved,
      signatures,
    ),
    [],
  );
  refused('eligibilityClockSql`UPDATE task SET next_attempt_at = now()`;');
  refused(
    'import {eligibilityClockSql} from "@rasta/testing"; eligibilityClockSql`UPDATE task SET next_attempt_at = CURRENT_TIMESTAMP`;',
  );
  const errors = hazards(
    'import {eligibilityClockSql} from "@rasta/testing"; eligibilityClockSql`UPDATE task SET next_attempt_at = now()`; sql(`UPDATE task SET next_attempt_at = now()`);',
    'fixture.ts',
    columns,
    approved,
    signatures,
  );
  assert.equal(errors.length, 1);
});

test('reviewed raw SQL cannot borrow different substitutions or a shadowed helper', () => {
  const ast = ts.createSourceFile(
    'fixture.ts',
    'sql`UPDATE task SET next_attempt_at = ${fixed}`;',
    ts.ScriptTarget.Latest,
    true,
  );
  const template = ast.statements[0].expression.template;
  const approved = new Set([templateHash(template)]);
  approved.expressions = new Set([expressionHash(template, ast)]);
  assert.deepEqual(
    hazards(
      'import {eligibilityClockSql} from "@rasta/testing"; eligibilityClockSql`UPDATE task SET next_attempt_at = ${fixed}`;',
      'fixture.ts',
      columns,
      approved,
      signatures,
    ),
    [],
  );
  assert.equal(
    hazards(
      'import {eligibilityClockSql} from "@rasta/testing"; eligibilityClockSql`UPDATE task SET next_attempt_at = ${new Date()}`;',
      'fixture.ts',
      columns,
      approved,
      signatures,
    ).length,
    1,
  );
  assert.equal(
    hazards(
      'import {eligibilityClockSql} from "@rasta/testing"; function f(eligibilityClockSql) { eligibilityClockSql`UPDATE task SET next_attempt_at = ${fixed}`; }',
      'fixture.ts',
      columns,
      approved,
      signatures,
    ).length,
    1,
  );
});

test('unparseable source and missing or malformed helper allowlists fail closed', () => {
  assert.match(check('db.update({ data: { nextAttemptAt:')[0], /unparseable test source/);
  fixture((dir) => {
    mkdirSync(join(dir, 'packages/testing/src'), { recursive: true });
    const path = join(dir, 'packages/testing/src/eligibility-clock.ts');
    assert.throws(() => reviewedTemplates(dir));
    writeFileSync(path, 'const reviewedClockTemplates = getTemplates();');
    assert.throws(() => reviewedTemplates(dir), /malformed clock template allowlist/);
    writeFileSync(path, 'const reviewedClockTemplates = [];');
    assert.throws(() => reviewedTemplates(dir), /missing clock template allowlist/);
  });
});

test('claim SQL retains the unqualified transaction clock required by the boundary fixture', () => {
  const source = readFileSync(join(root, 'packages/nest-common/src/outbox/outbox-sql.ts'), 'utf8');
  const claim = source.slice(
    source.indexOf('export async function claimPendingSql'),
    source.indexOf(
      'export async function',
      source.indexOf('export async function claimPendingSql') + 1,
    ),
  );
  assert.ok(claim.includes('<= now()'), 'claim SQL must use unqualified now()');
  assert.doesNotMatch(
    claim,
    /pg_catalog\.now|CURRENT_TIMESTAMP|(?:transaction|statement|clock)_timestamp/i,
  );
});
