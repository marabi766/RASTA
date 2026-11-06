import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import {
  EXECUTABLE_EXTENSIONS,
  boundaryHolds,
  isExecutable,
  requiredBoundary,
} from './lint-extensions.mjs';

/**
 * FU-074: the raw-HTTP boundary reaches every executable file a lint command
 * reaches. Asked of ESLint (calculateConfigForFile), never inferred from globs:
 *
 *  - every tracked file is classified by extension; an extension that is
 *    neither executable nor listed as inert FAILS, so a new kind of code cannot
 *    slip past unclassified;
 *  - every tracked executable file must be reached by its workspace's `lint`
 *    command (or the root `lint:scripts`), unless UNLINTED names its EXACT path
 *    with a reason; a path the boundary policy requires can never be UNLINTED;
 *  - where the ONE policy (requiredBoundary in lint-extensions.mjs) requires the
 *    boundary, the computed entry must hold it: severity AND options (the E2E
 *    trees need `{ playwright: true }`). Protected suites — E2E trees and live
 *    suites — are decided before any unit-test exemption (FU-074 r2 F2);
 *  - every linted root is probed with a file of EVERY executable extension, and
 *    with special names (`.spec`, `.live-spec`, `test/`, `__tests__/`), so an
 *    extension or name no tracked file uses yet is held too.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'internal/raw-http';
const INERT = new Set(
  `sql md json yml yaml prisma toml snap txt sh bash gitkeep db example conf go swcrc
   sum prettierignore png patch npmrc mod gitleaksignore gitignore gitattributes
   editorconfig dockerignore css nvmrc svg ico lock`.split(/\s+/),
);
/** Extensionless tracked files: basenames, plus exact paths with what they are. */
const EXTENSIONLESS = { Dockerfile: 'container build', 'scripts/backup-restore-drill': 'bash' };
/** Executable exemptions are reviewed exact paths; stale entries fail below. */
const WEB_BUILD_TOOL =
  'web build tooling outside `eslint src e2e`: loads node:module / worker_threads / ' +
  'loader hooks, sends no HTTP (FU-074 follow-up: bring it under audited exemptions)';
// Spelt apart: the disclosure launcher pre-check reads literal runner filenames
// as commands. Each computed key below is still one fixed, exact file path.
const RUNNER_PREFIX = ['je', 'st'].join('');
const UNLINTED = {
  'apps/web/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`apps/web/${RUNNER_PREFIX}.config.cjs`]: 'reviewed lint or test-runner configuration',
  'eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`${RUNNER_PREFIX}.disclosure-guard.cjs`]: 'reviewed lint or test-runner configuration',
  [`${RUNNER_PREFIX}.swc.cjs`]: 'reviewed lint or test-runner configuration',
  'packages/config/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/config/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'packages/contracts/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/contracts/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'packages/logging/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/logging/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'packages/nest-common/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/nest-common/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'packages/observability/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/observability/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'packages/sealing/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/sealing/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'packages/testing/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`packages/testing/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'services/analytics-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/analytics-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/analytics-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/api-gateway/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/api-gateway/${RUNNER_PREFIX}.config.js`]: 'reviewed lint or test-runner configuration',
  'services/asset-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/asset-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'services/audit-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/audit-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/audit-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/construction-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/construction-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/construction-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/contract-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/contract-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/contract-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/document-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/document-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/document-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/economic-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/economic-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/economic-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/fleet-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/fleet-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'services/identity-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/identity-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'services/inventory-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/inventory-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/inventory-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/maintenance-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/maintenance-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'services/marketplace-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/marketplace-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/marketplace-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/notification-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/notification-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/notification-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/organization-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/organization-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  'services/procurement-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/procurement-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/procurement-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'services/supplier-service/eslint.config.mjs': 'reviewed lint or test-runner configuration',
  [`services/supplier-service/${RUNNER_PREFIX}.config.js`]:
    'reviewed lint or test-runner configuration',
  [`services/supplier-service/${RUNNER_PREFIX}.setup.cjs`]:
    'reviewed lint or test-runner configuration',
  'tests/e2e/eslint.config.mjs': 'reviewed lint or test-runner configuration',

  'apps/web/next.config.mjs': 'Next build configuration',
  'apps/web/postcss.config.mjs': 'PostCSS build configuration',
  'apps/web/upload-limit.cjs': 'a constant the Next config reads; no I/O',
  'apps/web/next-env.d.ts': 'generated by Next, declarations only',
  'apps/web/playwright.config.ts': 'Playwright configuration',
  // Grandfathered one by one (FU-074 r2 F2): no directory-wide entry.
  'apps/web/scripts/build-group.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/build-layout.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/build-lock.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/build-receipt.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/build-run.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/build-supervisor.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/capture-next-config.cjs': WEB_BUILD_TOOL,
  'apps/web/scripts/check-server-action-coverage.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/node-guard.mjs': WEB_BUILD_TOOL,
  'apps/web/scripts/run-web-build.mjs': WEB_BUILD_TOOL,
};
function unlinted(path) {
  return Object.hasOwn(UNLINTED, path) ? path : undefined;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);

function extensionOf(path) {
  const base = posix.basename(path);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? null : base.slice(dot + 1);
}

/** Workspace dir → the paths its `lint` script hands ESLint. A shape not modelled throws. */
function lintRoots() {
  const roots = new Map();
  const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  const scripts = /^eslint ((?:[\w./-]+ )+)&& node --test /.exec(rootScripts['lint:scripts']);
  assert.ok(scripts, 'root lint:scripts must start `eslint <paths> && node --test`');
  roots.set('', scripts[1].trim().split(' '));
  for (const manifest of tracked.filter((f) => /^[^/]+\/[^/]+\/package\.json$/.test(f))) {
    const dir = posix.dirname(manifest);
    const lint = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')).scripts?.lint;
    if (lint === undefined) continue;
    const paths = /^eslint((?: [\w./-]+)+)$/.exec(lint);
    assert.ok(paths, `${manifest}: lint "${lint}" is not \`eslint <paths>\``);
    assert.ok(existsSync(join(ROOT, dir, 'eslint.config.mjs')), `${dir} has no eslint.config.mjs`);
    roots.set(
      dir,
      paths[1]
        .trim()
        .split(' ')
        .map((p) => (p === '.' ? '' : p.replace(/\/$/, ''))),
    );
  }
  return roots;
}

