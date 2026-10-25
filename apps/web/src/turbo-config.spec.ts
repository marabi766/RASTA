/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  declaredTestInputs,
  filesMatching,
  globToRegExp,
  isDeclared,
  isOutsideInput,
  matchesGlob,
  undeclaredReads,
} from './test/turbo-inputs-guard';

/**
 * `apps/web/turbo.json`'s test inputs, and the guard that keeps them honest
 * (`test/turbo-inputs-guard.ts`).
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const abs = (relative: string) => path.join(REPO_ROOT, relative);

function inputsOf(task: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, 'apps/web/turbo.json'), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  );
  const config = JSON.parse(text) as { tasks: Record<string, { inputs: string[] }> };
  return config.tasks[task]!.inputs;
}

describe('apps/web/turbo.json test inputs', () => {
  it('are the same for `test` and `test:unit`, so which script runs cannot change what is hashed', () => {
    expect(inputsOf('test:unit')).toEqual(inputsOf('test'));
  });

  it('keep the default inputs and name only patterns that match a file, under the repository root', () => {
    const inputs = inputsOf('test');
    expect(inputs[0]).toBe('$TURBO_DEFAULT$');
    for (const entry of inputs.slice(1)) {
      expect(entry.startsWith('$TURBO_ROOT$/')).toBe(true);
      const matched = filesMatching(entry.slice('$TURBO_ROOT$/'.length)).length;
      expect([entry, matched > 0]).toEqual([entry, true]);
    }
  });

  it('have no duplicates', () => {
    const inputs = inputsOf('test');
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});

describe('the guard', () => {
  const declared = declaredTestInputs();

  it('reads the declared inputs as repository-relative patterns', () => {
    expect(declared).toContain('services/asset-service/src/**');
    expect(declared).toContain('services/construction-service/prisma/schema.prisma');
  });

  it('passes a file that is named, and files that are not inputs at all', () => {
    expect(
      undeclaredReads([
        abs('services/asset-service/src/asset/dto.ts'),
        abs('services/asset-service/src/a-file-added-later/new.ts'),
        abs('services/construction-service/prisma/schema.prisma'),
        abs('apps/web/src/lib/labels.ts'),
        abs('node_modules/zod/index.js'),
        abs('packages/contracts/dist/index.js'),
        abs('packages/contracts/package.json'),
        '/usr/lib/node/some.js',
      ]),
    ).toEqual([]);
  });

  it('is live: a file outside this package that is not named is reported', () => {
    // A negative control — a check that can only pass proves nothing.
    expect(
      undeclaredReads([
        abs('services/asset-service/src/asset/dto.ts'),
        abs('services/identity-service/src/auth/NOT-LISTED.ts'),
        abs('packages/logging/src/index.ts'),
        abs('services/construction-service/prisma/other.prisma'),
      ]),
    ).toEqual([
      'packages/logging/src/index.ts',
      'services/construction-service/prisma/other.prisma',
      'services/identity-service/src/auth/NOT-LISTED.ts',
    ]);
  });

  it('classifies what the cache must know about', () => {
    expect(isOutsideInput(abs('services/x/src/a.ts'))).toBe(true);
    expect(isOutsideInput(abs('apps/web/src/a.ts'))).toBe(false);
    expect(isOutsideInput(abs('services/x/dist/a.js'))).toBe(false);
    expect(isOutsideInput(abs('services/x/node_modules/y/a.js'))).toBe(false);
    expect(isOutsideInput(abs('services/x/package.json'))).toBe(false);
    expect(isOutsideInput('/elsewhere/a.ts')).toBe(false);
  });

  it('matches globs: `**` crosses directories, `*` and `?` stay in one segment, a plain path is exact', () => {
    expect(isDeclared(abs('a/b/c.ts'), ['a/b/**'])).toBe(true);
    expect(isDeclared(abs('a/b/c/d.ts'), ['a/b/**'])).toBe(true);
    expect(isDeclared(abs('a/bb/c.ts'), ['a/b/**'])).toBe(false);
    expect(isDeclared(abs('a/b/c.ts'), ['a/b/c.ts'])).toBe(true);
    expect(isDeclared(abs('a/b/c.tsx'), ['a/b/c.ts'])).toBe(false);
    expect(matchesGlob('a/b/c.ts', 'a/*/c.ts')).toBe(true);
    expect(matchesGlob('a/b/x/c.ts', 'a/*/c.ts')).toBe(false);
    expect(matchesGlob('a/b/x/c.ts', 'a/**/c.ts')).toBe(true);
    expect(matchesGlob('a/c.ts', 'a/**/c.ts')).toBe(true);
    expect(matchesGlob('a/b/c.ts', 'a/b/?.ts')).toBe(true);
    expect(globToRegExp('a.b/**').test('aXb/c')).toBe(false);
  });

  it('finds the files a pattern matches, and none for a pattern that matches nothing', () => {
    expect(filesMatching('services/asset-service/src/**').length).toBeGreaterThan(0);
    expect(filesMatching('services/construction-service/prisma/schema.prisma')).toEqual([
      'services/construction-service/prisma/schema.prisma',
    ]);
    expect(filesMatching('services/asset-service/src/no-such-dir/**')).toEqual([]);
    expect(filesMatching('services/asset-service/NOT-A-FILE.ts')).toEqual([]);
  });
});
