import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkSource,
  extractSpecifiers,
  formatViolation,
  lineOf,
  resolveTarget,
  scanRepository,
  serviceOf,
  stripComments,
} from './check-service-boundaries-lib.mjs';

/**
 * A throwaway repository: two services with manifests, one shared package.
 * Every test that touches the filesystem builds its own and removes it.
 */
function fixtureRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rasta-boundaries-'));
  const write = (path, content) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write(
    'services/identity-service/package.json',
    JSON.stringify({ name: '@rasta/identity-service' }),
  );
  write('services/audit-service/package.json', JSON.stringify({ name: '@rasta/audit-service' }));
  write('packages/contracts/package.json', JSON.stringify({ name: '@rasta/contracts' }));
  write('services/identity-service/src/main.ts', 'export const main = 1;\n');
  write(
    'services/audit-service/src/audit/audit.repository.ts',
    'export class AuditRepository {}\n',
  );
  for (const [path, content] of Object.entries(files)) write(path, content);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const PACKAGES = new Map([
  ['@rasta/identity-service', 'identity-service'],
  ['@rasta/audit-service', 'audit-service'],
]);

/** Violations for one source string placed at `path` inside a virtual repo root. */
function violationsIn(source, path = 'services/identity-service/test/x.int-spec.ts') {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  return checkSource({
    repoRoot: root,
    file: join(root, path),
    source,
    packageToService: PACKAGES,
  });
}

// ---------------------------------------------------------------------------
// The violation this checker was written for
// ---------------------------------------------------------------------------

test('catches every import the Phase C1 identity test made into audit-service', () => {
  const source = [
    "import { PrismaService as AuditPrismaService } from '../../audit-service/src/prisma/prisma.service';",
    "import { AuditRepository } from '../../audit-service/src/audit/audit.repository';",
    "import { AuditTrailConsumer } from '../../audit-service/src/consumers/audit-trail.consumer';",
    "import { AUDIT_DEAD_LETTER_TOPIC } from '../../audit-service/src/audit/audit.mapper';",
    "import { AUDIT_TRAIL_CONSUMER } from '../../audit-service/src/audit/audit-trail.mapper';",
    'import {',
    '  cleanupRun,',
    '  waitFor,',
    "} from '../../audit-service/test/helpers';",
  ].join('\n');

  const found = violationsIn(source);
  assert.equal(found.length, 6);
  assert.deepEqual(
    found.map((violation) => violation.line),
    [1, 2, 3, 4, 5, 9],
  );
  for (const violation of found) {
    assert.equal(violation.owner, 'identity-service');
    assert.equal(violation.service, 'audit-service');
  }
  assert.equal(found[5].target, 'services/audit-service/test/helpers');
});

// ---------------------------------------------------------------------------
// Forms that must be caught
// ---------------------------------------------------------------------------

test('catches every syntactic form that loads a module', () => {
  const forms = {
    'default import': "import x from '../../audit-service/src/a';",
    'side-effect import': "import '../../audit-service/src/a';",
    'type-only import': "import type { A } from '../../audit-service/src/a';",
    'namespace import': "import * as a from '../../audit-service/src/a';",
    'mixed import': "import A, { type B } from '../../audit-service/src/a';",
    're-export': "export { a } from '../../audit-service/src/a';",
    'star re-export': "export * from '../../audit-service/src/a';",
    'namespaced re-export': "export * as a from '../../audit-service/src/a';",
    'type re-export': "export type { A } from '../../audit-service/src/a';",
    'dynamic import': "const a = await import('../../audit-service/src/a');",
    'template dynamic import': 'const a = await import(`../../audit-service/src/a`);',
    require: "const a = require('../../audit-service/src/a');",
    'require.resolve': "require.resolve('../../audit-service/src/a');",
    'import equals require': "import a = require('../../audit-service/src/a');",
    'jest.mock': "jest.mock('../../audit-service/src/a');",
    'jest.requireActual': "jest.requireActual('../../audit-service/src/a');",
    'jest.doMock': "jest.doMock('../../audit-service/src/a', () => ({}));",
    'double quotes': 'import x from "../../audit-service/src/a";',
  };
  for (const [label, source] of Object.entries(forms)) {
    assert.equal(violationsIn(source).length, 1, `${label} was not caught: ${source}`);
  }
});

test('catches absolute, file-URL, bare repository and workspace-package forms', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const absolute = join(root, 'services', 'audit-service', 'src', 'a');
  const forms = [
    `import x from '${absolute.replace(/\\/g, '/')}';`,
    `import x from '${pathToFileURL(absolute).href}';`,
    "import x from 'services/audit-service/src/a';",
    "import x from '/services/audit-service/src/a';",
    "import x from '@rasta/audit-service';",
    "import x from '@rasta/audit-service/src/audit/audit.repository';",
    "import x from '@rasta/audit-service/dist/main';",
  ];
  for (const source of forms) {
    assert.equal(violationsIn(source).length, 1, `not caught: ${source}`);
  }
});

test('a path into any part of another service is refused, not only src', () => {
  for (const target of ['test/helpers', 'prisma/seed', 'src/generated/prisma', 'dist/main']) {
    const found = violationsIn(`import x from '../../audit-service/${target}';`);
    assert.equal(found.length, 1, target);
    assert.equal(found[0].target, `services/audit-service/${target}`);
  }
});

test('a path that leaves the service and comes back into another is caught', () => {
  const source = "import x from '../src/../../../services/audit-service/src/a';";
  assert.equal(violationsIn(source).length, 1);
});

// ---------------------------------------------------------------------------
// Forms that must not be flagged
// ---------------------------------------------------------------------------

