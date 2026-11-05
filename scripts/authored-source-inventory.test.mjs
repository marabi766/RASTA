// The shared authored-source inventory and the guard that keeps recursive walkers on it (FU-102).
//
// Git-ignored output (`generated` Prisma clients, `node_modules`, build output) is rewritten by other
// tasks while a check runs. A walker that lists such a directory and reads it afterwards dies with
// ENOENT on a file nobody wrote (PR #741 F1/F2). `authored-source-inventory.cjs` never opens it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NOT_AUTHORED_DIRECTORIES, authoredFiles } from './authored-source-inventory.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'scripts/authored-source-inventory.cjs';
const asRoot = process.getuid?.() === 0; // root reads an unreadable directory anyway

/** A tree with authored sources and one directory of every kind that must never be opened. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'authored-inventory-'));
  for (const file of ['a.ts', 'b/c.ts', 'b/d/e.mjs']) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), 'export {};\n');
  }
  for (const name of NOT_AUTHORED_DIRECTORIES)
    mkdirSync(join(dir, 'b', name, 'deep'), { recursive: true });
  return dir;
}
const cleanup = (dir) => {
  for (const name of [...NOT_AUTHORED_DIRECTORIES, 'd']) chmodSync(join(dir, 'b', name), 0o755);
  rmSync(dir, { recursive: true, force: true });
};

test('lists authored files, sorted, and never opens generated or build output', (t) => {
  const dir = fixture();
  t.after(() => cleanup(dir));
  // Unreadable stands in for "gone since it was listed": opening any of them would throw.
  if (!asRoot) for (const name of NOT_AUTHORED_DIRECTORIES) chmodSync(join(dir, 'b', name), 0o000);
  assert.deepEqual(
    authoredFiles(dir).map((path) => relative(dir, path)),
    ['a.ts', 'b/c.ts', 'b/d/e.mjs'],
  );
  assert.deepEqual(NOT_AUTHORED_DIRECTORIES.includes('generated'), true);
});

test('skip prunes by name before the directory is opened', (t) => {
  const dir = fixture();
  t.after(() => cleanup(dir));
  if (!asRoot) chmodSync(join(dir, 'b', 'd'), 0o000);
  assert.deepEqual(
    authoredFiles(dir, { skip: (name) => name === 'd' }).map((path) => relative(dir, path)),
    ['a.ts', 'b/c.ts'],
  );
});

test('an authored directory that cannot be read, or a missing root, still fails', (t) => {
  const dir = fixture();
  t.after(() => cleanup(dir));
  assert.throws(() => authoredFiles(join(dir, 'absent')), { code: 'ENOENT' });
  assert.deepEqual(authoredFiles(join(dir, 'absent'), { optional: true }), []);
  // `optional` forgives a missing root only: a file where a directory should be is still a fault.
  assert.throws(() => authoredFiles(join(dir, 'a.ts'), { optional: true }), { code: 'ENOTDIR' });
  if (asRoot) return;
  chmodSync(join(dir, 'b', 'd'), 0o000);
  assert.throws(() => authoredFiles(dir), { code: 'EACCES' });
});

test('an authored file that vanishes after it was listed fails the read: it is not forgiven', (t) => {
  const dir = fixture();
  t.after(() => cleanup(dir));
  const [first] = authoredFiles(dir);
  rmSync(first);
  assert.throws(() => readFileSync(first, 'utf8'), { code: 'ENOENT' });
});

// ---------------------------------------------------------------------------------------------
// Every recursive directory walker goes through the inventory.
// ---------------------------------------------------------------------------------------------

const READERS = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir']);
const calleeName = (call) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
};
const isRecursiveOption = (node) =>
  ts.isPropertyAssignment(node) &&
  node.name.getText() === 'recursive' &&
  node.initializer.kind === ts.SyntaxKind.TrueKeyword;

/**
 * Recursive directory walkers in one source text: `readdir*(…, { recursive: true })`, a deep
 * `globSync('**')`, and a function that lists a directory and calls itself. Fail closed on what
 * it cannot parse. An iterative (stack-based) walker has no such mark and is not seen: review it.
 */
