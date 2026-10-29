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
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGES_ON_TRAIN_NOTE,
  SHARED_INPUTS,
  classifyRun,
  imagesGateVerdict,
  servicesToBuild,
} from './container-scope-lib.mjs';
import { maySkipBuildKitProof, probeBuildx } from './container-scope-buildx.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts', 'container-scope.mjs');
const ALL = ['api-gateway', 'fleet-service', 'identity-service'];

test('a push to main builds every image', () => {
  assert.deepEqual(servicesToBuild(ALL, 'all'), ALL);
});

test("a change inside one service builds that service's image only", () => {
  assert.deepEqual(servicesToBuild(ALL, ['services/fleet-service/src/main.ts']), ['fleet-service']);
  assert.deepEqual(servicesToBuild(ALL, ['services/api-gateway/Dockerfile']), ALL);
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

for (const path of ['docs/26-branch-registry.md', 'tests/e2e/a.ts']) {
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

// Exercise the actual CLI and committed Git paths, never a mocked stdin list.
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
    git('add', '--all', '--', '.', ':!node_modules');
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
  writeFileSync(workflow, `${head}\n# committed HEAD revision\n`);
  commit();
  return {
    dir,
    workflow,
    git,
    commit,
    baseSha,
    write: (path, contents = 'fixture content\n') => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    },
    raw: (args = ['--base', baseSha], env = {}) => {
      const result = spawnSync(
        process.execPath,
        [join(dir, 'scripts', 'container-scope.mjs'), ...args],
        { encoding: 'utf8', env: { ...process.env, ...env } },
      );
      assert.equal(result.status, 0, result.stderr);
      // stdout is always exactly one JSON line, even on warning paths.
      assert.equal(result.stdout, `${JSON.stringify(JSON.parse(result.stdout))}\n`);
      return result;
    },
    run: (paths = [], args = ['--base', baseSha]) => {
      for (const path of paths.filter((path) => path !== '.github/workflows/ci.yml')) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        const previous = existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : '';
        writeFileSync(join(dir, path), `${previous}\n// changed fixture\n`);
      }
      if (paths.length) commit();
      const result = spawnSync(
        process.execPath,
        [join(dir, 'scripts', 'container-scope.mjs'), ...args],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${JSON.stringify(JSON.parse(result.stdout))}\n`);
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
  const f = () => fixture(t, WORKFLOW.replace('echo before', 'echo after'));
  assert.deepEqual(f().run(['.github/workflows/ci.yml', 'services/fleet-service/test/a.spec.ts']), [
    'fleet-service',
  ]);
  assert.deepEqual(f().run(['.github/workflows/ci.yml', 'packages/logging/README.md']), ALL);
  assert.deepEqual(f().run(['.github/workflows/ci.yml', 'docs/only.md']), []);
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

test('workflow decides images from the event through env, installs its parser only on PRs', () => {
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
  const scope = steps.find((step) => step.id === 'scope');
  // Every input is an env var; no github.* expression is interpolated into the
  // script text (a branch name is attacker-controlled).
  assert.deepEqual(scope.env, {
    EVENT_NAME: '${{ github.event_name }}',
    REF: '${{ github.ref }}',
    HEAD_REF: '${{ github.event.pull_request.head.ref }}',
    HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
    REPOSITORY: '${{ github.repository }}',
    BASE_SHA: '${{ github.event.pull_request.base.sha }}',
  });
  assert.doesNotMatch(scope.run, /\$\{\{/);
  assert.match(scope.run, /^set -euo pipefail\nnode scripts\/container-scope\.mjs --run\n$/);
  assert.equal(scope.if, undefined);
});

test('the aggregate check is "Images built and scanned", always runs and reads both image jobs', () => {
  const { jobs } = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const images = jobs.images;
  assert.equal(images.name, 'Images built and scanned');
  assert.equal(images.if, '${{ always() }}');
  assert.deepEqual(images.needs, ['container-scope', 'containers']);
  const gate = images.steps.at(-1);
  assert.equal(gate.env.NEEDS, '${{ toJSON(needs) }}');
  assert.equal(gate.run, 'node scripts/container-scope-gate.mjs');
  assert.equal(jobs['container-scope'].outputs.mode, '${{ steps.scope.outputs.mode }}');
  assert.equal(jobs['container-scope'].name, 'Images to build and scan');
  // No other job may carry the aggregate's name: the merge train requires it.
  assert.deepEqual(
    Object.values(jobs).filter((job) => job.name === 'Images built and scanned').length,
    1,
  );
  // The Trivy DB is only fetched by a run that can scan: its condition reads
  // the event alone and is a superset of what classifyRun builds images for.
  assert.equal(jobs['trivy-db'].needs, undefined);
  assert.equal(
    jobs['trivy-db'].if,
    "${{ github.event_name != 'pull_request' || !github.event.pull_request.head.ref || startsWith(github.event.pull_request.head.ref, 'mq/') }}",
  );
});

test('CLI: missing YAML dependency warns once and keeps stdout JSON-only', (t) => {
  const f = fixture(t);
  rmSync(join(f.dir, 'node_modules'));
  const result = f.raw();
  assert.deepEqual(JSON.parse(result.stdout), ALL);
  assert.equal(
    result.stderr,
    '::warning::Container scope: YAML parser unavailable; building and scanning every image.\n',
  );
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

test('no Trivy ignore file is a shared input: the services one was deleted with its exception (PR #444 r1)', () => {
  assert.equal(
    SHARED_INPUTS.some((pattern) => pattern.test('.trivyignore.services')),
    false,
  );
  // Re-added at the root it is an unknown input, which still rebuilds and rescans everything.
  assert.deepEqual(servicesToBuild(ALL, ['.trivyignore.services']), ALL);
});

for (const path of [
  'apps/web/package.json',
  'services/fleet-service/package.json',
  'docs/package.json',
  'tests/package.json',
  'docs/pnpm-lock.yaml',
  'tests/pnpm-workspace.yaml',
  'docs/.npmrc',
  'tests/.dockerignore',
  'docs/Dockerfile',
  'tests/Dockerfile.test',
  'apps/web/src/app/page.tsx',
  'scripts/other.mjs',
  'planning/plan.txt',
  'unknown-input',
  'README.md',
  'CHANGELOG.md',
  'services/unknown/src/a.ts',
  ' docs/only.md',
  'services/fleet-service ',
]) {
  test(`${JSON.stringify(path)} fails closed to ALL, ahead of exemptions and services`, () => {
    assert.deepEqual(servicesToBuild(ALL, [path]), ALL);
  });
}

for (const path of [
  'docs/a.md',
  'docs/nested/file.txt',
  'tests/e2e/a.ts',
  'tests/a.md',
  'docs/README.md',
  'tests/README.md',
  'docs/events/README.md',
  'tests/e2e/README.md',
]) {
  test(`explicit build-context exclusion: ${path} selects none`, () => {
    assert.deepEqual(servicesToBuild(ALL, [path]), []);
  });
}

for (const path of [
  'services/fleet-service/src/نام.ts',
  'services/fleet-service/src/with spaces.ts',
  'services/fleet-service/src/with\nnewline.ts',
  'services/fleet-service/src/ leading.ts',
  'services/fleet-service/src/trailing.ts ',
  ' docs/only.md',
  'services/fleet-service ',
]) {
  test(`CLI preserves exact committed filename ${JSON.stringify(path)}`, (t) => {
    const f = fixture(t);
    const result = f.run([path]);
    assert.deepEqual(result, path.startsWith('services/fleet-service/') ? ['fleet-service'] : ALL);
  });
}

for (const [from, to, expected] of [
  ['services/fleet-service/src/a.ts', 'docs/a.ts', ['fleet-service']],
  ['docs/a.ts', 'services/identity-service/src/a.ts', ['identity-service']],
  [
    'services/fleet-service/src/a.ts',
    'services/identity-service/src/a.ts',
    ['fleet-service', 'identity-service'],
  ],
  ['packages/shared/a.ts', 'docs/a.ts', ALL],
]) {
  test(`CLI real committed rename ${from} -> ${to}`, (t) => {
    const f = fixture(t);
    f.git('config', 'diff.renames', 'true');
    f.write(from, 'same content for a real detected rename\n');
    const base = f.commit();
    mkdirSync(dirname(join(f.dir, to)), { recursive: true });
    f.git('mv', from, to);
    f.commit();
    // Prove Git really detects the rename in the broken --name-only mode.
    assert.match(f.git('diff', '--name-status', `${base}...HEAD`), /^R100\s/);
    assert.deepEqual(JSON.parse(f.raw(['--base', base]).stdout), expected);
  });
}

for (const [name, args] of [
  ['missing base', []],
  ['malformed base', ['--base', 'not-a-sha']],
  ['unavailable base', ['--base', '0'.repeat(40)]],
]) {
  test(`CLI Git failure: ${name} is ALL rather than empty`, (t) => {
    const result = fixture(t).raw(args);
    assert.deepEqual(JSON.parse(result.stdout), ALL);
    assert.match(result.stderr, /^::warning::[^\r\n]+\n$/);
  });
}

test('CLI Git failure: no merge base is ALL rather than empty', (t) => {
  const f = fixture(t);
  f.git('checkout', '--orphan', 'unrelated');
  f.commit();
  const result = f.raw();
  assert.deepEqual(JSON.parse(result.stdout), ALL);
  assert.match(result.stderr, /::warning::Container scope: Git merge base unavailable;/);
});

for (const [name, status, output] of [
  ['non-zero diff exit', 1, ''],
  ['truncated non-empty diff', 0, 'docs/only.md'],
]) {
  test(`CLI Git failure: ${name} is ALL rather than empty`, (t) => {
    const f = fixture(t);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const shim = join(bin, 'git');
    writeFileSync(
      shim,
      `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[2] === 'diff') {
  process.stdout.write(${JSON.stringify(output)});
  process.stderr.write('untrusted source contents\\n::error::must not leak\\n');
  process.exit(${status});
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    );
    chmodSync(shim, 0o755);
    const result = f.raw(['--base', f.baseSha], { PATH: `${bin}:${process.env.PATH}` });
    assert.deepEqual(JSON.parse(result.stdout), ALL);
    assert.equal(
      result.stderr,
      '::warning::Container scope: Git diff failed or returned truncated output; building and scanning every image.\n',
    );
  });
}

