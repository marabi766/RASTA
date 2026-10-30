import { sep } from 'node:path';

/**
 * Whether a repository-relative path is test-only code that no image runs:
 * root tests/, packages/testing, a test/, __tests__/ or e2e/ directory, a
 * spec/test file, or a test runner's own files (`jest.config.js`,
 * `jest.setup.cjs`, `playwright.config.ts`). Everything else is production.
 *
 * The single definition (scripts/testing-dev-only-source.mjs re-exports it).
 * It lives apart, with no loader, because lint rules that production configs
 * import use it too, and the source sweep follows whatever those import.
 */
export function isTestOnlyPath(relPath) {
  const rel = relPath.split(sep).join('/');
  if (/^(tests|packages\/testing)\//.test(rel)) return true;
  if (/(^|\/)(test|__tests__|e2e)\//.test(rel)) return true;
  if (/(^|\/)(jest|playwright)\.[\w.-]+\.[cm]?[jt]s$/.test(rel)) return true;
  return /\.(spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(rel);
}
