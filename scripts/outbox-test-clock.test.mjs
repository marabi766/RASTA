import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

function hazards(source, file = '') {
  const errors = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const report = (node, reason) => {
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    errors.push(`${file}:${line + 1}: ${reason}`);
  };
  const visit = (node) => {
    // Stronger than a reclaim heuristic: forbid zero leases/backoffs in specs.
    // To avoid parking rows, expireClaim after claiming with a positive lease.
    if (
      ts.isPropertyAssignment(node) &&
      /^(leaseSeconds|baseSeconds)$/.test(
        ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(ast),
      ) &&
      node.initializer.getText(ast) === '0'
    ) {
      report(node, 'zero lease/backoff: use expireClaim/makeDue');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'claim' &&
      node.arguments[2]?.getText(ast) === '0'
    ) {
      report(node, 'zero positional lease: use expireClaim');
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const sql = node.getText(ast);
      const bareNow =
        /\b(?:claim_expires_at|next_attempt_at|(?:sweep_)?lease_until)"?\s*=\s*now\(\)(?!\s*[+-])/;
      // SELECT equality assertions and in-transaction EQ boundary INSERTs are
      // intentional. Include assignment fragments passed to SQL setters too.
      const unreviewed = (harmless.get(file) ?? []).reduce(
        (text, reviewed) => text.replaceAll(reviewed, ''),
        sql,
      );
      if (bareNow.test(unreviewed) && !/^\s*[`'"]\s*SELECT\b/i.test(sql)) {
        report(node, 'bare now() eligibility write: use expireClaim/makeDue');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return errors;
}

function specs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? specs(path) : /\.(?:int-)?spec\.ts$/.test(path) ? [path] : [];
  });
}

test('service specs use explicit past timestamps for cross-statement eligibility', () => {
  const errors = specs(join(root, 'services')).flatMap((path) =>
    hazards(readFileSync(path, 'utf8'), relative(root, path)),
  );
  assert.deepEqual(errors, []);
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
