import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readdirSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servicesToBuild } from './container-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts', 'container-scope.mjs');
const ALL = ['api-gateway', 'fleet-service', 'identity-service'];

test('a push to main builds every image', () => {
  assert.deepEqual(servicesToBuild(ALL, 'all'), ALL);
});

test("a change inside one service builds that service's image only", () => {
  assert.deepEqual(servicesToBuild(ALL, ['services/fleet-service/src/main.ts']), ['fleet-service']);
  assert.deepEqual(servicesToBuild(ALL, ['services/api-gateway/Dockerfile']), ['api-gateway']);
});

test('a service name that is a prefix of another does not match it', () => {
  assert.deepEqual(servicesToBuild(['a', 'a-b'], ['services/a-b/x.ts']), ['a-b']);
});

for (const path of [
  'packages/nest-common/src/index.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'tsconfig.json',
  'packages/logging/src/logger.spec.ts',
  'packages/logging/docs/guide.md',
  'package.json',
  'tsconfig.base.json',
  '.dockerignore',
  'turbo.json',
  'scripts/copy-prisma-client.mjs',
  '.github/workflows/ci.yml',
]) {
  test(`${path} is read by every build, so every image is rebuilt`, () => {
    assert.deepEqual(servicesToBuild(ALL, ['docs/x.md', path]), ALL);
  });
}

for (const path of [
  'docs/26-branch-registry.md',
  'apps/web/src/app/page.tsx',
  'tests/e2e/a.ts',
  'scripts/other.mjs',
]) {
  test(`${path} builds no image`, () => {
    assert.deepEqual(servicesToBuild(ALL, [path]), []);
  });
}

test('the CLI covers every service with a Dockerfile on --all', () => {
  const expected = readdirSync(join(root, 'services'))
    .filter((name) => existsSync(join(root, 'services', name, 'Dockerfile')))
    .sort();
  const result = spawnSync(process.execPath, [CLI, '--all'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.ok(expected.length >= 12);
});

test('the CLI reads changed paths from stdin', () => {
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--base',
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    ],
    {
      input: 'services/supplier-service/src/a.ts\ndocs/b.md\n',
      encoding: 'utf8',
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), ['supplier-service']);
});

// Semantic PR analysis is exercised through the same CLI/--base/stdin contract
// as CI, against committed base and HEAD blobs, not the working-tree YAML.
const WORKFLOW = `name: CI
on:
  pull_request:
    branches: [main]
env:
  NODE_VERSION: '22'
permissions:
  contents: read
concurrency:
  group: ci-example
  cancel-in-progress: true
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - run: echo before
  containers:
    needs: [container-scope, quality]
    steps:
      - run: build-and-scan
  container-scope:
    steps:
      - run: node scripts/container-scope.mjs
`;

