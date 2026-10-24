import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));

// Reviewed non-eligibility writes. Keep exemptions narrow: these tests never reclaim.
const harmless = new Map([
  [
    'services/notification-service/test/constraints.int-spec.ts',
    [
      'UPDATE "notification_delivery" SET "next_attempt_at" = now() WHERE',
      'UPDATE "notification_intent" SET "claim_token" = \'t\', "claim_owner" = \'o\', "claim_expires_at" = now() WHERE',
    ], // Both writes are rejected CHECK violations, never reclaimed.
  ],
  [
    'services/procurement-service/test/rfq-constraints.int-spec.ts',
    ["UPDATE rfq SET sweep_lease_until = now(), sweep_fence = 'F', sweep_attempts = 1 WHERE"], // Bookkeeping/version only.
  ],
  [
    'services/document-service/test/outbox-durable-claim.int-spec.ts',
    ["UPDATE outbox_message SET next_attempt_at=now() WHERE id='CK'"], // Rejected CHECK violation.
  ],
  [
    'services/identity-service/test/security-event-aggregation.int-spec.ts',
    ["SET claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1"], // Index/immutability only.
  ],
  [
    'services/economic-service/test/payment-reconciliation-operator.int-spec.ts',
    ["status = 'PENDING', next_attempt_at = now()"], // Status refusal; no sweeper runs.
  ],
]);

function isZero(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isPrefixUnaryExpression(node)) {
    return isZero(node.operand ?? node.expression);
  }
  return ts.isNumericLiteral(node) && Number(node.text) === 0;
}