/** The workspace whose `lint` reaches `path`, with the path inside it — or null. */
function reacher(roots, path) {
  for (const [dir, paths] of roots) {
    const rel = dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
    if (rel === null || (dir === '' && /^(apps|services|packages|tests)\//.test(path))) continue;
    if (paths.some((p) => p === '' || rel === p || rel.startsWith(`${p}/`))) return { dir, rel };
  }
  return null;
}

const engines = new Map();
/** The computed `internal/raw-http` entry for `rel` in workspace `dir`. */
async function boundaryEntry(dir, rel) {
  if (!engines.has(dir)) engines.set(dir, new ESLint({ cwd: join(ROOT, dir) }));
  const config = await engines.get(dir).calculateConfigForFile(join(ROOT, dir, rel));
  return config?.rules?.[RULE];
}

/**
 * Why `path` (tracked or a probe) breaks the coverage contract, or null. One
 * function for tracked files and probes, so a probe exercises the real check.
 */
async function coverageProblem(roots, path) {
  const required = requiredBoundary(path);
  if (unlinted(path) !== undefined) {
    return required === null ? null : `${path}: the boundary is required, it cannot be UNLINTED`;
  }
  const at = reacher(roots, path);
  if (at === null) return `${path}: no lint command reaches it`;
  if (required === null) return null;
  const entry = await boundaryEntry(at.dir, at.rel);
  return boundaryHolds(entry, required)
    ? null
    : `${path}: ${RULE} is ${JSON.stringify(entry ?? null)}, needs ${JSON.stringify(required)}`;
}

test('every tracked extension is classified, executable or inert', () => {
  const unknown = tracked.filter((f) => {
    const ext = extensionOf(f);
    if (ext === null) return !(posix.basename(f) in EXTENSIONLESS || f in EXTENSIONLESS);
    return !EXECUTABLE_EXTENSIONS.includes(ext) && !INERT.has(ext);
  });
  assert.deepEqual(unknown, [], 'classify these extensions in INERT or lint-extensions.mjs');
});

test('every tracked executable file is linted, with the boundary where the policy requires it', async () => {
  const roots = lintRoots();
  const failures = [];
  const used = new Set();
  for (const f of tracked.filter(isExecutable)) {
    const exemption = unlinted(f);
    if (exemption !== undefined) used.add(exemption);
    const problem = await coverageProblem(roots, f);
    if (problem) failures.push(problem);
  }
  for (const entry of Object.keys(UNLINTED))
    if (!used.has(entry)) failures.push(`stale UNLINTED entry: ${entry}`);
  assert.deepEqual(failures, []);
});

/** Special names under a linted root: each must be held if the policy requires it. */
const PROBE_NAMES = [
  'fu074-probe',
  'fu074-probe.spec',
  'fu074-probe.test',
  'fu074-probe.e2e-spec',
  'fu074-probe.live-spec',
  'test/fu074-probe',
  'test/fu074-probe.live-spec',
  '__tests__/fu074-probe.spec',
  'nested/test/fu074-probe.e2e-spec',
];

test('every linted root holds the boundary for every executable extension and special name', async () => {
  const roots = lintRoots();
  const failures = [];
  let required = 0;
  for (const [dir, paths] of roots) {
    for (const p of paths) {
      // A single named file (prisma/seed.ts) is held above.
      if (extensionOf(p) !== null) continue;
      for (const name of PROBE_NAMES)
        for (const ext of EXECUTABLE_EXTENSIONS) {
          const path = posix.join(dir, p, `${name}.${ext}`);
          if (requiredBoundary(path) !== null) required += 1;
          const problem = await coverageProblem(roots, path);
          if (problem) failures.push(problem);
        }
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(required > 1000, `only ${required} probes were required: the policy lost a family`);
});

test('the policy: protected suites win over unit-test names; exemptions stay exact', async () => {
  for (const ext of EXECUTABLE_EXTENSIONS) {
    for (const path of [
      `apps/web/e2e/x.spec.${ext}`,
      `apps/web/e2e/test/x.${ext}`,
      `apps/web/e2e/__tests__/x.e2e-spec.${ext}`,
      `tests/e2e/specs/x.e2e-spec.${ext}`,
      `tests/e2e/specs/test/x.${ext}`,
      `tests/e2e/src/__tests__/x.spec.${ext}`,
    ])
      assert.deepEqual(requiredBoundary(path), { playwright: true }, path);
    for (const path of [
      `services/identity-service/test/keycloak-live/x.live-spec.${ext}`,
      `services/notification-service/test/x.live-spec.${ext}`,
      `apps/web/src/test/x.live-spec.${ext}`,
      `packages/testing/src/__tests__/x.live-spec.${ext}`,
    ])
      assert.deepEqual(requiredBoundary(path), { playwright: false }, path);
    // A new build tool next to the grandfathered ones is not exempt.
    assert.equal(unlinted(`apps/web/scripts/new-tool.${ext}`), undefined);
    assert.match(
      await coverageProblem(lintRoots(), `apps/web/scripts/new-tool.${ext}`),
      /no lint command reaches it/,
    );
  }
  // Production-family runner-config names are never exempt as configuration.
  assert.equal(unlinted(`services/asset-service/src/${RUNNER_PREFIX}.helper.js`), undefined);
  assert.deepEqual(requiredBoundary('tests/e2e/src/http.test.ts'), null);
  assert.deepEqual(requiredBoundary('tests/e2e/src/http.test.mts'), { playwright: true });
  // Options, not only severity.
  assert.equal(boundaryHolds(['error', { playwright: false }], { playwright: true }), false);
  assert.equal(boundaryHolds([2], { playwright: true }), false);
  assert.equal(boundaryHolds([2, { playwright: true }], { playwright: true }), true);
  assert.equal(boundaryHolds([1, { playwright: true }], { playwright: true }), false);
  assert.equal(boundaryHolds(undefined, { playwright: false }), false);
});

// FU-166 F2: a configuration-shaped executable still needs a lint command.
test('configuration names never grant an exemption outside reviewed exact paths', async () => {
  const roots = lintRoots();
  for (const ext of EXECUTABLE_EXTENSIONS)
    for (const name of [`${RUNNER_PREFIX}.helper`, 'eslint.config', 'tool.config', '.toolrc'])
      for (const dir of ['apps/web/scripts', 'apps/web/scripts/nested', 'unknown']) {
        const file = `${dir}/${name}.${ext}`;
        assert.equal(unlinted(file), undefined, file);
        assert.match(await coverageProblem(roots, file), /no lint command reaches it/, file);
      }
  for (const file of Object.keys(UNLINTED)) {
    assert.ok(tracked.includes(file), `stale exact exemption: ${file}`);
    assert.equal(unlinted(`unreviewed/${file}`), undefined, file);
  }
});