test('CLI: parser error annotations omit source contents and stay one line', (t) => {
  const f = fixture(t, 'name: !private-source-text value\njobs: [');
  const result = f.raw();
  assert.deepEqual(JSON.parse(result.stdout), ALL);
  assert.equal(
    result.stderr,
    '::warning::Container scope: invalid or ambiguous workflow YAML; building and scanning every image.\n',
  );
});

test('filtered parser narrows: committed unrelated job change selects one image', (t) => {
  const f = fixture(t, WORKFLOW.replace('echo before', 'echo after'));
  const result = f.run(['services/fleet-service/src/main.ts']);
  assert.deepEqual(result, ['fleet-service']);
  assert.equal(f.raw().stderr, '');
  process.stderr.write(
    'Filtered-install proof: YAML comparison succeeded; selected [fleet-service], not ALL.\n',
  );
});

test('CI delegates paths to CLI and proves narrowing after its filtered install', () => {
  const { steps } = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).jobs[
    'container-scope'
  ];
  const install = steps.findIndex(
    (step) => step.name === 'Install scope parser from the frozen workspace lockfile',
  );
  const proof = steps.findIndex(
    (step) => step.name === 'Prove workflow narrowing with the filtered parser install',
  );
  assert.ok(proof > install);
  assert.equal(steps[proof].if, "github.event_name == 'pull_request'");
  assert.equal(steps[proof].run, 'node scripts/container-scope-proof.mjs');
  assert.doesNotMatch(steps.find((step) => step.id === 'scope').run, /git diff|\| node/);
});

