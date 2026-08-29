import base from '../../eslint.config.mjs';

/**
 * The shared rules, plus this package's own generated output.
 *
 * `playwright-report/` and `test-results/` appear the moment anybody runs the
 * suite. They hold a bundled browser application and trace attachments — tens
 * of thousands of lines of minified third-party code — so linting them
 * produces thousands of `no-undef` errors about `document` and `navigator` and
 * buries anything real. Both are gitignored; this keeps `pnpm lint` usable on
 * a machine that has actually run the tests.
 */
export default [{ ignores: ['playwright-report/**', 'test-results/**'] }, ...base];