function fixture(t, head = WORKFLOW, base = WORKFLOW) {
  const dir = mkdtempSync(join(tmpdir(), 'container-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['container-scope.mjs', 'container-scope-lib.mjs']) {
    copyFileSync(join(root, 'scripts', name), join(dir, 'scripts', name));
  }
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  for (const service of ALL) {
    mkdirSync(join(dir, 'services', service), { recursive: true });
    writeFileSync(join(dir, 'services', service, 'Dockerfile'), 'FROM scratch\n');
  }
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  const workflow = join(dir, '.github', 'workflows', 'ci.yml');
  git('init', '--quiet');
  const commit = () => {
    git('add', 'scripts', 'services', '.github');
    git(
      '-c',
      'user.name=Scope fixture',
      '-c',
      'user.email=scope@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'test fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  writeFileSync(workflow, base);
  const baseSha = commit();
  writeFileSync(workflow, head);
  commit();
  return {
    dir,
    workflow,
    git,
    commit,
    baseSha,
    run: (paths = ['.github/workflows/ci.yml'], args = ['--base', baseSha]) => {
      const result = spawnSync(
        process.execPath,
        [join(dir, 'scripts', 'container-scope.mjs'), ...args],
        {
          input: `${paths.join('\n')}\n`,
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
  };
}

test('CLI: identical base/HEAD workflow contributes no images', (t) => {
  assert.deepEqual(fixture(t).run(), []);
});

test('CLI: another job changing (even a containers prerequisite) contributes no images', (t) => {
  assert.deepEqual(fixture(t, WORKFLOW.replace('echo before', 'echo after')).run(), []);
});

test('CLI: YAML key order, comments, quoting and line endings compare semantically', (t) => {
  const head = WORKFLOW.replace('name: CI\n', '').replace(
    "NODE_VERSION: '22'",
    'NODE_VERSION: "22"',
  );
  assert.deepEqual(
    fixture(t, `# moved name\n${head}name: CI\n`.replaceAll('\n', '\r\n')).run(),
    [],
  );
});

for (const [name, head] of [
  ['name', WORKFLOW.replace('name: CI', 'name: Other')],
  ['on', WORKFLOW.replace('branches: [main]', 'branches: [release]')],
  ['env', WORKFLOW.replace("NODE_VERSION: '22'", "NODE_VERSION: '24'")],
  ['permissions', WORKFLOW.replace('contents: read', 'contents: write')],
  ['concurrency', WORKFLOW.replace('cancel-in-progress: true', 'cancel-in-progress: false')],
  ['defaults added', `${WORKFLOW}defaults:\n  run:\n    shell: bash\n`],
  ['top-level key removed', WORKFLOW.replace('name: CI\n', '')],
  ['containers', WORKFLOW.replace('build-and-scan', 'build-without-scan')],
  [
    'containers needs',
    WORKFLOW.replace('needs: [container-scope, quality]', 'needs: [container-scope]'),
  ],
  ['container-scope', WORKFLOW.replace('run: node scripts/container-scope.mjs', 'run: echo skip')],
  ['containers renamed', WORKFLOW.replace('  containers:', '  renamed:')],
  ['container-scope removed', WORKFLOW.slice(0, WORKFLOW.indexOf('  container-scope:'))],
  ['containers null', WORKFLOW.replace('  containers:\n', '  containers: null\n  unused:\n')],
  ['unparsable head', 'jobs: ['],
  ['empty head', ''],
  ['duplicate YAML key', `${WORKFLOW}env: {}\n`],
  ['unknown YAML tag', WORKFLOW.replace('name: CI', 'name: !unknown CI')],
]) {
  test(`CLI: ${name} changes retain every image`, (t) => {
    assert.deepEqual(fixture(t, head).run(), ALL);
  });
}

test('CLI: unparsable base retains every image', (t) => {
  assert.deepEqual(fixture(t, WORKFLOW, 'jobs: [').run(), ALL);
});

test('CLI: image jobs absent at both revisions still retain every image', (t) => {
  assert.deepEqual(fixture(t, 'jobs: {}', 'jobs: {}').run(), ALL);
});

test('CLI: missing base argument, malformed SHA and unavailable base retain every image', (t) => {
  const f = fixture(t);
  for (const args of [[], ['--base'], ['--base', 'not-a-sha'], ['--base', '0'.repeat(40)]]) {
    assert.deepEqual(f.run(['docs/only.md'], args), ALL);
  }
});

test('CLI: removed workflow blob retains every image', (t) => {
  const f = fixture(t);
  rmSync(f.workflow);
  f.commit();
  assert.deepEqual(f.run(), ALL);
});

test('CLI: uncommitted workflow cannot override the committed HEAD comparison', (t) => {
  const f = fixture(t, WORKFLOW.replace('build-and-scan', 'changed'));
  writeFileSync(f.workflow, WORKFLOW);
  assert.deepEqual(f.run(), ALL);
});

test('CLI: unaffected workflow is unioned with unchanged service and shared path rules', (t) => {
  const f = fixture(t, WORKFLOW.replace('echo before', 'echo after'));
  assert.deepEqual(f.run(['.github/workflows/ci.yml', 'services/fleet-service/test/a.spec.ts']), [
    'fleet-service',
  ]);
  assert.deepEqual(f.run(['.github/workflows/ci.yml', 'packages/logging/README.md']), ALL);
  assert.deepEqual(f.run(['.github/workflows/ci.yml', 'docs/only.md']), []);
});

for (const path of [
  'scripts/container-scope.mjs',
  'scripts/container-scope-lib.mjs',
  'scripts/container-scope.test.mjs',
]) {
  test(`${path} forces ALL even with an unaffected workflow`, () => {
    assert.deepEqual(servicesToBuild(ALL, ['.github/workflows/ci.yml', path], true), ALL);
  });
}

test('workflow passes the PR base and installs its parser only on PRs; main keeps --all', () => {
  const { steps } = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).jobs[
    'container-scope'
  ];
  for (const step of steps.filter(
    (step) => step.uses?.startsWith('pnpm/') || step.uses?.startsWith('actions/setup-node@'),
  )) {
    assert.equal(step.if, "github.event_name == 'pull_request'");
  }
  const install = steps.find(
    (step) => step.name === 'Install scope parser from the frozen workspace lockfile',
  );
  assert.equal(install.if, "github.event_name == 'pull_request'");
  assert.equal(install.run, 'pnpm install --filter . --frozen-lockfile --ignore-scripts');
  const run = steps.find((step) => step.id === 'scope').run;
  assert.match(
    run,
    /node scripts\/container-scope\.mjs --base "\$\{\{ github.event.pull_request.base.sha \}\}"/,
  );
  assert.match(run, /else\n\s+services="\$\(node scripts\/container-scope\.mjs --all\)"\n\s*fi/);
});

test('CLI: missing YAML dependency fails closed', (t) => {
  const f = fixture(t);
  rmSync(join(f.dir, 'node_modules'));
  assert.deepEqual(f.run(), ALL);
});

test('CLI: the rule judging itself retains every image', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run(['scripts/container-scope-lib.mjs']), ALL);
});

test('CLI: main --all works without the YAML dependency or base', (t) => {
  const f = fixture(t);
  rmSync(join(f.dir, 'node_modules'));
  assert.deepEqual(f.run([], ['--all']), ALL);
});