test('allow-list proof stays valid for every Docker build context and scan input', () => {
  const ignore = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('docs'));
  assert.ok(ignore.includes('tests'));
  // Any new negation requires reviewing the exemptions rather than silently
  // re-including a path they skip. Only the root README.md is re-included.
  assert.deepEqual(
    ignore.filter((line) => line.startsWith('!')),
    ['!.env.example', '!README.md'],
  );
  for (const service of readdirSync(join(root, 'services'))) {
    const dockerfile = join(root, 'services', service, 'Dockerfile');
    if (!existsSync(dockerfile)) continue;
    assert.match(readFileSync(dockerfile, 'utf8'), /^COPY \. \.$/m);
    assert.equal(existsSync(`${dockerfile}.dockerignore`), false, service);
  }
  const workflow = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const build = workflow.jobs.containers.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(build.with.context, '.');
  assert.equal(build.with.file, 'services/${{ matrix.service }}/Dockerfile');
  const scan = workflow.jobs.containers.steps.find((step) =>
    step.uses?.startsWith('aquasecurity/trivy-action@'),
  );
  // One time-boxed exception file (CVE-2026-115905, expires 2026-11-04); the
  // earlier zod one went with the zod 4 migration.
  assert.equal(scan.with.trivyignores, '.trivyignore.services');
  assert.equal(scan.with['image-ref'], 'rasta/${{ matrix.service }}:${{ github.sha }}');
});

