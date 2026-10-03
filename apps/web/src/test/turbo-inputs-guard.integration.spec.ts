/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UNDECLARED } from './guard-fixtures/targets';
import { declaredTestInputs } from './turbo-inputs-guard';

/**
 * The guard, proved through the real thing: each fixture under
 * `guard-fixtures/` is an actual spec file, run by an actual jest (a child
 * process) with the guard installed the way `setup.ts` installs it. A unit test
 * of the helpers cannot show what this shows — that a read made *while a spec's
 * module loads*, or by `fs.promises`, a callback, a stream, a relative path, a
 * URL, a Buffer or a symlink, is seen and fails the suite.
 *
 * Every fixture reads the same repository file, `UNDECLARED`, that
 * `turbo.json` does not name, by a different route; the two controls read files
 * the cache needs and does not need to know about, and must pass.
 */

const WEB_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(__dirname, 'guard-fixtures');
const REPO_RELATIVE = path.relative(path.resolve(WEB_ROOT, '../..'), UNDECLARED);

/** Every fixture that must be reported, and the route it reads by. */
const REPORTED: ReadonlyArray<readonly [fixture: string, route: string]> = [
  ['module-load', 'readFileSync while the spec module loads (before any hook)'],
  ['in-beforeall', 'readFileSync in beforeAll'],
  ['in-test-sync', 'readFileSync in a test'],
  ['read-file-callback', 'fs.readFile with a callback'],
  ['promises-read-file', 'fs.promises.readFile'],
  ['fs-promises-import', "readFile imported from 'node:fs/promises'"],
  ['create-read-stream', 'fs.createReadStream'],
  ['open-sync', 'fs.openSync'],
  ['open-callback', 'fs.open with a callback'],
  ['promises-open', 'fs.promises.open'],
  ['relative-path', 'a path relative to the working directory'],
  ['dotdot-path', 'a path with .. segments'],
  ['file-url', 'a file: URL'],
  ['buffer-path', 'a path given as a Buffer'],
  ['symlink', 'a symlink outside the repository'],
];

const CONTROLS = ['declared-all-routes', 'ignored-reads'] as const;

interface Result {
  readonly status: string;
  readonly message: string;
}

let scratch: string;
let results: ReadonlyMap<string, Result>;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-guard-'));
  const link = path.join(scratch, 'link-to-undeclared.ts');
  fs.symlinkSync(UNDECLARED, link);
  const outputFile = path.join(scratch, 'result.json');

  const config = {
    rootDir: WEB_ROOT,
    roots: [FIXTURES],
    testEnvironment: 'node',
    testRegex: '\\.fixture-spec\\.ts$',
    transform: {
      '^.+\\.(t|j)sx?$': [
        '@swc/jest',
        { jsc: { target: 'es2023', parser: { syntax: 'typescript' } } },
      ],
    },
    setupFilesAfterEnv: [path.join(FIXTURES, 'install-guard.ts')],
  };

  const jest = require.resolve('jest/bin/jest');
  const run = spawnSync(
    process.execPath,
    [
      jest,
      '--config',
      JSON.stringify(config),
      '--json',
      `--outputFile=${outputFile}`,
      '--runInBand',
      '--silent',
      '--testTimeout=30000',
    ],
    {
      cwd: WEB_ROOT,
      encoding: 'utf8',
      // The child must not inherit a tracing hook that would observe for it.
      env: { ...process.env, NODE_OPTIONS: '', FIXTURE_SYMLINK: link },
      timeout: 150_000,
    },
  );
  if (!fs.existsSync(outputFile)) {
    throw new Error(`The child jest produced no result (exit ${run.status}): ${run.stderr}`);
  }

  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as {
    testResults: Array<{ name: string; status: string; message: string }>;
  };
  results = new Map(
    report.testResults.map((suite) => [
      path.basename(suite.name).replace('.fixture-spec.ts', ''),
      { status: suite.status, message: suite.message },
    ]),
  );
}, 180_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the fixtures are what they claim to be', () => {
  it('read a repository file that turbo.json does not name, and run every fixture', () => {
    expect(fs.existsSync(UNDECLARED)).toBe(true);
    expect(declaredTestInputs()).not.toContain(REPO_RELATIVE);
    expect([...results.keys()].sort()).toEqual(
      [...REPORTED.map(([name]) => name), ...CONTROLS].sort(),
    );
  });
});

describe('a read of an undeclared file fails the spec that made it', () => {
  it.each(REPORTED)('%s — %s', (fixture) => {
    const result = results.get(fixture);
    expect(result?.status).toBe('failed');
    // Naming the file and where to add it, so a person can act on the failure.
    expect(result?.message).toContain(REPO_RELATIVE);
    expect(result?.message).toContain('apps/web/turbo.json');
  });

  it('names the file once per spec, not once per route', () => {
    const message = results.get('module-load')?.message ?? '';
    expect(message.split(REPO_RELATIVE).length - 1).toBe(1);
  });
});

describe('controls: what the cache knows about, or does not need to, is not reported', () => {
  it.each(CONTROLS)('%s passes', (fixture) => {
    expect([fixture, results.get(fixture)?.status, results.get(fixture)?.message]).toEqual([
      fixture,
      'passed',
      '',
    ]);
  });
});
