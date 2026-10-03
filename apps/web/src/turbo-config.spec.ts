/**
 * @jest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  declaredTestInputs,
  isDeclared,
  isOutsideInput,
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

  it('keep the default inputs and name only files that exist, under the repository root', () => {
    const inputs = inputsOf('test');
    expect(inputs[0]).toBe('$TURBO_DEFAULT$');
    for (const entry of inputs.slice(1)) {
      expect(entry.startsWith('$TURBO_ROOT$/')).toBe(true);
      expect([entry, existsSync(abs(entry.slice('$TURBO_ROOT$/'.length)))]).toEqual([entry, true]);
    }
  });

  it('have no duplicates', () => {
    const inputs = inputsOf('test');
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});

describe('the guard', () => {
  const declared = declaredTestInputs();

  it('reads the declared inputs as repository-relative paths', () => {
    expect(declared).toContain('services/asset-service/src/asset/dto.ts');
    expect(declared).toContain('services/maintenance-service/src/maintenance/dto.ts');
  });

  it('passes a file that is named, and files that are not inputs at all', () => {
    expect(
      undeclaredReads([
        abs('services/asset-service/src/asset/dto.ts'),
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
        abs('services/maintenance-service/src/maintenance/NOT-LISTED.ts'),
        abs('packages/contracts/src/never-listed.ts'),
      ]),
    ).toEqual([
      'packages/contracts/src/never-listed.ts',
      'services/maintenance-service/src/maintenance/NOT-LISTED.ts',
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

  it('matches a directory entry as a prefix and a file entry exactly', () => {
    expect(isDeclared(abs('a/b/c.ts'), ['a/b/**'])).toBe(true);
    expect(isDeclared(abs('a/bb/c.ts'), ['a/b/**'])).toBe(false);
    expect(isDeclared(abs('a/b/c.ts'), ['a/b/c.ts'])).toBe(true);
    expect(isDeclared(abs('a/b/c.tsx'), ['a/b/c.ts'])).toBe(false);
  });
});
