import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
      taskId: `${names[i]}#test:unit`,
      dependencies: [],
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

test('undeclared repository readers are always included for any changed path', () => {
  const result = fixture(['apps/web/src/new.tsx']).plan();
  assert.deepEqual(result.packages, names);
  assert.equal(result.broad, true);
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
  // Model a Git hook without pointing at any shared repository or index.
  const redirects = {
    GIT_DIR: join(root, 'redirect', '.git'),
    GIT_WORK_TREE: join(root, 'redirect'),
    GIT_INDEX_FILE: join(root, 'redirect', 'index'),
    GIT_OBJECT_DIRECTORY: join(root, 'redirect', 'objects'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const previous = Object.fromEntries(Object.keys(redirects).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, redirects);
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

test('lint, typecheck and prerequisite edges participate in closure validation', () => {
  for (const task of ['lint', 'typecheck', 'build']) {
    const all = structuredClone(inventory);
    all.tasks.push({
      ...all.tasks[3],
      task,
      taskId: `${names[3]}#${task}`,
      dependencies: [`${names[0]}#test:unit`],
      resolvedTaskDefinition: { inputs: ['../../services/**'] },
    });
    assert.throws(() => fixture([], { all, committed: [names[0]] }).plan(), /dependent selection/);
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

test('root lint inputs cannot narrow the undeclared-reader fallback', () => {
  const all = structuredClone(inventory);
  for (const task of inventory.tasks)
    all.tasks.push({
      ...task,
      task: 'lint',
      taskId: `${task.package}#lint`,
      resolvedTaskDefinition: {
        inputs: ['$TURBO_DEFAULT$', '../../eslint.config.mjs', '../../scripts/*.mjs'],
      },
    });
  assert.deepEqual(fixture(['apps/web/src/new.tsx'], { all }).plan().packages, names);
});

test('both filtered stages refuse a missing dependent even with every seed retained', () => {
  const all = structuredClone(inventory);
  all.tasks[3].dependencies = [`${names[1]}#test:unit`];
  // Stage one retains its source seed but omits its dependent.
  assert.throws(() => fixture([], { all, committed: [names[1]] }).plan(), /dependent selection/);
  // Stage two retains the path owner seed but omits its dependent.
  assert.throws(
    () => fixture(['apps/web/src/a.ts'], { all, expand: (seeds) => seeds }).plan(),
    /dependent selection/,
  );
  assert.deepEqual(fixture([], { all, committed: [names[1], names[3]] }).plan().packages, [
    names[1],
    names[3],
  ]);
});

test('closure follows transitive prerequisite edges and malformed graphs refuse', () => {
  const all = structuredClone(inventory);
  all.tasks[1].dependencies = [`${names[0]}#test:unit`];
  all.tasks[3].dependencies = [`${names[1]}#test:unit`];
  assert.throws(() => fixture([], { all, committed: [names[0], names[1]] }).plan());
  for (const mutate of [
    (t) => delete t.dependencies,
    (t) => (t.dependencies = ['@rasta/missing#build']),
    (t) => (t.taskId = '@rasta/wrong#test:unit'),
    (t) => (t.dependencies = [null]),
  ]) {
    const broken = structuredClone(inventory);
    mutate(broken.tasks[0]);
    assert.throws(() => fixture([], { all: broken }).plan());
  }
});

test('missing native binary refuses without entering installer-capable JS launcher', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prepush-no-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const turbo = join(root, 'node_modules/turbo');
  mkdirSync(join(turbo, 'bin'), { recursive: true });
  writeFileSync(join(turbo, 'package.json'), '{"name":"turbo"}');
  const marker = join(root, 'installer-entered');
  // A launcher capable of installation must not even be entered. The marker is
  // deterministic evidence; this fixture never runs an actual installer.
  writeFileSync(
    join(turbo, 'bin/turbo'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'npm install');`,
  );
  for (const filters of [[], ['--filter=...[HEAD]'], ['--filter=...@rasta/web']]) {
    assert.throws(
      () => scopeRunner(root)('turbo', ['run', 'test:unit', '--dry=json', ...filters]),
      /selection refused/,
    );
    assert.equal(existsSync(marker), false);
  }
});

test('contracts cache inputs cover the repository for both test entry points', () => {
  const source = readFileSync(new URL('../packages/contracts/turbo.json', import.meta.url), 'utf8');
  for (const task of ['test', 'test:unit']) {
    assert.match(source.split(`"${task}":`)[1].split('}')[0], /"\$TURBO_ROOT\$\/\*\*"/);
  }
});
