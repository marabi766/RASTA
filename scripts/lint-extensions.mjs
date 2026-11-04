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