function recursiveWalkers(file, text) {
  const kind = /\.[cm]?jsx?$/.test(file)
    ? ts.ScriptKind.JS
    : file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics?.length) return [`${file}: does not parse`];
  const found = [];
  const note = (node, what) =>
    found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node) ?? '';
      // `{ recursive: true }` as the call writes it; options held in a variable cannot be read: refuse.
      const options = node.arguments[1];
      if (READERS.has(name) && options) {
        if (ts.isObjectLiteralExpression(options)) {
          if (options.properties.some(isRecursiveOption)) note(node, 'recursive: true');
        } else if (!ts.isStringLiteralLike(options)) note(node, 'options the guard cannot read');
      }
      if (name === 'globSync' && /\*\*/.test(node.arguments[0]?.getText() ?? '**'))
        note(node, 'globSync(**)');
    }
    const own = ts.isFunctionDeclaration(node)
      ? node.name?.text
      : ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.name.text
        : undefined;
    if (own) {
      let lists = false;
      let again = false;
      const inner = (child) => {
        if (ts.isCallExpression(child)) {
          const name = calleeName(child);
          lists ||= READERS.has(name ?? '');
          again ||= name === own;
        }
        ts.forEachChild(child, inner);
      };
      ts.forEachChild(node, inner);
      if (lists && again) note(node, `${own} lists a directory and calls itself`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Walkers that predate the inventory (one each). Generated output exists only under
 * `services/<name>/src/generated` (.gitignore ignores `src/generated/` at any depth), so a walker is out of reach of the
 * race when it prunes `generated` BY NAME before it opens anything (A), or walks a tree that cannot
 * contain it: apps/web, scripts, infrastructure, .github, dependencies, a temporary fixture (B).
 * Both lists only shrink: moving a walker onto `authoredFiles` removes its line, and a walker
 * anywhere else fails the test below. Follow-up (FU-102): migrate them and drop the lists.
 */
const PRUNE_BY_NAME = [
  'apps/web/src/test/turbo-inputs-guard.ts',
  'packages/contracts/src/events/topic-consumers.repo.spec.ts',
  'packages/nest-common/src/kafka/log-creator.spec.ts',
  'packages/nest-common/src/tenancy/raw-sql-inventory.spec.ts',
  'scripts/check-service-boundaries-lib.mjs',
  'scripts/eligibility-clock-derive.mjs',
  'scripts/url-parsing-guard-lib.mjs',
  'services/audit-service/test/authorization.int-spec.ts',
  'services/construction-service/src/shared/idempotency-forget.spec.ts',
  'services/identity-service/src/prisma/transaction-boundary.spec.ts',
];
const NO_GENERATED_TREE = [
  'apps/web/src/app/select-reset.spec.tsx',
  'apps/web/src/app/suppliers/supplier-persian.spec.tsx',
  'apps/web/src/app/theme-switch-coverage.spec.tsx',
  'apps/web/src/design-tokens.spec.ts',
  'apps/web/src/e2e-server-reuse.spec.ts',
  'apps/web/src/lib/form-issues.spec.ts',
  'apps/web/src/lib/form-message-trust.spec.ts',
  'apps/web/src/lib/id-hints.spec.ts',
  'apps/web/src/server/page-context.spec.ts',
  'apps/web/src/server/session-organization.spec.ts',
  'apps/web/src/test/fenced-form-guard.ts',
  'apps/web/src/test/module-discovery.ts',
  'apps/web/src/test/orthography-scan.ts',
  'apps/web/src/test/server-action-discovery.ts',
  'apps/web/src/ui/layout/layout-guards.spec.ts',
  'packages/contracts/src/common/__tests__/zod-stock-oracle.ts',
  'packages/contracts/src/common/zod-authorship.spec.ts',
  'packages/observability/src/diagnostics.spec.ts',
  'scripts/aggregation-campaign-accounting.test.mjs',
  'scripts/aggregation-campaign-command-card.test.mjs',
  'scripts/aggregation-campaign-image-cohort.test.mjs',
  'scripts/aggregation-campaign-log-recovery.test.mjs',
  'scripts/aggregation-campaign-post-run-rehearsal.test.mjs',
  'scripts/aggregation-campaign-retrieval-comparison.test.mjs',
  'scripts/check-dockerfile-pins.mjs',
  'scripts/check-unit-step-concurrency.mjs',
  'scripts/outbox-b2-lib.test.mjs',
];
// Covers generated output ON PURPOSE (the image tree and tool directories) with a race-safe retry;
// its test passes the options through a fault-injecting readdir that makes the race happen.
const COVERS_GENERATED_ON_PURPOSE = [
  'scripts/testing-dev-only.mjs',
  'scripts/testing-dev-only.test.mjs',
];
const PRE_INVENTORY_WALKERS = new Set([
  ...PRUNE_BY_NAME,
  ...NO_GENERATED_TREE,
  ...COVERS_GENERATED_ON_PURPOSE,
]);

const trackedSources = () =>
  execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(
      (file) =>
        /\.(?:[cm]?[jt]sx?)$/.test(file) &&
        file !== INVENTORY &&
        file !== 'scripts/authored-source-inventory.test.mjs',
    );

/** The walkers outside the allow-list: a file not in it, or one with a second walker. */
function unlistedWalkers(found, allowed) {
  return Object.entries(found).flatMap(([file, walkers]) =>
    walkers.length === 1 && allowed.has(file) ? [] : walkers,
  );
}

test('a new recursive directory walker must use the shared inventory', () => {
  const counts = {};
  for (const file of trackedSources()) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!/readdir|opendir|globSync/.test(text)) continue;
    const walkers = recursiveWalkers(file, text);
    if (walkers.length > 0) counts[file] = walkers;
  }
  assert.deepEqual(
    unlistedWalkers(counts, PRE_INVENTORY_WALKERS),
    [],
    'enumerate files with authoredFiles() from scripts/authored-source-inventory.cjs (it never opens ' +
      'generated output, which another task may be regenerating); a walker of your own races with it',
  );
  for (const file of PRE_INVENTORY_WALKERS) {
    assert.ok(
      counts[file],
      `${file} no longer has a recursive walker: remove it from PRE_INVENTORY_WALKERS`,
    );
  }
});

