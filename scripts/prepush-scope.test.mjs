import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { changedPaths, planScope, scopeRunner } from './prepush-scope-lib.mjs';

const sha = 'a'.repeat(40);
const names = ['service', 'web', 'contracts', 'consumer'].map((n) => `@rasta/${n}`);
const inventory = {
  packages: names,
  tasks: ['services/service', 'apps/web', 'packages/contracts', 'apps/consumer'].map(
    (directory, i) => ({
      package: names[i],
      directory,
      task: 'test:unit',
      resolvedTaskDefinition: { inputs: i === 1 || i === 2 ? ['../../services/**'] : [] },
    }),
  ),
};
const config = '{ // JSONC is Turbo\'s format\n "globalDependencies": ["apps/web/e2e/expect.ts"] }';

function fixture(paths, { all = inventory, committed = [], expand, globals = config } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === 'git') {
      if (args[0] === 'rev-parse' || args[0] === 'merge-base') return `${sha}\n`;
      return args.includes('HEAD') ? paths.map((p) => `${p}\0`).join('') : '';
    }
    const filters = args.filter((a) => a.startsWith('--filter='));
    if (!filters.length) return JSON.stringify(all);
    if (filters[0].includes('[')) return JSON.stringify({ packages: committed, tasks: [] });
    const selected = filters.map((f) => f.slice('--filter=...'.length));
    return JSON.stringify({ packages: expand ? expand(selected) : selected, tasks: [] });
  };
  return { calls, plan: () => planScope({ run, turboSource: globals }) };
}

test('service changes select web/contracts source readers and their dependents', () => {
  const { plan, calls } = fixture(['services/service/src/removed.ts'], {
    expand: (selected) => [...new Set([...selected, names[3]])],
  });
  assert.deepEqual(new Set(plan().packages), new Set(names));
  assert.ok(calls.some(([, args]) => args.includes(`--filter=...[${sha}]`)));
});

test('web-only changes do not select unrelated service readers', () => {
  const result = fixture(['apps/web/src/new.tsx']).plan();
  assert.deepEqual(result.packages, [names[1]]);
  assert.equal(result.broad, false);
});

for (const path of [
  'turbo.json',
  'scripts/new.mjs',
  'packages/contracts/src/a.ts',
  'services/deleted/src/a.ts',
  'apps/web/e2e/expect.ts',
]) {
  test(`shared, unknown or global path selects all: ${path}`, () => {
    assert.deepEqual(fixture([path]).plan().packages, names);
  });
}

test('custom global globs include deleted/new paths and negations broaden', () => {
  for (const pattern of [
    'services/*/src/**',
    '!services/*/src/**',
    '**/settings.json',
    './services/**',
    '$TURBO_ROOT$/services/**',
    '../services/**',
  ]) {
    assert.equal(
      fixture(['services/service/src/deleted.ts'], {
        globals: JSON.stringify({ globalDependencies: [pattern] }),
      }).plan().broad,
      true,
    );
  }
});

test('committed selection is retained even when no working paths select it', () => {
  assert.deepEqual(fixture([], { committed: [names[3]] }).plan().packages, [names[3]]);
  assert.deepEqual(fixture([]).plan().packages, []);
});

test('missing, malformed, empty or partial Turbo inventory refuses', () => {
  for (const all of [
    null,
    {},
    { packages: [], tasks: [] },
    { ...inventory, tasks: inventory.tasks.slice(1) },
    { ...inventory, packages: [...names, names[0]] },
    { ...inventory, tasks: inventory.tasks.map((t) => ({ ...t, directory: '../escape' })) },
    { ...inventory, tasks: inventory.tasks.map((t) => ({ ...t, resolvedTaskDefinition: {} })) },
  ])
    assert.throws(() => fixture([], { all }).plan());
  for (const globals of ['invalid', '{}', '{"globalDependencies": [null]}']) {
    assert.throws(() => fixture([], { globals }).plan());
  }
});

