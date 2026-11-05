'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: Jest specs and .mjs checks share it */
// The one way a check enumerates the files this repository AUTHORS (FU-102).
//
// Git-ignored output (`generated` Prisma clients, `node_modules`, build output) is rewritten by
// other tasks while a check runs: a directory listed a moment ago can be gone (ENOENT) before it
// is read. A check that walked it died on a file nobody wrote. The inventory never OPENS such a
// directory, so there is nothing to race. Everything it does list is authored, so a listed file
// or directory that is then missing is a real fault and still throws. CommonJS so Jest specs
// (`require`) and the `.mjs` checks (`import`) share it.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Directory names that hold build output, generated code, dependencies or editor/runtime state, at
 * any depth: the directory patterns of .gitignore (the test pins that they agree). Never opened.
 */
const NOT_AUTHORED_DIRECTORIES = Object.freeze([
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
  '.nyc_output',
  'test-results',
  'playwright-report',
  'generated',
  'logs',
  '.idea',
  '.docker-data',
  '.git',
]);

const pruned = (name, skip) =>
  NOT_AUTHORED_DIRECTORIES.includes(name) || (typeof skip === 'function' ? skip(name) : false);

/**
 * Absolute paths of every authored file under `dir`, sorted. `skip(name)` prunes further
 * directories (and files) by name before they are opened. `optional` lets a `dir` that does not
 * exist yield [] (a workspace without `src`); anything else that cannot be read throws.
 */
function authoredFiles(dir, { skip, optional = false } = {}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => !pruned(entry.name, skip))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? authoredFiles(path, { skip }) : [path];
    });
}

module.exports = { NOT_AUTHORED_DIRECTORIES, authoredFiles };
