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
import { servicesToBuild } from './container-scope-lib.mjs';

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

for (const path of [
  '.trivyignore.services',
  'docs/.trivyignore.services',
  'services/fleet-service/.trivyignore.services',
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
  assert.equal(scan.with.trivyignores, '.trivyignore.services');
  assert.equal(scan.with['image-ref'], 'rasta/${{ matrix.service }}:${{ github.sha }}');
});

// Exercise BuildKit's matcher against the actual pinned ignore rules. FROM
// scratch needs no registry or network; export only to this disposable context.
test('BuildKit: !README.md re-includes only the context root', (t) => {
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

for (const mode of ['unchanged', 'renamed', 'duplicated', 'failing']) {
  test(`CI proof guard: ${mode} narrowing test`, (t) => {
    const f = fixture(t);
    for (const name of ['container-scope.test.mjs', 'container-scope-proof.mjs']) {
      copyFileSync(join(root, 'scripts', name), join(f.dir, 'scripts', name));
    }
    const tests = join(f.dir, 'scripts/container-scope.test.mjs');
    const source = readFileSync(tests, 'utf8');
    if (mode === 'renamed') {
      // Change only the registered test title: the old raw Node command exits 0.
      writeFileSync(
        tests,
        source.replace("test('filtered parser narrows:", "test('renamed proof:"),
      );
    } else if (mode === 'duplicated') {
      writeFileSync(tests, `${source}\ntest('filtered parser narrows: duplicate', () => {});\n`);
    } else if (mode === 'failing') {
      writeFileSync(
        tests,
        source.replace(
          "assert.deepEqual(result, ['fleet-service']);",
          "assert.fail('proof failed');",
        ),
      );
    }
    // Launch as CI's shell does, outside this parent Node test runner.
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    const result = spawnSync(process.execPath, [join(f.dir, 'scripts/container-scope-proof.mjs')], {
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, mode === 'unchanged' ? 0 : 1, result.stdout + result.stderr);
    if (mode !== 'unchanged') {
      assert.match(result.stderr, /requires exactly one passing narrowing test/);
    }
    if (mode === 'renamed') {
      assert.doesNotMatch(result.stdout, /^ok \d+ - filtered parser narrows:/m);
      assert.match(result.stdout, /^1\.\.0$/m);
    }
  });
}