test('unknown selection or omitted expansion is refused, never zero packages OK', () => {
  assert.throws(() => fixture([], { committed: ['@rasta/unknown'] }).plan());
  for (const expand of [() => [], () => ['@rasta/unknown']]) {
    assert.throws(() => fixture(['apps/web/src/a.ts'], { expand }).plan());
  }
});

test('real Git preserves committed, staged, unstaged, renamed, deleted and untracked paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prepush-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = scopeRunner(root);
  const run = (...args) => git('git', args);
  const write = (path, value = 'initial\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  run('init', '-q');
  run('config', 'user.name', 'Scope test');
  run('config', 'user.email', 'scope@example.invalid');
  for (const path of ['committed', 'staged', 'unstaged', 'deleted', 'services/old/a.ts'])
    write(path);
  run('add', '.');
  run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const base = run('rev-parse', 'HEAD').trim();
  write('committed', 'commit\n');
  run('add', 'committed');
  run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'change');
  write('committed'); // cancel the committed edit in the working tree
  write('staged', 'staged\n');
  run('add', 'staged');
  write('unstaged', 'unstaged\n');
  run('rm', 'deleted');
  mkdirSync(join(root, 'apps/new'), { recursive: true });
  run('mv', 'services/old/a.ts', 'apps/new/a.ts');
  write('untracked space\nfile.ts');
  const changes = changedPaths(git, base);
  assert.equal(changes.resolvedBase, base);
  assert.equal(changes.mergeBase, base);
  assert.deepEqual(
    changes.paths,
    [
      'apps/new/a.ts',
      'committed',
      'deleted',
      'services/old/a.ts',
      'staged',
      'unstaged',
      'untracked space\nfile.ts',
    ].sort(),
  );
  assert.throws(() => changedPaths(git, 'missing-base'));
  assert.throws(() => git('git', ['not-a-command']), /selection refused/);
});

test('invalid base and malformed NUL paths refuse', () => {
  assert.throws(() => changedPaths(() => '', 'main'));
  assert.throws(() =>
    changedPaths(
      (_, args) => (['rev-parse', 'merge-base'].includes(args[0]) ? sha : 'unterminated'),
      'main',
    ),
  );
});

test('lint, typecheck and prerequisite task source readers are selected too', () => {
  for (const task of ['lint', 'typecheck', 'build']) {
    const all = structuredClone(inventory);
    all.tasks.push({
      ...all.tasks[3],
      task,
      resolvedTaskDefinition: { inputs: ['../../services/**'] },
    });
    assert.ok(fixture(['services/service/src/a.ts'], { all }).plan().packages.includes(names[3]));
  }
});

test('runner withholds inherited Node options and never loads a fixture .env', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prepush-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'NODE_ENV=production\nPREPUSH_SENTINEL=private-value\n');
  const previous = { NODE_ENV: process.env.NODE_ENV, NODE_OPTIONS: process.env.NODE_OPTIONS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = 'production';
  process.env.NODE_OPTIONS = '--require=/nonexistent-prepush-sentinel';
  const output = scopeRunner(root)(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify([process.env.NODE_ENV, process.env.NODE_OPTIONS, process.env.PREPUSH_SENTINEL]))',
  ]);
  assert.deepEqual(JSON.parse(output), ['test', null, null]);
});

test('Turbo root pseudo-package broadens selection instead of being executed', () => {
  assert.deepEqual(fixture(['package.json'], { committed: ['//'] }).plan().packages, names);
  assert.deepEqual(fixture([], { committed: ['//'] }).plan().packages, names);
  assert.throws(() => fixture(['package.json'], { committed: ['@rasta/unknown'] }).plan());
});

test('root lint configuration inputs do not select unrelated workspaces', () => {
  const all = structuredClone(inventory);
  for (const task of inventory.tasks)
    all.tasks.push({
      ...task,
      task: 'lint',
      resolvedTaskDefinition: {
        inputs: ['$TURBO_DEFAULT$', '../../eslint.config.mjs', '../../scripts/*.mjs'],
      },
    });
  assert.deepEqual(fixture(['apps/web/src/new.tsx'], { all }).plan().packages, [names[1]]);
});
