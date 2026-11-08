/**
 * Every file extension ESLint here parses as code (FU-074). Each config block
 * that turns on the raw-HTTP boundary builds its `files` globs from this one
 * list, so no extension can be left out of one block and not another (#676 r2:
 * a `.mts` helper re-exporting `getBuiltinModule` escaped the rule).
 * scripts/raw-http-boundary-coverage.test.mjs asks ESLint for the computed
 * config of every tracked file with one of these extensions, and fails on any
 * tracked extension it does not classify.
 */
export const EXECUTABLE_EXTENSIONS = Object.freeze([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
]);

// `<stem>.{js,mjs,…}`, e.g. code('src/**/*') or code('**/*.live-spec').
export function code(stem) {
  return `${stem}.{${EXECUTABLE_EXTENSIONS.join(',')}}`;
}

const ANY = EXECUTABLE_EXTENSIONS.join('|');
const EXECUTABLE = new RegExp(`\\.(?:${ANY})$`);
/** True when ESLint parses `path` as code here, whatever its extension. */
export const isExecutable = (path) => EXECUTABLE.test(path);

/** The E2E trees: every file in them drives a real stack (PR #492 r1 F2). */
export const E2E_TREE = /^(?:apps\/web\/e2e|tests\/e2e)\//;
/** Live suites aim at an endpoint the environment names (PR #492 r2 F2), wherever they sit. */
const LIVE_SUITE = new RegExp(`\\.live-spec\\.(?:${ANY})$`);
/** Unit tests and their helpers: the boundary is deliberately off for them. */
const UNIT_TEST = [
  /(?:^|\/)(?:test|__tests__)\//,
  new RegExp(`\\.(?:spec|test|int-spec|e2e-spec)\\.(?:${ANY})$`),
];
/** Production families: what a deployed process or a CI script runs. */
const PRODUCTION = /^(?:apps\/web\/src|scripts|(?:services|packages)\/[^/]+\/(?:src|dev|prisma))\//;
/**
 * The two exact E2E-tree files outside the boundary, as tests/e2e/eslint.config.mjs
 * ignores them: its own lint config, and the node:test unit tests of the harness
 * at the top of src/ (they drive the transports against loopback fakes).
 */
const E2E_EXEMPT = /^tests\/e2e\/(?:eslint\.config\.mjs|src\/[^/]+\.test\.ts)$/;

/**
 * The ONE required-protection policy (FU-074 r2 F2) the boundary guards share:
 * what `internal/raw-http` must be for `path`, or null when the boundary is not
 * required there. Protected suites — the E2E trees and live suites, whatever
 * their name or directory — are decided BEFORE any unit-test exemption, so a
 * `.spec`, `test/` or `__tests__/` name never takes them out.
 *
 * @returns {{ playwright: boolean } | null} `playwright: true` — the E2E trees
 *   must also refuse Playwright's raw request contexts.
 */
export function requiredBoundary(path) {
  if (!isExecutable(path)) return null;
  if (E2E_TREE.test(path)) return E2E_EXEMPT.test(path) ? null : { playwright: true };
  if (LIVE_SUITE.test(path)) return { playwright: false };
  if (UNIT_TEST.some((pattern) => pattern.test(path))) return null;
  return PRODUCTION.test(path) ? { playwright: false } : null;
}

/**
 * Does the computed `internal/raw-http` entry hold what `required` asks?
 * Severity alone is not enough: `['error', { playwright: false }]` in an E2E tree
 * lets `page.request.get(...)` through (FU-074 r2 F2).
 */
export function boundaryHolds(entry, required) {
  const [level, options] = Array.isArray(entry) ? entry : [entry];
  if (level !== 2 && level !== 'error') return false;
  return !required.playwright || options?.playwright === true;
}
