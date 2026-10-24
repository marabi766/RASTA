/**
 * @jest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { actionKey } from './test/server-action-discovery';
import { compiledActions, nextProjectDir, uncovered } from './test/server-action-manifest';

/**
 * The reader of the compiler's server-action manifest (`next build` output), checked on
 * hand-made manifests. `scripts/check-server-action-coverage.mjs` runs it on the real one.
 */
const SECRET = 'ENCRYPTION-KEY-MUST-NOT-LEAK';
let repo: string;
let outside: string;
let project: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'manifest-'));
  outside = mkdtempSync(join(tmpdir(), 'manifest-outside-'));
  project = join(repo, 'apps/web/src');
  mkdirSync(join(project, 'app/a'), { recursive: true });
  writeFileSync(join(project, 'app/a/actions.ts'), '');
  writeFileSync(join(outside, 'probe.ts'), '');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const entry = (filename: unknown, exportedName: unknown): Record<string, unknown> => ({
  workers: {},
  layer: {},
  filename,
  exportedName,
});
const manifest = (node: unknown, edge: unknown = {}): string =>
  JSON.stringify({ node, edge, encryptionKey: SECRET });
const read = (text: string | null) => compiledActions(text, project, repo);

it('reads names relative to the directory above the app directory, src here', () => {
  expect(nextProjectDir(join(repo, 'apps/web'))).toBe(project);
  expect(read(manifest({ 1: entry('app/a/actions.ts', 'submitX') }))).toEqual({
    actions: [{ module: 'apps/web/src/app/a/actions.ts', exportedName: 'submitX' }],
    problems: [],
  });
});

it('reads the edge map too, and a symlink by its real path', () => {
  symlinkSync(join(project, 'app/a/actions.ts'), join(project, 'app/a/alias.ts'));
  const { actions, problems } = read(manifest({}, { 1: entry('app/a/alias.ts', 'submitY') }));
  expect(problems).toEqual([]);
  expect(actions).toEqual([{ module: 'apps/web/src/app/a/actions.ts', exportedName: 'submitY' }]);
});

describe.each([
  ['missing', null],
  ['not JSON', `{ "encryptionKey": "${SECRET}" `],
  ['an array', '[]'],
  ['null', 'null'],
  ['no edge map', JSON.stringify({ node: { 1: entry('app/a/actions.ts', 'x') } })],
  ['no node map', JSON.stringify({ edge: {} })],
  ['a node map that is a list', manifest([])],
  ['empty', manifest({}, {})],
])('refuses a manifest that is %s', (_name, text) => {
  it('with a problem that does not quote the manifest', () => {
    const { problems } = read(text);
    expect(problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(problems)).not.toContain(SECRET);
  });
});

describe.each([
  ['no filename', entry(undefined, 'submitX')],
  ['an empty filename', entry('', 'submitX')],
  ['no export name', entry('app/a/actions.ts', undefined)],
  ['an empty export name', entry('app/a/actions.ts', '')],
  ['a numeric export name', entry('app/a/actions.ts', 7)],
  ['a file that is gone', entry('app/a/gone.ts', 'submitX')],
  ['a path outside the repository', entry(join('..', '..', '..', '..', 'x.ts'), 'submitX')],
  ['an entry that is not a record', 'submitX'],
  ['an entry that is null', null],
])('refuses one entry with %s, even beside a valid one', (_name, bad) => {
  it('fails closed per entry', () => {
    const { problems } = read(manifest({ 1: entry('app/a/actions.ts', 'submitOk'), 2: bad }));
    expect(problems.length).toBe(1);
    expect(JSON.stringify(problems)).not.toContain(SECRET);
  });
});

it('refuses a symlink that leaves the repository', () => {
  symlinkSync(join(outside, 'probe.ts'), join(project, 'app/a/leak.ts'));
  const { problems } = read(manifest({ 1: entry('app/a/leak.ts', 'submitX') }));
  expect(problems).toEqual(['app/a/leak.ts submitX: resolves outside the repository']);
});

it('refuses an absolute filename outside the repository', () => {
  const { problems } = read(manifest({ 1: entry(join(outside, 'probe.ts'), 'submitX') }));
  expect(problems).toEqual([
    `${join(outside, 'probe.ts')} submitX: resolves outside the repository`,
  ]);
});

describe('uncovered', () => {
  const covered = new Set([actionKey('apps/web/src/app/a/actions.ts', 'submitX')]);
  const compiled = (module: string, exportedName: string) => [{ module, exportedName }];
  it('passes a covered pair', () => {
    expect(
      uncovered(compiled('apps/web/src/app/a/actions.ts', 'submitX'), covered, actionKey),
    ).toEqual([]);
  });
  it('names a module that is not covered', () => {
    expect(
      uncovered(compiled('packages/config/src/probe.ts', 'submitX'), covered, actionKey),
    ).toEqual(['packages/config/src/probe.ts submitX']);
  });
  it('names an export of a covered module that has no case', () => {
    expect(
      uncovered(compiled('apps/web/src/app/a/actions.ts', 'submitZ'), covered, actionKey),
    ).toEqual(['apps/web/src/app/a/actions.ts submitZ']);
  });
});