function hazards(source, file = '') {
  const errors = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const report = (node, reason) => {
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    errors.push(`${file}:${line + 1}: ${reason}`);
  };
  const visit = (node) => {
    // Stronger than a reclaim heuristic: forbid zero leases/backoffs in all test code.
    // To avoid parking rows, expireClaim after claiming with a positive lease.
    if (
      ts.isPropertyAssignment(node) &&
      /^(leaseSeconds|baseSeconds)$/.test(
        ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(ast),
      ) &&
      isZero(node.initializer)
    ) {
      report(node, 'zero lease/backoff: use expireClaim/makeDue');
    }
    if (
      ts.isCallExpression(node) &&
      /^claim/i.test(
        ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isElementAccessExpression(node.expression) &&
              ts.isStringLiteral(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text
            : node.expression.getText(ast),
      ) &&
      isZero(node.arguments[2])
    ) {
      report(node, 'zero positional lease: use expireClaim');
    }
    if (
      ts.isPropertyAssignment(node) &&
      /^(?:claimExpiresAt|nextAttemptAt|leaseUntil)$|(?:ClaimExpiresAt|NextAttemptAt|LeaseUntil)$/.test(
        ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(ast),
      ) &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.expression.getText(ast) === 'Date'
    ) {
      report(node, 'JS-clock eligibility write: use expireClaim/makeDue');
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const sql = node.getText(ast);
      const bareNow = /([a-z_][a-z_0-9]*|"[a-z_][a-z_0-9]*")\s*=\s*now\(\)(?!\s*[+-])/gi;
      const eligibilityColumn = /(^|[_"])(claim_expires_at|next_attempt_at|lease_until)"?$/;

      // SELECT equality assertions and in-transaction EQ boundary INSERTs are
      // intentional. Include assignment fragments passed to SQL setters too.
      const unreviewed = (harmless.get(file) ?? []).reduce(
        (text, reviewed) => text.replaceAll(reviewed, ''),
        sql,
      );
      if (
        [...unreviewed.matchAll(bareNow)].some((match) => eligibilityColumn.test(match[1])) &&
        !/^\s*[`'"]\s*SELECT\b/i.test(sql)
      ) {
        report(node, 'bare now() eligibility write: use expireClaim/makeDue');
      }
      for (const [, interval] of sql.matchAll(/\binterval\s*'([^']+)'/gi)) {
        // PostgreSQL also accepts abbreviated units, decimal zeros and HH:MM:SS.
        if (
          /0/.test(interval) &&
          /^[+\-0.:\s]*(?:(?:microseconds?|milliseconds?|seconds?|minutes?|mins?|secs?|hours?|hrs?|days?|weeks?|months?|years?|us|ms|s|m|h|d)\s*[+\-0.:\s]*)*$/i.test(
            interval,
          )
        ) {
          report(node, 'zero SQL interval: use expireClaim/makeDue');
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return errors;
}

function typescriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : /\.ts$/.test(path) ? [path] : [];
  });
}

function serviceHazards(repository) {
  return readdirSync(join(repository, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const service = join(repository, 'services', entry.name);
      return readdirSync(service).includes('test') ? typescriptFiles(join(service, 'test')) : [];
    })
    .flatMap((path) => hazards(readFileSync(path, 'utf8'), relative(repository, path)));
}

test('all service test TypeScript uses DB-clock helpers for eligibility', () => {
  assert.deepEqual(serviceHazards(root), []);
});

test('guard rejects zero leases/backoffs and bare eligibility writes', () => {
  for (const source of [
    'store.claimPending({ leaseSeconds: 0 }); reclaim();',
    'const backoff = { baseSeconds: 0 }; reclaim();',
    'claim(storeA, 10, 0); claim(storeB);',
    'sql(`UPDATE outbox_message SET claim_expires_at = now() WHERE id = $1`); reclaim();',
    'sql(`UPDATE task SET next_attempt_at=now() WHERE id = $1`); sweeper.runOnce();',
    'sql(`UPDATE task SET "next_attempt_at"=now() WHERE id = $1`); sweeper.runOnce();',
    'sql(`UPDATE task SET sweep_lease_until=now() WHERE id = $1`); sweeper.runOnce();',
    "setTask(`status = 'PENDING', next_attempt_at=now()`); sweeper.runOnce();",
    'store.claimPending({ "leaseSeconds": 0 }); reclaim();',
  ]) {
    assert.equal(hazards(source).length, 1, source);
  }
});

test('guard rejects prefixed SQL eligibility columns', () => {
  for (const column of ['close_next_attempt_at', 'close_lease_until', 'scan_next_attempt_at']) {
    for (const name of [column, `"${column}"`]) {
      assert.equal(hazards(`sql(\`UPDATE task SET ${name} = now()\`);`).length, 1, name);
    }
  }
});

test('guard scans helpers and nested non-spec TypeScript under every service test directory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'eligibility-guard-'));
  try {
    const dir = join(fixture, 'services', 'sample-service', 'test', 'nested');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'helpers.ts'), 'w.repository.claimPending("worker", 10, 0);');
    assert.match(serviceHazards(fixture)[0], /test\/nested\/helpers.ts:1: zero positional lease/);
    assert.equal(serviceHazards(fixture).length, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('guard rejects ORM eligibility fields assigned from the JS clock', () => {
  for (const field of [
    'claimExpiresAt',
    'nextAttemptAt',
    'leaseUntil',
    'closeNextAttemptAt',
    'closeLeaseUntil',
    'scanNextAttemptAt',
    'sweepLeaseUntil',
    'outboxClaimExpiresAt',
  ]) {
    for (const name of [field, `"${field}"`]) {
      assert.equal(
        hazards(`update({ data: { ${name}: new Date(Date.now() - 1000) } });`).length,
        1,
        name,
      );
    }
  }
});

test('guard rejects zero positional leases on every claim method', () => {
  for (const call of [
    'claim',
    'store.claimPending',
    'w.repository.claimReady',
    'claimBatch',
    'store["claimPending"]',
  ]) {
    for (const zero of ['0', '0.0', '-0', '(0)', '0x0']) {
      assert.equal(hazards(`${call}('worker', 10, ${zero});`).length, 1, `${call}: ${zero}`);
    }
  }
});

test('guard rejects zero SQL intervals', () => {
  for (const interval of [
    '0 s',
    '0 seconds',
    '0 milliseconds',
    '0.0 min',
    '00:00:00',
    '0',
    '0 days 0 s',
  ]) {
    assert.equal(
      hazards(`sql(\`UPDATE task SET next_attempt_at = now() + interval '${interval}'\`);`).length,
      1,
      interval,
    );
  }
});

test('a reviewed constraint write cannot exempt another eligibility write', () => {
  assert.equal(
    hazards(
      "sql(`UPDATE outbox_message SET next_attempt_at=now() WHERE id='CK'; UPDATE task SET next_attempt_at=now()`);",
      'services/document-service/test/outbox-durable-claim.int-spec.ts',
    ).length,
    1,
  );
});

test('guard accepts explicit past helpers and transactional boundary comparisons', () => {
  assert.deepEqual(
    hazards(`
    await expireClaim(prisma, [id]); await makeDue(prisma, [id]);
    sql(\`SELECT claim_expires_at = now() AS equal\`);
    sql(\`UPDATE outbox_message SET claim_expires_at = now() - interval '1 second'\`);
  `),
    [],
  );
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