// Exercise BuildKit's matcher against the actual pinned ignore rules. FROM
// scratch needs no registry or network; export only to this disposable context.
test('BuildKit: !README.md re-includes only the context root', (t) => {
  // CI never skips. Locally only a missing docker binary or buildx plugin
  // skips (`pnpm verify` then does not run this proof); a stopped daemon, a
  // permission error, a timeout or a failing build still fail below.
  const probe = probeBuildx();
  if (maySkipBuildKitProof(probe)) {
    t.skip(`docker buildx is not installed (${probe.detail}); CI runs this proof`);
    return;
  }
  assert.equal(probe.state, 'available', `docker buildx is required: ${probe.detail}`);
  const dir = mkdtempSync(join(tmpdir(), 'container-scope-dockerignore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = join(dir, 'context');
  mkdirSync(context);
  copyFileSync(join(root, '.dockerignore'), join(context, '.dockerignore'));
  for (const path of [
    'README.md',
    'included.txt',
    'docs/README.md',
    'docs/events/README.md',
    'tests/README.md',
    'tests/e2e/README.md',
  ]) {
    mkdirSync(dirname(join(context, path)), { recursive: true });
    writeFileSync(join(context, path), 'matcher fixture\n');
  }
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
  const output = join(dir, 'output');
  const result = spawnSync(
    'docker',
    ['buildx', 'build', '--network=none', '--output', `type=local,dest=${output}`, context],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(output, 'README.md'), 'utf8'), 'matcher fixture\n');
  assert.equal(existsSync(join(output, 'included.txt')), true);
  assert.equal(existsSync(join(output, 'docs')), false);
  assert.equal(existsSync(join(output, 'tests')), false);
});

for (const workflowChanged of [false, true]) {
  test(`CLI: selection exception after diff names its stage (workflow changed: ${workflowChanged})`, (t) => {
    const f = fixture(t);
    if (!workflowChanged) {
      writeFileSync(f.workflow, WORKFLOW);
      f.commit();
    }
    const lib = join(f.dir, 'scripts/container-scope-lib.mjs');
    writeFileSync(
      lib,
      readFileSync(lib, 'utf8').replace(
        "  if (changed === 'all')",
        "  throw new Error('private source contents\\n::error::must not leak');\n  if (changed === 'all')",
      ),
    );
    const result = f.raw();
    assert.deepEqual(JSON.parse(result.stdout), ALL);
    assert.equal(
      result.stderr,
      '::warning::Container scope: service selection failed; building and scanning every image.\n',
    );
  });
}

const PROOF_TITLE =
  "test('filtered parser narrows: committed unrelated job change selects one image', (t) => {";

// Run the proof wrapper on a copy of the suite edited by `edit(source)`, as CI's
// shell launches it (outside this parent Node test runner).
function proofGuard(t, edit, { deleteTests = false } = {}) {
  const f = fixture(t);
  for (const name of [
    'container-scope.test.mjs',
    'container-scope-proof.mjs',
    'container-scope-buildx.mjs',
  ]) {
    copyFileSync(join(root, 'scripts', name), join(f.dir, 'scripts', name));
  }
  const tests = join(f.dir, 'scripts/container-scope.test.mjs');
  const source = readFileSync(tests, 'utf8');
  const edited = edit(source);
  // A no-op edit would leave the unchanged suite and prove nothing.
  if (edit !== keep) assert.notEqual(edited, source);
  writeFileSync(tests, edited);
  if (deleteTests) rmSync(tests);
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  return spawnSync(process.execPath, [join(f.dir, 'scripts/container-scope-proof.mjs')], {
    encoding: 'utf8',
    env,
  });
}

const keep = (source) => source;
// Every counter of a passing run, printed by the suite itself. node --test
// re-emits it as `# tests 1` ... in the middle of the TAP stream.
const FORGED_COUNTERS =
  "console.log('tests 1\\nsuites 0\\npass 1\\nfail 0\\ncancelled 0\\nskipped 0\\ntodo 0');\n";
const withOptions = (options) => (source) =>
  source.replace(PROOF_TITLE, PROOF_TITLE.replace("', (t)", `', ${options}, (t)`));
const forged = (edit) => (source) => `${edit(source)}\n${FORGED_COUNTERS}`;

for (const [mode, edit] of [
  ['unchanged', keep],
  [
    'renamed',
    // Change only the registered test title: the old raw Node command exits 0.
    (source) => source.replace("test('filtered parser narrows:", "test('renamed proof:"),
  ],
  ['duplicated', (source) => `${source}\ntest('filtered parser narrows: duplicate', () => {});\n`],
  [
    'failing',
    (source) =>
      source.replace(
        "assert.deepEqual(result, ['fleet-service']);",
        "assert.fail('proof failed');",
      ),
  ],
  // A skipped or todo proof prints its named `ok` line but did not prove anything.
  ['skipped', withOptions('{ skip: true }')],
  ['todo', withOptions('{ todo: true }')],
  // The review finding (#415 r1 F1): the suite prints the counters of a passing
  // run itself, while the runner's own closing block says otherwise. The old
  // wrapper matched `# pass 1` anywhere in stdout and exited 0 on all of these.
  ['skipped, with printed passing counters', forged(withOptions('{ skip: true }'))],
  ['todo, with printed passing counters', forged(withOptions('{ todo: true }'))],
  [
    'two tests in the summary, with printed passing counters',
    // One named top-level test with a subtest: `# tests 2` in the real summary.
    forged((source) =>
      source.replace(
        PROOF_TITLE,
        PROOF_TITLE.replace('(t) => {', '(t) => {\n  t.test("child", () => {});'),
      ),
    ),
  ],
]) {
  test(`CI proof guard: ${mode} narrowing test`, (t) => {
    const result = proofGuard(t, edit);
    const accepted = mode === 'unchanged';
    assert.equal(result.status, accepted ? 0 : 1, result.stdout + result.stderr);
    if (!accepted) assert.match(result.stderr, /requires exactly one passing narrowing test/);
    if (mode.includes('printed passing counters')) {
      // The forgery really reached stdout, so the rejection is not vacuous.
      assert.match(result.stdout, /^# pass 1$/m);
      assert.match(result.stdout, /^# skipped 0$/m);
    }
    if (mode === 'renamed') {
      assert.doesNotMatch(result.stdout, /^ok \d+ - filtered parser narrows:/m);
      assert.match(result.stdout, /^1\.\.0$/m);
    }
  });
}

test('CI proof guard: a deleted test file fails', (t) => {
  const result = proofGuard(t, keep, { deleteTests: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /requires exactly one passing narrowing test/);
});

test('CI proof guard: printed plan and ok lines stay `# `-prefixed, so they cannot pose as the runner', (t) => {
  const result = proofGuard(t, (source) =>
    withOptions('{ skip: true }')(
      `${source}\nconsole.log('1..1\\nok 9 - filtered parser narrows: printed');\n`,
    ),
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^# 1\.\.1$/m);
  assert.match(result.stdout, /^# ok 9 - filtered parser narrows: printed$/m);
  assert.doesNotMatch(result.stdout, /^ok 9 /m);
});

// ---------------------------------------------------------------------------
// Images are built where the merge is decided: main and the merge train.
// ---------------------------------------------------------------------------
const REPO = 'marabi766/RASTA';
const push = (ref) => ({ EVENT_NAME: 'push', REF: ref, REPOSITORY: REPO });
const pull = (head, headRepo = REPO) => ({
  EVENT_NAME: 'pull_request',
  REF: 'refs/pull/1/merge',
  HEAD_REF: head,
  HEAD_REPO: headRepo,
  REPOSITORY: REPO,
});

for (const [name, env, expected] of [
  ['push to main', push('refs/heads/main'), { mode: 'main' }],
  ['train 1', pull('mq/train-1'), { mode: 'train' }],
  ['train 12', pull('mq/train-12'), { mode: 'train' }],
  [
    'train, repository name in another case',
    pull('mq/train-2', 'MARABI766/rasta'),
    { mode: 'train' },
  ],
  ['ordinary branch', pull('feat/images'), { mode: 'pr' }],
  ['branch that merely mentions mq/train-1', pull('feat/mq/train-1'), { mode: 'pr' }],
  ['fork branch with an ordinary name', pull('main', 'someone/RASTA'), { mode: 'pr' }],
]) {
  test(`classifyRun: ${name}`, () => assert.deepEqual(classifyRun(env), expected));
}

for (const [name, env] of [
  ['push to another branch', push('refs/heads/feat/x')],
  ['push without a ref', { EVENT_NAME: 'push' }],
  ['workflow_dispatch', { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main' }],
  ['schedule', { EVENT_NAME: 'schedule' }],
  ['no event', {}],
  ['pull request without a head ref', pull('')],
  ['pull request with an undefined head ref', { ...pull('x'), HEAD_REF: undefined }],
  ['pull request without a head repository (deleted fork)', pull('feat/x', '')],
  ['pull request without a repository', { ...pull('feat/x'), REPOSITORY: '' }],
  ['head ref with a newline', pull('feat/x\nmq/train-1')],
  ['head ref with a control character', pull('feat/\u0007x')],
  ['mq/train-1 from a fork', pull('mq/train-1', 'someone/RASTA')],
  ['mq/train-0', pull('mq/train-0')],
  ['mq/train-01', pull('mq/train-01')],
  ['mq/train-', pull('mq/train-')],
  ['mq/train-1x', pull('mq/train-1x')],
  ['mq/train-1/extra', pull('mq/train-1/extra')],
  ['mq/other', pull('mq/other')],
  ['MQ/train-1 (the reserved namespace is case-insensitive)', pull('MQ/train-1')],
  ['mq/', pull('mq/')],
]) {
  test(`classifyRun: ${name} is unknown, never fewer images`, () => {
    const result = classifyRun(env);
    assert.equal(result.mode, 'unknown');
    assert.match(result.reason, /\S/);
  });
}

// The default is the gated behaviour: no reading of the environment may yield a
// mode that builds less than the affected set without being 'pr' by the rule.
test('classifyRun: only a well-formed pull request from another branch is "pr"', () => {
  for (const head of [
    'a',
    'feat/x',
    'fix/ci-images-on-train',
    'release-1',
    'mq-train-1',
    'mqx/train-1',
  ]) {
    assert.equal(classifyRun(pull(head)).mode, 'pr', head);
  }
});

function runScope(f, env) {
  const outputFile = join(f.dir, 'github-output');
  writeFileSync(outputFile, '');
  const result = f.raw(['--run'], { GITHUB_OUTPUT: outputFile, ...env });
  const parsed = JSON.parse(result.stdout);
  // The step output carries exactly the printed decision.
  assert.equal(
    readFileSync(outputFile, 'utf8'),
    `mode=${parsed.mode}\nservices=${JSON.stringify(parsed.services)}\n`,
  );
  return { ...parsed, stderr: result.stderr };
}

test('CLI --run: a push to main builds every image with no base and no YAML dependency', (t) => {
  const f = fixture(t);
  rmSync(join(f.dir, 'node_modules'));
  const result = runScope(f, push('refs/heads/main'));
  assert.deepEqual(result, { mode: 'main', services: ALL, stderr: '' });
});

test('CLI --run: an ordinary pull request builds no image, even for a service change', (t) => {
  const f = fixture(t);
  f.write('services/fleet-service/src/a.ts');
  f.commit();
  for (const head of ['feat/x', 'fix/ci-images-on-train']) {
    const result = runScope(f, { ...pull(head), BASE_SHA: f.baseSha });
    assert.deepEqual(result, { mode: 'pr', services: [], stderr: '' });
  }
  // It does not even need a base.
  assert.deepEqual(runScope(f, pull('feat/x')).services, []);
});

for (const [name, paths, expected] of [
  ['a service change builds that image', ['services/fleet-service/src/a.ts'], ['fleet-service']],
  ['a shared input builds every image', ['packages/nest-common/src/a.ts'], ALL],
  ['an unrecognised path builds every image', ['somewhere/else.txt'], ALL],
  ['docs only builds none (the reviewed exemption)', ['docs/a.md', 'tests/e2e/a.ts'], []],
]) {
  test(`CLI --run: a train run ${name}`, (t) => {
    const f = fixture(t);
    for (const path of paths) f.write(path);
    f.commit();
    const result = runScope(f, { ...pull('mq/train-1'), BASE_SHA: f.baseSha });
    assert.equal(result.mode, 'train');
    assert.deepEqual(result.services, expected);
  });
}

for (const [name, base] of [
  ['a missing base', undefined],
  ['an empty base', ''],
  ['a malformed base', 'not-a-sha'],
  ['an unavailable base', 'a'.repeat(40)],
]) {
  test(`CLI --run: a train run with ${name} builds every image`, (t) => {
    const f = fixture(t);
    f.write('docs/a.md');
    f.commit();
    const result = runScope(f, { ...pull('mq/train-1'), BASE_SHA: base });
    assert.equal(result.mode, 'train');
    assert.deepEqual(result.services, ALL);
    assert.match(
      result.stderr,
      /^::warning::Container scope: .+; building and scanning every image\.\n$/,
    );
  });
}

for (const [name, env] of [
  ['another event', { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main', REPOSITORY: REPO }],
  ['a push to another branch', push('refs/heads/feat/x')],
  ['a fork posing as the train', pull('mq/train-1', 'someone/RASTA')],
  ['a malformed train name', pull('mq/train-1x')],
  ['a pull request without a head ref', pull('')],
]) {
  test(`CLI --run: ${name} builds every image and says why`, (t) => {
    const f = fixture(t);
    f.write('docs/a.md');
    f.commit();
    const result = runScope(f, { ...env, BASE_SHA: f.baseSha });
    assert.equal(result.mode, 'unknown');
    assert.deepEqual(result.services, ALL);
    assert.match(
      result.stderr,
      /^::warning::Container scope: .+; building and scanning every image\.\n$/,
    );
  });
}

test('CLI --run: a hostile branch name is data, never a command or an annotation', (t) => {
  const f = fixture(t);
  const hostile = 'x"; echo pwned #\n::error::forged';
  const result = runScope(f, pull(hostile));
  assert.deepEqual(result.services, ALL);
  assert.equal(
    result.stderr,
    '::warning::Container scope: missing or malformed pull request metadata; building and scanning every image.\n',
  );
});

test('CLI --run takes no other argument', (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [join(f.dir, 'scripts/container-scope.mjs'), '--run', '--all'],
    { encoding: 'utf8', env: { ...process.env, ...push('refs/heads/main') } },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

// ---------------------------------------------------------------------------
// The aggregate check "Images built and scanned".
// ---------------------------------------------------------------------------
const needs = (mode, services, containers, scope = 'success') => ({
  'container-scope': { result: scope, outputs: { mode, services: JSON.stringify(services) } },
  containers: { result: containers },
});

for (const [name, input, ok] of [
  ['an ordinary PR with the image job skipped', needs('pr', [], 'skipped'), true],
  ['main with every image built', needs('main', ALL, 'success'), true],
  ['a train with every selected image built', needs('train', ['fleet-service'], 'success'), true],
  ['an unknown run with every image built', needs('unknown', ALL, 'success'), true],
  ['a docs-only train with the image job skipped', needs('train', [], 'skipped'), true],
  // The merge train must never see a pass for images that were not built.
  ['a train whose image job was skipped', needs('train', ['fleet-service'], 'skipped'), false],
  ['a train whose image job was cancelled', needs('train', ['fleet-service'], 'cancelled'), false],
  ['a train whose image job failed', needs('train', ['fleet-service'], 'failure'), false],
  ['main whose image job was skipped', needs('main', ALL, 'skipped'), false],
  ['an unknown run whose image job was skipped', needs('unknown', ALL, 'skipped'), false],
  ['main that selected no image', needs('main', [], 'skipped'), false],
  ['an unknown run that selected no image', needs('unknown', [], 'skipped'), false],
  ['a docs-only train whose image job ran and failed', needs('train', [], 'failure'), false],
  ['an ordinary PR that selected images', needs('pr', ['fleet-service'], 'skipped'), false],
  ['an ordinary PR whose image job ran', needs('pr', [], 'success'), false],
  ['a failed scope job', needs('train', ['fleet-service'], 'success', 'failure'), false],
  ['a skipped scope job', needs('pr', [], 'skipped', 'skipped'), false],
  ['a cancelled scope job', needs('pr', [], 'skipped', 'cancelled'), false],
  ['a missing mode', needs(undefined, ALL, 'success'), false],
  ['an unrecognised mode', needs('pull_request', ALL, 'success'), false],
  [
    'an empty services output',
    {
      ...needs('main', ALL, 'success'),
      'container-scope': { result: 'success', outputs: { mode: 'main', services: '' } },
    },
    false,
  ],
  [
    'a non-array services output',
    {
      ...needs('main', ALL, 'success'),
      'container-scope': { result: 'success', outputs: { mode: 'main', services: '"all"' } },
    },
    false,
  ],
  ['an empty service name', needs('main', [''], 'success'), false],
  [
    'a missing image job',
    { 'container-scope': needs('main', ALL, 'success')['container-scope'] },
    false,
  ],
  ['a missing scope job', { containers: { result: 'success' } }, false],
  ['no needs at all', undefined, false],
  ['null needs', null, false],
]) {
  test(`images check: ${name} is ${ok ? 'success' : 'red'}`, () => {
    const verdict = imagesGateVerdict(input);
    assert.equal(verdict.ok, ok, verdict.message);
    assert.match(verdict.message, /\S/);
  });
}

test('images check: an ordinary PR says the images are built on the train', () => {
  assert.equal(imagesGateVerdict(needs('pr', [], 'skipped')).message, IMAGES_ON_TRAIN_NOTE);
  assert.match(IMAGES_ON_TRAIN_NOTE, /merge train \(mq\/train-\*\) and on main/);
});

function runGate(t, value, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'container-scope-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  const { NODE_TEST_CONTEXT: _testContext, ...base } = process.env;
  const result = spawnSync(process.execPath, [join(root, 'scripts/container-scope-gate.mjs')], {
    encoding: 'utf8',
    env: { ...base, GITHUB_STEP_SUMMARY: summary, ...extraEnv, NEEDS: value },
  });
  return { ...result, summary: readFileSync(summary, 'utf8') };
}

test('images check CLI: success writes the summary and exits 0', (t) => {
  const result = runGate(t, JSON.stringify(needs('pr', [], 'skipped')));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.summary, /Images built and scanned: success/);
  assert.match(result.summary, /merge train \(mq\/train-\*\) and on main/);
});

for (const [name, value] of [
  ['a skipped image job on a train', JSON.stringify(needs('train', ['fleet-service'], 'skipped'))],
  ['an unset NEEDS', undefined],
  ['malformed NEEDS', '{not json'],
  ['an empty object', '{}'],
]) {
  test(`images check CLI: ${name} exits 1 with an error annotation`, (t) => {
    const result = runGate(t, value ?? '');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::Images built and scanned: .+$/m);
    assert.match(result.summary, /Images built and scanned: FAILED/);
  });
}

// ---------------------------------------------------------------------------
// BuildKit proof: only a missing buildx may skip it, and only outside CI.
// ---------------------------------------------------------------------------
function fakeDocker(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'container-scope-docker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (script !== undefined) {
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'docker'), 0o755);
  }
  return dir;
}

const PLUGIN_ABSENT_SCRIPT = `echo "docker: 'buildx' is not a docker command." >&2\necho "See 'docker --help'" >&2\nexit 1`;
// buildx is present; the build itself fails (for example a stopped daemon).
const BUILD_FAILS_SCRIPT = `case "$2" in version) echo "github.com/docker/buildx v0.0.0"; exit 0;; esac\necho "Cannot connect to the Docker daemon" >&2\nexit 1`;

for (const [name, script, expected] of [
  ['no docker binary', undefined, 'missing'],
  ['a docker without the buildx plugin', PLUGIN_ABSENT_SCRIPT, 'missing'],
  [
    'a docker without the buildx plugin (newer wording)',
    `echo "unknown command: docker buildx" >&2\nexit 1`,
    'missing',
  ],
  ['buildx present', `echo "github.com/docker/buildx v0.37.1"`, 'available'],
  [
    'a daemon error',
    `echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2\nexit 1`,
    'broken',
  ],
  [
    'permission denied by the docker CLI',
    `echo "permission denied while trying to connect to the Docker daemon socket" >&2\nexit 1`,
    'broken',
  ],
  [
    'another failure naming buildx',
    `echo "buildx: failed to read the builder config" >&2\nexit 1`,
    'broken',
  ],
  ['a kill signal', `kill -9 $$`, 'broken'],
]) {
  test(`probeBuildx: ${name} is ${expected}`, (t) => {
    const dir = fakeDocker(t, script);
    assert.equal(probeBuildx({ env: { PATH: dir } }).state, expected);
  });
}

test('probeBuildx: a docker that is not executable (EACCES) is broken, not missing', (t) => {
  const dir = fakeDocker(t, 'exit 0');
  chmodSync(join(dir, 'docker'), 0o644);
  assert.equal(probeBuildx({ env: { PATH: dir } }).state, 'broken');
});

test('probeBuildx: a probe that times out is broken, not missing', (t) => {
  const dir = fakeDocker(t, 'exec /bin/sleep 20');
  assert.equal(probeBuildx({ env: { PATH: dir }, timeout: 300 }).state, 'broken');
});

test('maySkipBuildKitProof: only a missing tool outside CI may skip', () => {
  assert.equal(maySkipBuildKitProof({ state: 'missing' }, undefined), true);
  assert.equal(maySkipBuildKitProof({ state: 'missing' }, ''), true);
  assert.equal(maySkipBuildKitProof({ state: 'missing' }, 'true'), false);
  assert.equal(maySkipBuildKitProof({ state: 'broken' }, undefined), false);
  assert.equal(maySkipBuildKitProof({ state: 'available' }, undefined), false);
});

// Run the real BuildKit test of this suite under a docker of our choosing.
function buildKitProofUnder(t, dockerDir, ci) {
  const f = fixture(t);
  for (const name of ['container-scope.test.mjs', 'container-scope-buildx.mjs']) {
    copyFileSync(join(root, 'scripts', name), join(f.dir, 'scripts', name));
  }
  copyFileSync(join(root, '.dockerignore'), join(f.dir, '.dockerignore'));
  const { NODE_TEST_CONTEXT: _testContext, CI: _ci, ...base } = process.env;
  return spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=^BuildKit:',
      join(f.dir, 'scripts/container-scope.test.mjs'),
    ],
    { encoding: 'utf8', env: { ...base, PATH: dockerDir, ...(ci ? { CI: 'true' } : {}) } },
  );
}

test('BuildKit proof: buildx missing skips locally with a clear message', (t) => {
  for (const script of [undefined, PLUGIN_ABSENT_SCRIPT]) {
    const result = buildKitProofUnder(t, fakeDocker(t, script), false);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^ok \d+ - BuildKit: .* # SKIP docker buildx is not installed/m);
    assert.match(result.stdout, /^# skipped 1$/m);
  }
});

test('BuildKit proof: buildx missing fails in CI', (t) => {
  for (const script of [undefined, PLUGIN_ABSENT_SCRIPT]) {
    const result = buildKitProofUnder(t, fakeDocker(t, script), true);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /^not ok \d+ - BuildKit: /m);
    assert.match(result.stdout, /docker buildx is required/);
  }
});

test('BuildKit proof: buildx present but the build failing fails, in CI and locally', (t) => {
  for (const ci of [false, true]) {
    const result = buildKitProofUnder(t, fakeDocker(t, BUILD_FAILS_SCRIPT), ci);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /^not ok \d+ - BuildKit: /m);
    assert.match(result.stdout, /Cannot connect to the Docker daemon/);
  }
});

test('BuildKit proof: a broken probe (permission denied) fails locally', (t) => {
  const dir = fakeDocker(t, 'exit 0');
  chmodSync(join(dir, 'docker'), 0o644);
  const result = buildKitProofUnder(t, dir, false);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /^not ok \d+ - BuildKit: /m);
});

// The Trivy DB job's condition is the workflow's own expression, evaluated here
// as JavaScript (it uses only ||, !, != and startsWith). It must run for every
// run that classifyRun would build images for.
test('trivy-db runs for every run that builds an image and skips only ordinary pull requests', () => {
  const { jobs } = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const expression = jobs['trivy-db'].if
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const startsWith = (value, prefix) =>
    String(value).toLowerCase().startsWith(prefix.toLowerCase());
  const runs = (env) =>
    new Function('github', 'startsWith', `return (${expression});`)(
      {
        event_name: env.EVENT_NAME,
        event: { pull_request: { head: { ref: env.HEAD_REF } } },
      },
      startsWith,
    );
  const envs = [
    push('refs/heads/main'),
    push('refs/heads/feat/x'),
    { EVENT_NAME: 'workflow_dispatch' },
    {},
    pull('mq/train-1'),
    pull('mq/train-1', 'someone/RASTA'),
    pull('MQ/train-3'),
    pull('mq/other'),
    pull('mq/'),
    pull(''),
    { ...pull('x'), HEAD_REF: undefined },
    pull('feat/x'),
    pull('feat/mq/train-1'),
    pull('fix/ci-images-on-train'),
  ];
  for (const env of envs) {
    const builds = classifyRun(env).mode !== 'pr';
    if (builds) assert.equal(runs(env), true, JSON.stringify(env));
    else assert.equal(runs(env), false, JSON.stringify(env));
  }
});