test('the allow-list refuses a walker in an unlisted file and a second walker in a listed one', () => {
  const allowed = new Set(['old.mjs']);
  assert.deepEqual(unlistedWalkers({ 'old.mjs': ['old.mjs:1 w'] }, allowed), []);
  assert.deepEqual(unlistedWalkers({ 'new.mjs': ['new.mjs:1 w'] }, allowed), ['new.mjs:1 w']);
  assert.deepEqual(unlistedWalkers({ 'old.mjs': ['old.mjs:1 w', 'old.mjs:9 v'] }, allowed), [
    'old.mjs:1 w',
    'old.mjs:9 v',
  ]);
});

test('the detector sees each walker shape and ignores a one-level listing', () => {
  const sees = (code) => recursiveWalkers('x.mjs', code).length;
  assert.equal(sees('readdirSync(d, { recursive: true });'), 1);
  assert.equal(sees('const o = { recursive: true }; readdirSync(d, o);'), 1);
  assert.equal(sees("readdirSync(d, { withFileTypes: true, encoding: 'utf8' });"), 0);
  assert.equal(sees("readdirSync(d, 'utf8');"), 0);
  assert.equal(sees('fs.promises.readdir(d, { recursive: true, withFileTypes: true });'), 1);
  assert.equal(sees("globSync('services/*/src/**/*.ts');"), 1);
  assert.equal(sees('function w(d) { return readdirSync(d).flatMap((n) => w(join(d, n))); }'), 1);
  assert.equal(sees('const w = (d) => readdirSync(d).map((n) => w(n));'), 1);
  assert.equal(sees('function w(d) { return readdirSync(d); }'), 0);
  assert.equal(sees("globSync('services/*/package.json');"), 0);
  assert.equal(recursiveWalkers('x.mjs', 'function (').length, 1);
});

test('the rule is still enforced on the walkers this change converted', () => {
  // A reverted conversion brings back a raw walker in a file that is not in PRE_INVENTORY_WALKERS.
  for (const file of [
    'scripts/disclosure-guard-wiring.test.mjs',
    'scripts/db-pool-config.pg.test.mjs',
    'scripts/service-boot-guard.test.mjs',
    'scripts/check-test-phases.mjs',
    'scripts/outbox-test-clock.test.mjs',
    'scripts/verify-migration-reversible-lib.test.mjs',
    'packages/contracts/src/common/legacy-refusal-boundary.spec.ts',
    'packages/contracts/src/common/zod-compat-patch.spec.ts',
    'services/audit-service/test/append-only.int-spec.ts',
    'services/procurement-service/src/shared/body-parser.spec.ts',
  ]) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.match(text, /authored-source-inventory\.cjs/, `${file} does not use the inventory`);
    assert.deepEqual(recursiveWalkers(file, text), [], `${file} has a walker of its own`);
  }
});

test('the walkers that prune by name do prune generated output, and the inventory hides no tracked file', () => {
  for (const file of PRUNE_BY_NAME) {
    assert.match(
      readFileSync(join(root, file), 'utf8'),
      /['"]generated['"]/,
      `${file} does not prune generated`,
    );
  }
  // Skipping these directories is only safe while nothing authored lives in one.
  const hidden = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter((file) => file.split('/').some((part) => NOT_AUTHORED_DIRECTORIES.includes(part)));
  assert.deepEqual(hidden, [], 'a tracked file sits in a directory the inventory never opens');
  // ...and the inventory knows every directory .gitignore keeps out of the repository, so the next
  // ignored output directory is a deliberate decision here and not a new race.
  const ignored = readFileSync(join(root, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => /^(?:\*\*\/src\/)?([\w.-]+)\/$/.exec(line)?.[1])
    .filter(Boolean);
  assert.ok(ignored.includes('generated') && ignored.length >= 10, 'no ignored directories found');
  assert.deepEqual(
    ignored.filter((name) => !NOT_AUTHORED_DIRECTORIES.includes(name)),
    [],
  );
});
