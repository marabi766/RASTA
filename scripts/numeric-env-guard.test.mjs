import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { authoredFiles } from './authored-source-inventory.cjs';
import {
  FROZEN_RATCHET, numericCoercions, checkNumericEnv, ratchetGrowth, readRatchet,
} from './numeric-env-guard.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GUARD = 'scripts/numeric-env-guard.mjs';
const scope = (path) => /^services\/[^/]+\/src\/config\/env\.ts$/.test(path) ||
  /^packages\/config\/.*\.(?:[cm]?[jt]sx?)$/.test(path);

test('repository numeric env parsers obey the exact frozen ratchet', () => {
  const files = authoredFiles(ROOT).map((path) => relative(ROOT, path)).filter(scope);
  assert.ok(files.includes('packages/config/src/env.ts') && files.length >= 17);
  assert.deepEqual(checkNumericEnv(files.map((path) => [path, readFileSync(`${ROOT}${path}`, 'utf8')])), []);
});

test('the ratchet cannot grow against the same verified base used by the static-guards step', () => {
  const base = process.env.SERVICE_ENV_WITHHELD_BASE || 'origin/main';
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  git('rev-parse', '--verify', `${base}^{commit}`);
  const listed = git('ls-tree', '--name-only', base, '--', GUARD).trim();
  // The introducing PR is bounded by its base's actual source counts, not an editable allowance.
  const previous = listed ? readRatchet(git('show', `${base}:${GUARD}`)) :
    Object.fromEntries(git('ls-tree', '-r', '--name-only', base, '--', 'services').split('\n')
      .filter((path) => /^services\/[^/]+\/src\/config\/env\.ts$/.test(path))
      .map((path) => [path.split('/')[1], numericCoercions(git('show', `${base}:${path}`)).length]));
  assert.deepEqual(ratchetGrowth(FROZEN_RATCHET, previous), []);
});

test('coercion detection handles syntax variants and ignores inert text', () => {
  for (const source of [
    'const n = z.coerce.number; n()', 'z.coerce\n.number()', "z['coerce']['bigint']()", '(z.coerce.number)()',
    'Number(process.env.PORT)', "parseInt(process['env']['PORT'], 10)",
    'Number.parseInt(process.env.PORT ?? "1", 10)',
  ]) assert.equal(numericCoercions(source).length, 1, source);
  assert.deepEqual(numericCoercions('// z.coerce.number()\nconst s = "Number(process.env.X)";'), []);
  assert.throws(() => numericCoercions('const ='), /unreadable source/);
});

test('both directions: removal requires shrinking, growth/new services/shared coercions refuse', () => {
  const path = 'services/old/src/config/env.ts';
  const old = [[path, 'z.coerce.number()']];
  assert.deepEqual(checkNumericEnv(old, { old: 1 }), []);
  assert.equal(checkNumericEnv([[path, '']], { old: 1 }).length, 1);
  assert.deepEqual(checkNumericEnv([[path, '']], {}), []);
  assert.equal(checkNumericEnv([[path, 'z.coerce.number(); z.coerce.number()']], { old: 1 }).length, 1);
  assert.equal(checkNumericEnv(old, {}).length, 1);
  for (const source of ['z.coerce.bigint()', 'Number(process.env.X)', 'parseInt(process.env.X)'])
    assert.equal(checkNumericEnv([[path, source]], { old: 1 }).length, 1);
  assert.equal(checkNumericEnv([['packages/config/src/env.ts', 'z.coerce.number()']], {}).length, 1);
  assert.equal(ratchetGrowth({ old: 2 }, { old: 1 }).length, 1);
  assert.equal(ratchetGrowth({ new: 1 }, { old: 1 }).length, 1);
  assert.equal(ratchetGrowth({ constructor: 1 }, {}).length, 1);
  assert.deepEqual(ratchetGrowth({}, { old: 1 }), []);
});