test('allows imports within the same service, from test into src and back', () => {
  const source = [
    "import { AppModule } from '../src/app.module';",
    "import { helper } from './helpers';",
    "import { PrismaService } from '../../identity-service/src/prisma/prisma.service';",
    "import x from 'services/identity-service/src/main';",
    "import self from '@rasta/identity-service';",
  ].join('\n');
  assert.deepEqual(violationsIn(source), []);
});

test('allows shared packages, dependencies and node built-ins', () => {
  const source = [
    "import { AUDIT_TRAIL_TOPIC } from '@rasta/contracts';",
    "import { OutboxRelay } from '@rasta/nest-common';",
    "import { x } from '../../../packages/contracts/src/index';",
    "import { Kafka } from 'kafkajs';",
    "import { readFileSync } from 'node:fs';",
    "import request from 'supertest';",
  ].join('\n');
  assert.deepEqual(violationsIn(source), []);
});

test('ignores imports that appear only in comments', () => {
  const source = [
    '// import { AuditRepository } from "../../audit-service/src/audit/audit.repository";',
    '/*',
    " * import x from '../../audit-service/src/a';",
    " * jest.mock('../../audit-service/src/a');",
    ' */',
    "const text = 'a // not a comment';",
    'export const ok = 1;',
  ].join('\n');
  assert.deepEqual(violationsIn(source), []);
});

test('a comment marker inside a string does not hide the next line', () => {
  const source = [
    "const url = 'http://example.invalid/*';",
    "import x from '../../audit-service/src/a';",
  ].join('\n');
  const found = violationsIn(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('template substitutions are code, and their comments are stripped', () => {
  const source = [
    'const s = `${ /* import x from "../../audit-service/src/a" */ 1 }`;',
    'const t = `${ require("../../audit-service/src/b") }`;',
  ].join('\n');
  const found = violationsIn(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].specifier, '../../audit-service/src/b');
});

test('a file outside every service package is never checked', () => {
  const source = "import x from '../services/audit-service/src/a';";
  assert.deepEqual(violationsIn(source, 'scripts/tool.mjs'), []);
  assert.deepEqual(violationsIn(source, 'tests/e2e/src/x.ts'), []);
});

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

test('stripComments keeps offsets and newlines', () => {
  const source = 'a /* b\n c */ d // e\nf';
  const stripped = stripComments(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.match(stripped, /^a\s+d\s+\nf$/);
});

test('extractSpecifiers returns specifiers in source order with their positions', () => {
  const source = "import b from 'b';\nconst a = require('a');";
  const found = extractSpecifiers(source);
  assert.deepEqual(
    found.map((entry) => entry.specifier),
    ['b', 'a'],
  );
  assert.equal(lineOf(source, found[1].index), 2);
});

test('serviceOf names the owning service directory', () => {
  assert.equal(serviceOf('services/identity-service/test/x.ts'), 'identity-service');
  assert.equal(serviceOf('services/audit-service'), 'audit-service');
  assert.equal(serviceOf('packages/contracts/src/index.ts'), null);
});

test('resolveTarget ignores an unrelated scoped package', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  assert.equal(
    resolveTarget({
      repoRoot: root,
      fromFile: join(root, 'services/identity-service/src/a.ts'),
      specifier: '@nestjs/common',
      packageToService: PACKAGES,
    }),
    null,
  );
});

test('formatViolation reads as file:line and names both services', () => {
  const [violation] = violationsIn("import x from '../../audit-service/src/a';");
  assert.equal(
    formatViolation(violation),
    "services/identity-service/test/x.int-spec.ts:1  identity-service imports '../../audit-service/src/a' " +
      '→ services/audit-service/src/a (inside audit-service)',
  );
});

// ---------------------------------------------------------------------------
// The repository walk
// ---------------------------------------------------------------------------

test('scanRepository finds a violation in a test file and ignores build output and node_modules', () => {
  const { root, cleanup } = fixtureRepo({
    'services/identity-service/test/flow.int-spec.ts':
      "import { AuditRepository } from '../../audit-service/src/audit/audit.repository';\n",
    'services/identity-service/dist/leftover.js': "require('../../audit-service/src/a');\n",
    'services/identity-service/node_modules/x/index.js':
      "require('../../../../audit-service/src/a');\n",
    'services/identity-service/src/generated/prisma/index.js':
      "require('../../../../audit-service/src/a');\n",
    'services/audit-service/test/helpers.ts':
      "import { AuditRepository } from '../src/audit/audit.repository';\n",
  });
  try {
    const result = scanRepository(root);
    assert.equal(result.services, 2);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'services/identity-service/test/flow.int-spec.ts');
    assert.equal(result.violations[0].line, 1);
  } finally {
    cleanup();
  }
});

test('scanRepository resolves workspace package names from each service manifest', () => {
  const { root, cleanup } = fixtureRepo({
    'services/audit-service/test/peek.ts':
      "import { main } from '@rasta/identity-service/src/main';\n",
  });
  try {
    const result = scanRepository(root);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].owner, 'audit-service');
    assert.equal(result.violations[0].service, 'identity-service');
  } finally {
    cleanup();
  }
});

test('scanRepository passes a repository whose services talk only through packages', () => {
  const { root, cleanup } = fixtureRepo({
    'services/identity-service/test/ok.int-spec.ts': "import { x } from '@rasta/contracts';\n",
    'services/audit-service/test/ok.int-spec.ts':
      "import { AuditRepository } from '../src/audit/audit.repository';\n",
  });
  try {
    const result = scanRepository(root);
    assert.deepEqual(result.violations, []);
    assert.ok(result.scanned >= 4);
  } finally {
    cleanup();
  }
});
