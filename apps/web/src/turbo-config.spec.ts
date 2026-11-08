/**
 * @jest-environment node
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

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

/**
 * Every file the portal's ESLint config loads, by its import closure (PR-949 F3): what a spec
 * that runs ESLint (`write-classifier.guard.spec`) depends on. A local file that cannot be
 * resolved, or a workspace package, is reported too: not walked is not proven declared.
 */
function lintConfigClosure(entry: string): { files: string[]; unproven: string[] } {
  const files = new Set<string>();
  const unproven: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of importedFiles) {
      if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
      if (/^\.\.?\//.test(specifier)) {
        const target = path.resolve(path.dirname(file), specifier);
        if (existsSync(target)) pending.push(realpathSync(target));
        else unproven.push(`${file}: ${specifier} resolves to no file`);
        continue;
      }
      const name = specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');
      let dir = path.dirname(file);
      while (!existsSync(path.join(dir, 'node_modules', name)) && dir !== path.dirname(dir))
        dir = path.dirname(dir);
      const installed = path.join(dir, 'node_modules', name);
      if (
        !existsSync(installed) ||
        !realpathSync(installed).includes(`${path.sep}node_modules${path.sep}`)
      )
        unproven.push(`${file}: ${specifier} is not an installed package`);
    }
  }
  return { files: [...files], unproven };
}

describe('the ESLint config a spec runs (PR-949 F3)', () => {
  it('is a test input in every file it loads, so a new rule helper cannot replay a cached green', () => {
    const { files, unproven } = lintConfigClosure(
      path.join(REPO_ROOT, 'apps/web/eslint.config.mjs'),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(unproven).toEqual([]);
    const declared = declaredTestInputs();
    const missing = files.filter((file) => isOutsideInput(file) && !isDeclared(file, declared));
    expect(missing.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
  });

  it('is live: a helper a rule loads is in the closure, and an unknown one is reported', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-closure-'));
    try {
      writeFileSync(path.join(root, 'config.mjs'), "import r from './rule.mjs';\nimport 'x-none';");
      writeFileSync(
        path.join(root, 'rule.mjs'),
        "import { h } from './helper.mjs';\nimport('./gone.mjs');",
      );
      writeFileSync(path.join(root, 'helper.mjs'), 'export const h = 1;');
      const { files, unproven } = lintConfigClosure(path.join(root, 'config.mjs'));
      expect(files.map((file) => path.basename(file)).sort()).toEqual([
        'config.mjs',
        'helper.mjs',
        'rule.mjs',
      ]);
      expect(unproven).toEqual([
        expect.stringContaining('config.mjs: x-none is not an installed package'),
        expect.stringContaining('rule.mjs: ./gone.mjs resolves to no file'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('never opens git-ignored generated output while matching (regenerated mid-walk, FU-090)', () => {
    // `db:generate` rewrites src/generated while checks run (a listed file can be gone:
    // ENOENT). A directory that cannot be read stands in for that.
    const root = mkdtempSync(path.join(tmpdir(), 'turbo-generated-'));
    const unreadable = path.join(root, 'services/svc/src/generated/prisma');
    try {
      mkdirSync(unreadable, { recursive: true });
      writeFileSync(path.join(root, 'services/svc/src/app.ts'), 'export {};\n');
      chmodSync(unreadable, 0o000);
      if (process.getuid?.() === 0) return; // root reads it anyway: nothing to prove
      expect(filesMatching('services/svc/src/**', root)).toEqual(['services/svc/src/app.ts']);
    } finally {
      chmodSync(unreadable, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
