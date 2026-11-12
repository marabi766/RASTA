import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoredFiles } from './authored-source-inventory.cjs';
import { generate, schemaArgs } from './prisma-generate.mjs';
import { createHash } from 'node:crypto';
import { dockerRun, effectiveShell, readOptions, readShell } from './ci-shell-policy-lib.mjs';
import { parseCommands } from './ci-shell-text-lib.mjs';
import * as lifecycleLib from './prisma-lifecycle-suppression-lib.mjs';

const { CONTAINER_SCRIPTS, ENV_PAIRS, MATRIX, MOUNTS, lifecycleFileKind } = lifecycleLib;
// FU-334: every file a step runs, uses or builds is a member of this inventory, read once.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = new Set(
  [...authoredFiles(ROOT)].map((file) => relative(ROOT, file).replaceAll('\\', '/')),
);
const inInventory =
  (check) =>
  (name, text, workflows, files = FILES) =>
    check(name, text, workflows, files);
const dockerfileLifecycle = inInventory(lifecycleLib.dockerfileLifecycle);
const workflowLifecycle = inInventory(lifecycleLib.workflowLifecycle);
const actionLifecycle = inInventory(lifecycleLib.actionLifecycle);

async function probe(results) {
  let calls = 0;
  const delays = [];
  const logs = [];
  const code = await generate({
    run: () => results[Math.min(calls++, results.length - 1)],
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (message) => logs.push(message),
  });
  return { code, calls, delays, logs };
}

const downloadFailure = (reason) =>
  `Error: request to https://binaries.prisma.sh/all_commits/abc/linux/schema-engine.gz failed, reason: ${reason}`;
for (const stderr of [
  'Error: aborted\n    at TLSSocket.socketCloseListener (node:_http_client:464:19)',
  ...['read ECONNRESET', 'connect ETIMEDOUT', 'socket hang up', 'fetch failed'].map(
    downloadFailure,
  ),
]) {
  test(`transient stderr retries then succeeds: ${stderr}`, async () => {
    const result = await probe([{ status: 1, stderr }, { status: 0 }]);
    assert.equal(result.code, 0);
    assert.equal(result.calls, 2);
    assert.deepEqual(result.delays, [2000]);
    assert.ok(result.logs.some((line) => line.includes('retry 2/3')));
    assert.ok(result.logs.includes(stderr));
  });
}

test('schema and unknown failures fail immediately, including stdout-only network text', async () => {
  for (const stderr of [
    'Error: P1012 schema validation',
    'Error: P1012 schema validation: fetch failed',
    '',
    'unknown failure',
    'Error: aborted',
    'ECONNRESET',
    'TypeError: fetch failed',
    ...['ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'fetch failed', 'Error: aborted'].map(
      (value) => `Error: Unknown binary target ${value} in generator client.`,
    ),
    `Error: Unknown binary target ${downloadFailure('read ECONNRESET')} in generator client.`,
  ]) {
    const result = await probe([{ status: 7, stderr, stdout: 'Error: aborted' }]);
    assert.equal(result.code, 7);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.delays, []);
  }
});

test('persistent network failures stop at three attempts', async () => {
  const result = await probe([{ status: 9, stderr: downloadFailure('read ECONNRESET') }]);
  assert.equal(result.code, 9);
  assert.equal(result.calls, 3);
  assert.deepEqual(result.delays, [2000, 5000]);
  assert.equal(result.logs.filter((line) => line.includes('retry')).length, 2);
});

test('signals and process errors never retry even with transient stderr', async () => {
  for (const failure of [{ signal: 'SIGTERM' }, { error: new Error('timeout') }, {}]) {
    const result = await probe([
      { status: null, stderr: downloadFailure('read ECONNRESET'), ...failure },
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.calls, 1);
  }
});

test('every service generation and build uses the shared boundary', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of authoredFiles(root)) {
    const service = relative(root, file).replaceAll('\\', '/');
    if (!/^services\/[^/]+\/package\.json$/.test(service)) continue;
    const pkg = JSON.parse(readFileSync(file));
    if (!pkg.scripts['db:generate']) continue;
    assert.equal(pkg.scripts['db:generate'], 'node ../../scripts/prisma-generate.mjs', service);
    assert.ok(pkg.scripts.build.startsWith(`${pkg.scripts['db:generate']} &&`), service);
  }
});

test('schema selection refuses unknown arguments, outside paths, missing files and symlinks', () => {
  const cwd = fileURLToPath(new URL('../services/economic-service/', import.meta.url));
  const cache = join(cwd, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'settlement-rollback-'));
  try {
    const schema = join(dir, 'prisma/schema.prisma');
    mkdirSync(join(dir, 'prisma'));
    writeFileSync(schema, '');
    assert.deepEqual(schemaArgs([]), []);
    assert.deepEqual(schemaArgs(['--schema', schema], cwd), ['--schema', schema]);
    for (const argv of [
      ['--help'],
      ['--schema', 'prisma/schema.prisma'],
      ['--schema', schema, '--help'],
      ['--schema', join(dir, 'missing')],
    ])
      assert.throws(() => schemaArgs(argv, cwd));
    assert.throws(() => schemaArgs(['--schema', schema], '/tmp'));
    rmSync(schema);
    assert.throws(() => schemaArgs(['--schema', schema], cwd));
    symlinkSync(join(cwd, 'prisma/schema.prisma'), schema);
    assert.throws(() => schemaArgs(['--schema', schema], cwd));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Developer watch commands intentionally retain immediate local generation.
const DEV_SERVICES = new Set(
  [
    'analytics',
    'asset',
    'audit',
    'construction',
    'contract',
    'document',
    'economic',
    'fleet',
    'identity',
    'inventory',
    'maintenance',
    'marketplace',
    'notification',
    'organization',
    'procurement',
    'supplier',
  ].map((name) => `services/${name}-service/package.json`),
);
// Exact exclusions only; additional calls even in these files are refused.
const EXAMPLES = new Map([
  [
    'scripts/fixtures/marketplace-pre-protocol-package.json',
    [
      // Historical manifest snapshot, never installed or executed.
      '"build": "prisma generate &&',
      '"dev": "prisma generate &&',
      '"db:generate": "prisma generate"',
    ],
  ],
  [
    'scripts/service-dev-loader.test.mjs',
    [
      // Assertions for the explicitly allowed developer watch commands.
      "'prisma generate && node ",
      '/^prisma generate && node /',
    ],
  ],
  [
    'scripts/copy-prisma-client.mjs',
    [
      // Diagnostic text only.
      'Run `prisma generate` before building.',
    ],
  ],
]);

test('authored generation callers and install hooks use the enforced boundary', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of authoredFiles(root)) {
    const path = relative(root, file).replaceAll('\\', '/');
    if (path === 'scripts/prisma-generate.mjs') continue;
    if (!(
      /(?:^|\/)(?:scripts|tests?|workflows)\//.test(path) ||
      /(?:package\.json|pnpm-workspace\.yaml|Dockerfile)$/.test(path)
    ))
      continue;
    let source = readFileSync(file, 'utf8');
    if (path === 'scripts/prisma-generate.test.mjs') {
      // Remove this check's inert examples and its developer-script regex only.
      const begin = source.indexOf('const EXAMPLES =');
      const end = source.indexOf("\ntest('authored generation", begin);
      source = source.slice(0, begin) + source.slice(end);
      source = source.replace('/^prisma' + ' generate && node /', '');
    }
    for (const example of EXAMPLES.get(path) ?? []) {
      assert.ok(source.includes(example), path);
      source = source.replace(example, '');
    }
    if (DEV_SERVICES.has(path)) {
      const pkg = JSON.parse(source);
      assert.match(pkg.scripts.dev, /^prisma generate && node /, path);
      delete pkg.scripts.dev;
      source = JSON.stringify(pkg);
    }
    source = source.replace(/^\s*\/\/.*$/gm, '');
    // Both shell commands and literal argv arrays; helper-based CLI calls too.
    assert.doesNotMatch(
      source,
      /\bprisma(?:[\s'",]+|[^\n]*?build\/index\.js['",\s]+)generate\b|(?:prismaCli|mustRun)\(\s*\[\s*['"]generate['"]/,
      path,
    );
  }
});

// FU-329: where a command runs decides, not which command it is; see the library.
const LIFECYCLE_CHECKS = {
  dockerfile: dockerfileLifecycle,
  workflow: workflowLifecycle,
  action: actionLifecycle,
};
const repoText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const swap = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `one ${from}`);
  return text.replace(from, () => to);
};
const UNPROVEN = /a command this check cannot prove hands on the environment/;
const NOT_NODE = /does not start `node` directly/;
const refused = (check, name, text, pattern) => {
  const { errors } = check(name, text);
  assert.ok(errors.length > 0, `${name} was accepted`);
  assert.match(errors.join('\n'), pattern, name);
};

test('every Dockerfile stage, workflow step and action runs lifecycle hooks suppressed', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const seen = { dockerfile: [], workflow: [], action: [] };
  const files = [...authoredFiles(root)];
  const workflows = Object.fromEntries(
    files
      .filter(
        (file) => lifecycleFileKind(relative(root, file).replaceAll('\\', '/')) === 'workflow',
      )
      .map((file) => [relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')]),
  );
  for (const file of files) {
    const path = relative(root, file).replaceAll('\\', '/');
    const kind = lifecycleFileKind(path);
    if (!kind) continue;
    seen[kind].push(path);
    const { errors, commands } = LIFECYCLE_CHECKS[kind](
      path,
      readFileSync(file, 'utf8'),
      workflows,
    );
    assert.deepEqual(errors, [], path);
    // Not vacuous: the commands the finding was about are read, inside a suppressed stage or step.
    if (/^services\/[^/]+\/Dockerfile$/.test(path))
      assert.deepEqual(commands, ['npm install', 'pnpm install', 'pnpm deploy'], path);
    if (kind === 'workflow') assert.ok(commands.includes('pnpm install'), path);
  }
  assert.ok(seen.dockerfile.length >= 17, 'every service Dockerfile is read');
  assert.ok(seen.workflow.includes('.github/workflows/ci.yml'));
  assert.ok(seen.workflow.includes('.github/workflows/backup-drill-monthly.yml'));
  assert.ok(seen.action.length >= 2, 'the composite actions are read');
  for (const path of ['Dockerfile', 'a/web.Dockerfile', 'a/Dockerfile.dev', 'a/x.dockerfile'])
    assert.equal(lifecycleFileKind(path), 'dockerfile', path);
  assert.equal(lifecycleFileKind('.github/workflows/new.yaml'), 'workflow');
  assert.equal(lifecycleFileKind('.github/actions/new/action.yaml'), 'action');
});

test('local workflow calls prove their own suppression; missing, mixed, remote and cyclic calls refuse', () => {
  const caller = '.github/workflows/caller.yml';
  const target = '.github/workflows/child.yaml';
  const call = (uses) =>
    `env:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\njobs:\n  call:\n    uses: ${uses}\n`;
  const child =
    "env:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\njobs:\n  run:\n    steps:\n      - run: pnpm install\n";
  const source = call(`./${target}`);
  const check = (text = source, workflows = { [target]: child }) =>
    workflowLifecycle(caller, text, workflows);
  assert.deepEqual(check(), { errors: [], commands: ['pnpm install'] });
  assert.match(
    check(source, {
      [target]: child.replace("  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'", ''),
    }).errors.join('\n'),
    /runs without PRISMA_SKIP_POSTINSTALL_GENERATE/,
  );
  for (const text of [
    call('owner/repo/.github/workflows/child.yaml@main'),
    call('./.github/workflows/../child.yaml'),
    call('[./.github/workflows/child.yaml]'),
    call('${{ inputs.workflow }}'),
    `${source}    steps: []\n`,
    `${source}    env: {}\n`,
  ])
    assert.match(check(text).errors.join('\n'), /not a local call without runner settings/);
  assert.match(check(source, {}).errors.join('\n'), /unreadable/);
  assert.match(check(source, { [target]: '' }).errors.join('\n'), /no jobs were read/);
  assert.match(check(source, { [target]: 'jobs: [' }).errors.join('\n'), /cannot be read/);
  assert.match(
    check(source, { [target]: call(`./${caller}`), [caller]: source }).errors.join('\n'),
    /cyclic workflow call/,
  );
  const nested = '.github/workflows/nested.yml';
  assert.deepEqual(check(source, { [target]: call(`./${nested}`), [nested]: child }).errors, []);
});

test('a Dockerfile lifecycle command outside a suppressed stage is refused', () => {
  const name = 'services/economic-service/Dockerfile';
  const real = repoText(name);
  const setting = 'ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true\n';
  const deploy = 'CI=true pnpm --filter @rasta/economic-service deploy --prod --legacy /deploy';
  const base = real.match(/^FROM (\S+) AS deps$/m)[1];
  const outside = /outside a stage that sets/;
  const onlyBy = /may be set only by the instruction/;
  for (const [mutant, pattern] of [
    // The suppression is dropped, for the stage or for the deploy alone.
    [swap(real, setting, ''), outside],
    [swap(real, 'FROM deps AS build', `FROM ${base} AS build`), outside],
    [swap(real, deploy, `PRISMA_SKIP_POSTINSTALL_GENERATE= ${deploy}`), onlyBy],
    [swap(real, deploy, `unset PRISMA_SKIP_POSTINSTALL_GENERATE && ${deploy}`), onlyBy],
    [swap(real, deploy, `env -i ${deploy}`), UNPROVEN],
    [swap(real, setting, 'ENV PRISMA_SKIP_POSTINSTALL_GENERATE=\n'), onlyBy],
    [swap(real, setting, 'ENV PRISMA_SKIP_POSTINSTALL_GENERATE=false\n'), onlyBy],
    [swap(real, setting, 'ARG PRISMA_SKIP_POSTINSTALL_GENERATE=true\n'), onlyBy],
    [swap(real, setting, `${setting}ENV PRISMA_SKIP_POSTINSTALL_GENERATE=\n`), onlyBy],
    // Set too late: the commands before it ran without it.
    [
      swap(real, setting, '').replace('FROM deps AS build\n', `FROM deps AS build\n${setting}`),
      outside,
    ],
    // A new lifecycle command where nothing is suppressed, in each shape a build can run it.
    [
      swap(real, 'USER rasta\n', `RUN pnpm --filter @rasta/x deploy --prod /out\nUSER rasta\n`),
      outside,
    ],
    [swap(real, 'USER rasta\n', 'RUN ["pnpm", "deploy", "/out"]\nUSER rasta\n'), outside],
    [swap(real, 'USER rasta\n', 'RUN ./scripts/install.sh\nUSER rasta\n'), outside],
    [swap(real, 'USER rasta\n', 'RUN rm -rf /tmp/x && npm rebuild\nUSER rasta\n'), outside],
    [`${real}FROM ${base} AS extra\nRUN pnpm deploy /out\n`, outside],
    [swap(real, 'CMD ["node", "dist/main.js"]', 'CMD ["pnpm", "start"]'), NOT_NODE],
    [swap(real, `FROM ${base} AS deps`, `RUN pnpm deploy /out\nFROM ${base} AS deps`), outside],
    // Forms that are not read are refused, never read past.
    [
      swap(real, 'USER rasta\n', 'ONBUILD RUN pnpm install\nUSER rasta\n'),
      /ONBUILD is not an instruction/,
    ],
    [swap(real, 'USER rasta\n', 'RUN <<EOF\npnpm install\nEOF\nUSER rasta\n'), /here-document/],
    [swap(real, 'FROM deps AS build', 'FROM --platform=linux/amd64 deps AS build'), /not a form/],
  ])
    refused(dockerfileLifecycle, name, mutant, pattern);
  // Controls: the same additions inside the suppressed stages are read and accepted.
  const added = dockerfileLifecycle(
    name,
    swap(
      real,
      'FROM deps AS build\n',
      'FROM deps AS build\nRUN pnpm --filter @rasta/x deploy /out\n',
    ),
  );
  assert.deepEqual(added.errors, []);
  assert.deepEqual(added.commands, ['npm install', 'pnpm install', 'pnpm deploy', 'pnpm deploy']);
});

test('a workflow step or an action outside the suppression is refused', () => {
  const name = '.github/workflows/ci.yml';
  const real = repoText(name);
  const setting = "  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n";
  const install = '      - run: pnpm install --frozen-lockfile\n';
  const first = (to) => real.replace(install, () => to);
  assert.ok(real.includes(install));
  const without = /runs without PRISMA_SKIP_POSTINSTALL_GENERATE/;
  const onlyAs = /may be named only as a workflow, job or step env entry/;
  const notTrue = /must be the string 'true'/;
  for (const [mutant, pattern] of [
    [swap(real, setting, ''), without],
    [swap(real, setting, "  PRISMA_SKIP_POSTINSTALL_GENERATE: ''\n"), notTrue],
    [swap(real, setting, '  PRISMA_SKIP_POSTINSTALL_GENERATE: true\n'), notTrue],
    [swap(real, setting, "  PRISMA_SKIP_POSTINSTALL_GENERATE: 'false'\n"), notTrue],
    // A narrower level or the command itself takes it away again.
    [first(`${install}        env:\n          PRISMA_SKIP_POSTINSTALL_GENERATE: ''\n`), notTrue],
    [first('      - run: PRISMA_SKIP_POSTINSTALL_GENERATE= pnpm install\n'), onlyAs],
    [first('      - run: unset PRISMA_SKIP_POSTINSTALL_GENERATE; pnpm deploy /out\n'), onlyAs],
    [first('      - run: echo "PRISMA_SKIP_POSTINSTALL_GENERATE=" >> "$GITHUB_ENV"\n'), onlyAs],
    [first('      - run: env -i pnpm deploy /out\n'), UNPROVEN],
    [first(`${install}        shell: env -i bash {0}\n`), /shell .* is not one this check reads/],
    [
      `${real}  called:\n    uses: ./.github/workflows/other.yml\n`,
      /called workflow is unreadable/,
    ],
  ])
    refused(workflowLifecycle, name, mutant, pattern);

  // A wrapper is refused whatever it runs: the package manager may be inside what it starts.
  refused(workflowLifecycle, name, first('      - run: sudo apt-get install -y jq\n'), UNPROVEN);

  // A new workflow: suppressed at any of the three levels, for every step, or refused.
  const fresh = (top, job, step) =>
    `on: push\n${top}jobs:\n  a:\n    runs-on: x\n${job}    steps:\n      - run: pnpm deploy /out\n${step}` +
    '  b:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n';
  const at = (indent) => `${indent}env:\n${indent}  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n`;
  assert.deepEqual(workflowLifecycle('new.yml', fresh(at(''), '', '')).errors, []);
  refused(workflowLifecycle, 'new.yml', fresh('', '', ''), /job a step 1 runs without/);
  // Job a is covered by its own env; job b, which only calls an action, is not.
  for (const text of [fresh('', at('    '), ''), fresh('', '', at('        '))]) {
    const { errors } = workflowLifecycle('new.yml', text);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /job b step 1 runs without/);
  }
  refused(workflowLifecycle, 'new.yml', 'on: push\njobs: {}\n', /no jobs were read/);
  refused(workflowLifecycle, 'new.yml', 'on: [push\n', /cannot be read/);
  // A step repeated through an alias is read at every place it runs.
  const aliased = fresh('', '', '').replace(
    '- run: pnpm deploy /out',
    '- &s\n        run: pnpm deploy /out',
  );
  const twice = workflowLifecycle('new.yml', swap(aliased, '- uses: actions/checkout@v4', '- *s'));
  assert.deepEqual(twice.commands, ['pnpm deploy', 'pnpm deploy']);
  assert.match(twice.errors.join('\n'), /job a step 1 runs without[^]*job b step 1 runs without/);

  const action = '.github/actions/install-ci-tool/action.yml';
  const composite = repoText(action);
  // A lifecycle command added to an action is read; it runs in its caller's environment.
  const more = (step) => `${composite}    - shell: bash\n      run: pnpm deploy /out\n${step}`;
  assert.deepEqual(actionLifecycle(action, more('')), { errors: [], commands: ['pnpm deploy'] });
  for (const [mutant, pattern] of [
    [more("      env:\n        PRISMA_SKIP_POSTINSTALL_GENERATE: ''\n"), /may not name it/],
    [
      more('    - shell: bash\n      run: unset PRISMA_SKIP_POSTINSTALL_GENERATE\n'),
      /may not name it/,
    ],
    [
      more('    - shell: env -i bash {0}\n      run: pnpm i\n'),
      /shell .* is not one this check reads/,
    ],
    [more('    - shell: bash\n      run: sudo pnpm i\n'), UNPROVEN],
    [swap(composite, 'using: composite', 'using: node20'), /not a composite action/],
  ])
    refused(actionLifecycle, action, mutant, pattern);
});

// The three places shell text runs: a RUN of a suppressed stage, a workflow step, an action step.
const ENTRY = {
  docker: 'services/economic-service/Dockerfile',
  action: '.github/actions/install-ci-tool/action.yml',
};
const indent = (script, by) => script.replaceAll(/^/gm, by);
const runs = {
  dockerfile: (script) =>
    dockerfileLifecycle(
      ENTRY.docker,
      swap(
        repoText(ENTRY.docker),
        'FROM deps AS build\n',
        `FROM deps AS build\nRUN ${script.replaceAll('\n', ' && ')}\n`,
      ),
    ),
  workflow: (script) =>
    workflowLifecycle(
      'new.yml',
      `on: push\nenv:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: |\n${indent(script, '          ')}\n`,
    ),
  action: (script) =>
    actionLifecycle(
      ENTRY.action,
      `${repoText(ENTRY.action)}    - shell: bash\n      run: |\n${indent(script, '        ')}\n`,
    ),
};
const everywhere = (script, pattern, accepted = false) => {
  for (const [where, run] of Object.entries(runs)) {
    const { errors } = run(script);
    // PR #1100 r1 F2: a RUN starts in the image: a control that needs the checkout is refused there.
    const image =
      where === 'dockerfile' && /(?:scripts|infrastructure|services)\/|git |psql /.test(script);
    if (accepted && !image) assert.deepEqual(errors, [], `${where}: ${script}`);
    else assert.match(errors.join('\n'), pattern ?? /is not a f|is followed|only the l/, script);
  }
};
const form = (name) => new RegExp(`is not a form of \`${name}\` this check reads`);

// PR #1085 r1 F1: every probe the reviewer ran, and the same gap in other spellings. Each was
// accepted with no error at ac94f313.
test('shell text that could drop the suppression is refused wherever it runs', () => {
  for (const [script, pattern] of [
    // The reviewer's probes, as run.
    [
      'unset PRISMA_SKIP_"POSTINSTALL_GENERATE"; pnpm deploy /out',
      /names PRISMA_SKIP_POSTINSTALL|may be set only by the instruction/,
    ],
    [`e'n'v -i PATH="$PATH" pnpm deploy /out`, UNPROVEN],
    ['exec -c pnpm deploy /out', UNPROVEN],
    ['env -i n"pm" rebuild', UNPROVEN],
    ['env -i node scripts/deploy.mjs', UNPROVEN],
    ['docker run --rm node:22 npm install @prisma/client', form('docker')],
    // The same gap, other spellings: a command word that is computed, unknown or runs another.
    ['$PM rebuild', UNPROVEN],
    ['"$(command -v pnpm)" deploy /out', UNPROVEN],
    ['xargs pnpm deploy /out', UNPROVEN],
    ['command -x pnpm deploy /out', /command option -x is not one this check reads/],
    ['printf -v "$name" ""', UNPROVEN],
    ['. scripts/environment.sh', UNPROVEN],
    ['scripts/../../../usr/bin/env -i pnpm install', UNPROVEN],
    ['${{ inputs.command }} pnpm install', /an expression other than/],
    ["echo '${{ github.event.pull_request.title }}'", /an expression other than/],
    ['A$x=1 pnpm install', /not an assignment to a written-out name/],
    ['export "$name"=', form('export')],
    ['export NAME$x', form('export')],
    ['unset "$name"', form('unset')],
    ['bash -c "$1"', form('bash')],
    ['curl -fsS https://example.test/install | bash', form('bash')],
    ['pnpm exec "$tool" install', form('pnpm')],
    ['pnpm exec sudo pnpm install', form('pnpm')],
    ['npm exec -- pnpm install', form('npm')],
    ['npm x -- env -i pnpm install', form('npm')],
    ['pnpm sudo pnpm install', form('pnpm')],
    ['pnpm -r env -i pnpm install', form('pnpm')],
    ['docker build -f Containerfile .', form('docker')],
    ['docker run --rm image sh /install.sh', form('docker')],
    ['eval "$1"', /`eval` runs text other than/],
    ['eval "${x_credentials}"', /`eval` runs text other than/],
    [
      'eval "${x_credentials}"\nx_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh tests)"',
      /`eval` runs text other than/,
    ],
    ['echo "$a$b=" >> "$GITHUB_ENV"', /writes the environment of later steps/],
    ['echo $(date) `pnpm root`', /a backtick command substitution is not read/],
    ['cat <<EOF\npnpm install\nEOF', /a here-document/],
  ])
    everywhere(script, pattern);
  // Controls: the forms the real workflows use are read and accepted.
  for (const script of [
    'export PGHOST=localhost PGPORT="$port"\nunset KAFKA_SECRETS_DIR',
    'x_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh tests)"\neval "${x_credentials}"',
    'echo "dir=$RUNNER_TEMP/trivy-db" >> "$GITHUB_OUTPUT"',
    'if ! command -v gitleaks >/dev/null 2>&1; then pnpm exec turbo run build | tee out.log; fi',
    "docker run --rm --entrypoint sh image@sha256:0 -c 'clamd --version; ls -l /var/lib/clamav/'",
  ])
    everywhere(script, null, true);
});

test('what an image or a step starts outside the suppression is refused', () => {
  const name = 'services/economic-service/Dockerfile';
  const real = repoText(name);
  const start = 'CMD ["node", "dist/main.js"]';
  const outside = /outside a stage that sets/;
  const deploy = 'CI=true pnpm --filter @rasta/economic-service deploy --prod --legacy /deploy';
  for (const [mutant, pattern] of [
    // A shell, a script or a variable where the container starts.
    ...['CMD', 'ENTRYPOINT', 'HEALTHCHECK CMD'].map((how) => [
      swap(real, start, `${how} sh /install.sh\n${how === 'CMD' ? '' : start}`),
      NOT_NODE,
    ]),
    [swap(real, start, 'ENV PM=npm\nCMD $PM rebuild'), NOT_NODE],
    [swap(real, start, `CMD node -e "require('child_process').execSync('npm rebuild')"`), NOT_NODE],
    // The six allowed names prove nothing once a file is copied in or a search path changes.
    ...['rm', 'addgroup', 'adduser', 'mkdir', 'chown', 'chmod'].map((utility) => [
      swap(
        real,
        'USER rasta\n',
        `COPY --from=build /usr/local/bin/node /usr/local/bin/${utility}\nRUN ${utility} /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs rebuild\nUSER rasta\n`,
      ),
      outside,
    ]),
    [real.replace(/^RUN addgroup/m, 'ENV PATH=/app/bin:$PATH\nRUN addgroup'), outside],
    [real.replace(/^RUN addgroup/m, 'ARG PATH=/app/bin\nRUN addgroup'), outside],
    // The variable under a quoted name, or set by an instruction that is not read as one pair.
    [
      swap(real, start, `ENV PRISMA_SKIP_"POSTINSTALL_GENERATE"=\n${start}`),
      /may be set only by the instruction/,
    ],
    [
      swap(real, 'ENV PNPM_HOME=/pnpm\n', 'ENV PNPM_HOME=/pnpm $NAME=\n'),
      /is not a form this check reads/,
    ],
  ])
    refused(dockerfileLifecycle, name, mutant, pattern);
  // The real file with a quoted wrapper keeps its inventory, and is refused all the same.
  const quoted = dockerfileLifecycle(name, swap(real, deploy, `e'n'v -i PATH="$PATH" ${deploy}`));
  assert.deepEqual(quoted.commands, ['npm install', 'pnpm install', 'pnpm deploy']);
  assert.match(quoted.errors.join('\n'), UNPROVEN);

  // An `env` that is not a mapping written in the file can hold anything, at every level.
  const action = '.github/actions/install-ci-tool/action.yml';
  const opaque = 'env: ${{ fromJSON(inputs.environment) }}';
  const notRead = /env is not a mapping this check reads/;
  refused(
    actionLifecycle,
    action,
    `${repoText(action)}    - shell: bash\n      ${opaque}\n      run: pnpm deploy /out\n`,
    notRead,
  );
  const workflow = (top, step) =>
    `on: push\n${top}jobs:\n  a:\n    runs-on: x\n    env:\n      PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n    steps:\n${step}`;
  refused(
    workflowLifecycle,
    'new.yml',
    workflow('', `      - run: pnpm i\n        ${opaque}\n`),
    notRead,
  );
  refused(workflowLifecycle, 'new.yml', workflow(`${opaque}\n`, '      - run: pnpm i\n'), notRead);
  // A build of a file the Dockerfile rule never reads (lifecycleFileKind('Containerfile') is null).
  const build = (inputs) =>
    workflow('', `      - uses: docker/build-push-action@0\n        with:${inputs}\n`);
  const file = (path) => build(`\n          file: ${path}`);
  assert.equal(lifecycleFileKind('Containerfile'), null);
  for (const mutant of [file('Containerfile'), build(' ${{ fromJSON(inputs.build) }}')])
    refused(workflowLifecycle, 'new.yml', mutant, /builds .*, a file this check does not read/);
});

// PR #1085 r2 F1 (FU-334): the three forms the reviewer ran and found accepted at ac94f313's
// successor, each at every entry point it applies to, then the same class in other spellings.
test('an option, a nested shell or a wrapper that runs unread text is refused (FU-334)', () => {
  const reset = '; env -i PATH=/usr/local/bin:/usr/bin:/bin pnpm deploy /out';
  // 1. pnpm options that turn a quoted argument into a shell command, with every exec target.
  for (const target of ['turbo', 'jest', 'playwright'])
    for (const option of ['-c', '--shell-mode', '--shell-mode=true', '--config.shell-mode=true'])
      everywhere(`pnpm ${option} exec ${target} "${reset}"`, form('pnpm'));
  // The reviewer's replacement of the real deploy keeps the inventory and is refused all the same.
  const deploy = 'pnpm --filter @rasta/economic-service deploy --prod --legacy /deploy';
  const replaced = dockerfileLifecycle(
    ENTRY.docker,
    swap(repoText(ENTRY.docker), deploy, `pnpm -c exec turbo "${reset}"`),
  );
  assert.deepEqual(replaced.commands, ['npm install', 'pnpm install', 'pnpm deploy']);
  assert.match(replaced.errors.join('\n'), form('pnpm'));
  for (const [script, pattern] of [
    // The same class: an option nobody listed, wherever a package manager reads one.
    ['pnpm --config.script-shell=/tmp/sh run build', form('pnpm')],
    ['pnpm --dir /tmp/elsewhere run build', form('pnpm')],
    ['pnpm exec -c turbo "; pnpm deploy /out"', form('pnpm')],
    ['pnpm install --config.side-effects-cache=false', form('pnpm')],
    ['pnpm install --frozen-lockfile "$extra"', form('pnpm')],
    ['pnpm deploy $options /out', form('pnpm')],
    ['pnpm run -c build', form('pnpm')],
    ['pnpm config set script-shell /tmp/sh', form('pnpm')],
    ['pnpm dlx create-thing', form('pnpm')],
    ['npm install --script-shell=/tmp/sh', form('npm')],
    ['npm run build', form('npm')],
    ['npm exec turbo -c "; pnpm deploy /out"', form('npm')],
    ['npm --prefix /tmp install', form('npm')],
    // The same options as variables: pnpm reads `pnpm_config_<setting>` (measured, 11.22.0).
    ['pnpm_config_script_shell=/tmp/sh pnpm run build', /a package manager option/],
    ['export PNPM_CONFIG_SCRIPT_SHELL=/tmp/sh', /a package manager option/],
    ['npm_config_script_shell=/tmp/sh npm install', /a package manager option/],
    // Other programs that run what they are given: none is listed, so none is read past.
    ['npx turbo run build', UNPROVEN],
    ['corepack pnpm install', UNPROVEN],
    ['xargs -n1 pnpm deploy', UNPROVEN],
    ['env pnpm install', UNPROVEN],
    ['nice -n 5 pnpm install', UNPROVEN],
    ['timeout 60 pnpm install', UNPROVEN],
    ['nohup pnpm install', UNPROVEN],
    ['time pnpm install', UNPROVEN],
    ['builtin source /tmp/setup', UNPROVEN],
    ['command source /tmp/setup', UNPROVEN],
    ['/usr/bin/ap[t]-get install -y libnss3', /which this check cannot read/],
    ['echo "$SETUP" | bash </dev/stdin', form('bash')],
    // A redirection written into a word: bash runs `n`, `pnp` and `nod`, not what is spelled.
    ['n>pm install', UNPROVEN],
    ['pnp>m deploy /out', UNPROVEN],
    ['nod<e scripts/prisma-generate.mjs', UNPROVEN],
    ['n2>&1pm install', UNPROVEN],
    // `bash` runs a file of the inventory, or text that was read.
    ['bash -c "env -i pnpm deploy /out"', form('bash')],
    ['bash -lc "pnpm install"', form('bash')],
    ['bash /tmp/install.sh', form('bash')],
    ['bash scripts/not-in-the-inventory.sh', form('bash')],
    ['scripts/not-in-the-inventory.sh', UNPROVEN],
    // After a change of directory a relative path is another file.
    ['cd services/api-gateway\nbash scripts/ci-install-browser.sh', form('bash')],
    ['cd services/api-gateway\nscripts/ci-install-browser.sh', UNPROVEN],
    ['cd /tmp\nnode dist/main.js', form('cd')],
    ['cd "$elsewhere"', form('cd')],
  ])
    everywhere(script, pattern);
  // Controls: the read forms, and a `cd` that stays inside its subshell.
  for (const script of [
    'pnpm --filter @rasta/web exec playwright test -c playwright.config.ts',
    'pnpm run test:integration --shard=economic -- --verbose',
    'npm install -g pnpm@11.22.0\npnpm config set store-dir /pnpm/store',
    'bash -c "pnpm install --frozen-lockfile"',
    '( cd services/api-gateway && node dist/main.js )\nbash scripts/ci-install-browser.sh',
  ])
    everywhere(script, null, true);
});

// D-173: every probe the reviewers ran on PR #1099 r1 and PR #1101 r1 that this reader and its
// policy are to refuse, at every entry point, for the reason given. Each was accepted before.
test('r1 probes: redirections, npm options, bound names and unreviewed lines are refused (D-173)', () => {
  const reset = 'env -i PATH=/usr/bin:/bin pnpm deploy /out';
  const line = /only the lines reviewed in REVIEWED are read/;
  const name = /the search path or an environment file is not text's to set/;
  for (const [pattern, scripts] of [
    // #1099 F1: a redirection's target is not the command word, nor a program's operand.
    [UNPROVEN, ['>', '>>', '<', '<>', '>|', '2>', '&>'].map((to) => `${to}echo ${reset}`)],
    [UNPROVEN, ['"n">pm install', `bash -c '>echo ${reset}'`, `{fd}>echo ${reset}`]],
    [form('pnpm'), [`pnpm exec >turbo ${reset}`]],
    [/a redirection without a target word/, ['echo ok > >(pnpm deploy /out)', 'echo ok >']],
    // #1099 F2: npm has no `--filter`; what follows it is npm's to read.
    [
      form('npm'),
      ['install', 'i', 'ci'].flatMap((verb) =>
        ['--filter', '-F'].flatMap((option) =>
          ['--script-shell=/bin/echo', '--userconfig=/tmp/rc', '--prefix=/tmp', 'left-pad'].map(
            (hidden) => `npm ${verb} ${option} ${hidden}`,
          ),
        ),
      ),
    ],
    // #1099 F3, #1101 F1: every form that binds a protected name, and the files later steps read.
    [name, ['for pnpm_config_shell_mode in true; do pnpm exec turbo x; done']],
    [name, ['for PATH in /tmp/bin; do pnpm install; done', 'unset PATH', "bash -c 'unset PATH'"]],
    [
      name,
      ['PATH=/tmp/bin pnpm install', 'export PATH=/tmp/bin', 'RUNNER_TEMP=/tmp', 'BASH_ENV=x'],
    ],
    [UNPROVEN, ['readonly PATH=/tmp/bin', 'declare -x PATH=/tmp/bin', 'env PATH=/tmp pnpm i']],
    [form('export'), ['export -n PATH', 'export PATH$x=1']],
    [/indirect or assigns/, ['echo "${pnpm_config_shell_mode:=true}"', 'echo "${PATH=/tmp}"']],
    [/indirect or assigns/, ['p=GITHUB_\'\'PATH; echo /tmp/bin >> "${!p}"']],
    [/a line this check has not reviewed/, ['echo "X=${payload}" >> "$GITHUB_ENV"']],
    [/a line this check has not reviewed/, ['echo /tmp/bin >> "$GITHUB_PATH"', 'f="$GITHUB_ENV"']],
    [/a line this check has not reviewed/, ['echo \'\n# \' x >> "$GITHUB_ENV"']],
    [form('pnpm'), ['pnpm install --filter --config.script-shell=/bin/echo']],
    [line, ['set -a', 'set -o allexport']],
    // #1101 F2, F3, F5: a computed operand, standard input, a file or an option nobody reviewed.
    [line, ['go test "$OPTION" ./...', 'git log -p "$OPTION"', 'go test -exec=env ./...']],
    [line, ['cat-file', 'rev-list', 'log'].map((verb) => `git ${verb} "$OPT"`)],
    [line, ['mod', 'vet', 'test', 'build'].map((verb) => `go ${verb} "$OPT"`)],
    [line, ['go build -o "$RUNNER_TEMP/trivy-db-check-bin/node" .']],
    [
      line,
      [
        "echo '\\! env -i pnpm deploy /out' | psql -X",
        'cat /tmp/setup.sql | psql -X',
        "bash -c 'psql -X < /tmp/x.sql'",
      ],
    ],
    [line, ['psql -X < /tmp/setup.sql', 'psql -X 0< /tmp/setup.sql', 'psql -f scripts/setup.sql']],
    [line, ['node /tmp/unread.js', 'node -r /tmp/hook.js dist/main.js', 'node --run build']],
    [
      line,
      ['node -', 'node dist/main.js x', 'node scripts/prisma-generate.mjs $several', 'node -e "1"'],
    ],
  ])
    for (const script of scripts) everywhere(script, pattern);
  // #1101 F4: what an image starts is one of two exact texts, not a pattern of `node` words.
  const real = repoText(ENTRY.docker);
  for (const how of ['CMD', 'ENTRYPOINT', 'HEALTHCHECK CMD'])
    for (const words of [
      '"-r", "/tmp/hook.js", "dist/main.js"',
      '"--import", "/tmp/hook.mjs", "dist/main.js"',
      '"--run", "build"',
      '"-"',
      '"/tmp/unread.js"',
    ])
      refused(
        dockerfileLifecycle,
        ENTRY.docker,
        swap(real, 'CMD ["node", "dist/main.js"]', `${how} ["node", ${words}]`),
        NOT_NODE,
      );
  for (const path of ['ENV PATH=/tmp/bin:$PATH', 'ARG PATH=/tmp/bin', 'ARG "PATH"=/tmp/bin'])
    refused(
      dockerfileLifecycle,
      ENTRY.docker,
      swap(real, 'ENV PATH="$PNPM_HOME:$PATH"', path),
      /the search path|is not a form this check reads/,
    );
  // #1101 F6: an inline program is the text that was reviewed, to the blank.
  const ci = repoText('.github/workflows/ci.yml');
  const folded = ci.replace('name + ": " + needs', 'name + ":\n            " + needs');
  assert.match(workflowLifecycle('ci.yml', folded).errors.join(), line);
  // Controls: the forms the real files use.
  for (const script of [
    'set -euo pipefail\ngit rev-list --count "$SCAN_BASE..$SCAN_HEAD" >/dev/null 2>&1',
    '( cd services/api-gateway && PORT=3000 node dist/main.js > /tmp/gateway.log 2>&1 & )',
    'node scripts/prisma-generate.mjs --schema "${dir}/schema.prisma" < /dev/null',
    'for attempt in $(seq 1 60); do psql -U rasta -d postgres -c "SELECT 1" >/dev/null && break; done',
  ])
    everywhere(script, null, true);
});

// FU-340 part A: the residuals of PR #1099 r2 (F1, F3, F4) and what PR #1100 r1 left open (a
// protected name in an `env`, a `cd` that may not have run). The refused rows were accepted at 05ffe9573,
// but for the pins of what was refused before: `">" echo`, the delimiter line, `BASH_ENV`/`ENV`/`PATH`
// in an `env`, `( cd … ) && node`.
test('descriptors, syntax words, records, env names and an unproven cd are refused (FU-340)', () => {
  const line = /only the lines reviewed in REVIEWED are read/;
  // F1: `&>` and `&>>` take no descriptor, so the digits are an argument; and sh reads `&`, then `>`.
  for (const digits of ['1', '2', '0', '10', '255'])
    for (const to of ['&>', '&>>']) {
      everywhere(`set -euo pipefail ${digits}${to}/dev/null`, line);
      everywhere(`pnpm exec ${digits}${to}/dev/null turbo`, form('pnpm'));
    }
  everywhere('echo ok &>/dev/null env -i pnpm deploy /out', /an &> redirection, which sh reads/);
  everywhere('">" echo pnpm install', /not an assignment to a written-out name/);
  // one digit is a descriptor to every shell; `10>` is the word 10 to dash, as 2147483648> is to bash
  for (const digits of ['10', '255', '007', '99999999999'])
    everywhere(`pnpm exec ${digits}>/dev/null turbo`, /a descriptor of more than one digit, which/);
  for (const to of ['>', '>>', '<', '<>', '>|', '>&', '<&'])
    everywhere(`echo ok 2${to}/dev/null`, null, true);
  const read = (text) => parseCommands(text).commands;
  assert.deepEqual(
    read('set -e 1&>a 2>b 3&>>c 4>&5 6<&7 8<>d 9>|e 10>>f 11<<<g 12<h 13<<i')[0].words.map(
      ({ value, redirect }) => (redirect ?? '') + value,
    ),
    'set -e 1 &>a 2>b 3 &>>c 4>&5 6<&7 8<>d 9>|e 10>>f 11<<<g 12<h 13<<i'.split(' '),
  );
  // F4: a word of the grammar is one only when spelled exactly so, and then its grammar is asked.
  for (const script of ['$x[ -f a ]', '"$x"{ echo ok; }', '$x! echo ok'])
    everywhere(script, UNPROVEN);
  const deny = () => 'DENIED';
  const programs = { '{': deny, '[': deny, '[[': deny, '}': true, echo: true };
  for (const script of ['{ echo ok; }', '[ -f missing ]', '[[ -f missing ]]'])
    assert.match(readShell(script, { programs }).problems.join(), /DENIED/, script);
  assert.equal(
    readShell('{ echo ok; }', { programs: { ...programs, '{': true } }).problems.length,
    0,
  );

  // Found in the sweep (on main since #1099): what ends a `$( )` or starts a comment for this reader
  // does so for bash. A `( )` inside a `$( )` is counted; a `case` there and an expansion whose
  // text is more than plain characters are refused. Each refused row ran `env` unread before.
  for (const script of ['( true ) ;', '( ( true ) ) &&', '(( 1 )) ;'])
    everywhere(`echo "$( ${script} env -i pnpm install )"`, UNPROVEN);
  for (const script of ['echo ${x:- #}; env -i pnpm install', 'echo "$(echo ${x:-)} ; env x)"'])
    everywhere(script, /a parameter expansion whose text holds more than plain characters is not/);
  everywhere(
    'x="$(case a in a) env -i pnpm install;; esac)"',
    /a case statement inside a command substitution is not read/,
  );
  for (const script of ['echo "$( ( true ) )"; echo ok', 'echo "${A:-127.0.0.1}" "${dir:?}"'])
    everywhere(script, null, true);
  assert.deepEqual(
    read('a "$( ( b ) ; c )" d; ( e )').map(({ words, scope }) => words[0].value + scope),
    ['b1/2', 'c1', 'a', 'e3'],
  );

  // F3: a write to an environment file is one record: a line with no value of the text's own, or
  // the whole text that was read with its producers (here the e2e job's "Generate run secrets").
  const steps = (script) =>
    [runs.workflow(script), runs.action(script)].map(({ errors }) => errors.join('\n'));
  const names = [
    ['KEYCLOAK_ADMIN_PASSWORD', 'keycloak_password', 24],
    ['INTERNAL_TOKEN_SECRET', 'internal_secret', 32],
  ];
  const write = (variable, name) => `echo "${variable}=\${${name}}" >> "$GITHUB_ENV"`;
  const secrets = [
    'set -euo pipefail',
    ...names.map(([, name, bytes]) => `${name}="$(openssl rand -hex ${bytes})"`),
    ...names.map(([, name]) => `echo "::add-mask::\${${name}}"`),
    ...names.map(([variable, name]) => write(variable, name)),
  ].join('\n');
  assert.deepEqual(steps(secrets), ['', '']);
  // F1, the sweep: bash joins what a line continuation stands between, `&\⏎>` is `&>`
  for (const script of [
    'pnpm install &\\\n>/dev/null echo --config.ignore-scripts=false',
    'echo ok >\\\n>log',
    'echo ok |\\\n| echo ok',
  ])
    for (const errors of steps(script))
      assert.match(errors, /a line continuation inside an operator is not read/, script);
  for (const script of ['echo ok &&\\\necho ok', 'echo ok \\\n&& echo ok', 'echo ok >\\\nlog'])
    assert.deepEqual(steps(script), ['', ''], script);
  const unreviewed = /writes the environment of later steps in a line this check has not reviewed/;
  for (const script of [
    // the reviewer's six: the reviewed line after a value of two lines, in a workflow and an action
    ...[...names, ['WEB_SESSION_SECRET', 'web_session_secret']].flatMap(([variable, name]) => [
      `${name}="safe\nPNPM_CONFIG_SHELL_MODE=true"\n${write(variable, name)}`,
      write(variable, name),
    ]),
    `${secrets}\necho ok`,
    secrets.replace('-hex 32', '-base64 48'),
    `openssl() { printf 'a\\nB=1'; }\n${secrets}`,
    'echo "key=${value}" >> "$GITHUB_OUTPUT"',
    'echo "x=$RUNNER_TEMP/trivy-db" >> "$GITHUB_OUTPUT"',
    'echo "a=b" | tee -a "$GITHUB_OUTPUT"',
    'echo "a=b" >> "$GITHUB_STATE"',
    'echo "A<<EOF" >> "$GITHUB_ENV"',
  ])
    for (const errors of steps(script)) assert.match(errors, unreviewed, script);
  for (const script of [
    'echo "$RUNNER_TEMP/trivy-db-check-bin" >> "$GITHUB_PATH"',
    'echo "archive=$RUNNER_TEMP/trivy-db-artifact" >> "$GITHUB_OUTPUT"',
    'echo ok | tee -a "${GITHUB_STEP_SUMMARY}"',
  ])
    assert.deepEqual(steps(script), ['', ''], script);

  // PM: a protected name in an `env`, at every level and in every kind of file, but as a reviewed pair.
  const workflow = (top, job, step) =>
    `on: push\nenv:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n${top}jobs:\n  a:\n    runs-on: x\n${job}    steps:\n      - run: echo ok\n${step}`;
  const levels = (entry) => [
    workflow(`  ${entry}\n`, '', ''),
    workflow('', `    env:\n      ${entry}\n`, ''),
    workflow('', '', `        env:\n          ${entry}\n`),
    workflow(
      '',
      `    services:\n      db:\n        image: x\n        env:\n          ${entry}\n`,
      '',
    ),
  ];
  const errors = (text, path = 'new.yml') => workflowLifecycle(path, text).errors.join('\n');
  const sets = (name) => new RegExp(`env sets ${name}: `);
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PATH', 'GITHUB_TOKEN'])
    for (const text of levels(`${name}: x`)) assert.match(errors(text), sets(name), text);
  for (const text of levels('NODE_ENV: test')) assert.equal(errors(text), '', text);
  for (const entry of ['<<: { NODE_OPTIONS: x }', 'A: [NODE_OPTIONS]', 'A-B: x'])
    for (const text of levels(entry)) assert.match(errors(text), /is not a name with one value/);
  const composite = `${repoText(ENTRY.action)}    - shell: bash\n      env:\n        NODE_OPTIONS: x\n      run: echo ok\n`;
  assert.match(actionLifecycle(ENTRY.action, composite).errors.join(), sets('NODE_OPTIONS'));
  for (const instruction of [
    'ENV NODE_OPTIONS=-r/tmp/x.js',
    'ARG NODE_PATH=/tmp',
    'ENV GITHUB_X=1',
  ])
    refused(
      dockerfileLifecycle,
      ENTRY.docker,
      swap(
        repoText(ENTRY.docker),
        'ENV PNPM_HOME=/pnpm\n',
        `ENV PNPM_HOME=/pnpm\n${instruction}\n`,
      ),
      /what node loads|an environment file is not text's to set/,
    );
  everywhere('GITHUB_TOKEN=x echo ok', /sets GITHUB_TOKEN: /);
  assert.equal(ENV_PAIRS.size, 0, 'the repository sets no protected name in an env today');
  const memory = 'NODE_OPTIONS: --max-old-space-size=4096';
  ENV_PAIRS.add('new.yml: NODE_OPTIONS=--max-old-space-size=4096').add('new.yml: NODE_PATH=1');
  try {
    for (const text of levels(memory)) assert.equal(errors(text), '', text);
    for (const text of levels(memory))
      assert.match(errors(text, 'other.yml'), sets('NODE_OPTIONS'));
    for (const text of levels(`${memory} -r /tmp/x.js`))
      assert.match(errors(text), sets('NODE_OPTIONS'));
    for (const text of levels('NODE_PATH: 1')) assert.match(errors(text), sets('NODE_PATH'));
    for (const text of levels(memory.replace('OPTIONS', 'PATH')))
      assert.match(errors(text), sets('NODE_PATH'));
  } finally {
    ENV_PAIRS.clear();
  }

  // After a `cd`, only what `&&` joins to it is read as run there: the `cd` ran, and succeeded.
  const [cd, node] = ['cd services/api-gateway', 'node dist/main.js'];
  const unknown = [
    `if [ -d x ]; then ${cd}; fi\n${node}`,
    `${cd} || true\n${node}`,
    `${cd}; ${node}`,
    `true ||\n${cd} && ${node}`, // a line break after an operator goes on with its list
    `echo ok |\n${cd} && ${node}`,
    `echo ok |&\n${cd} && ${node}`,
    `false && ${cd}; ${node}`,
    `${cd} || ${node}`,
    `${cd} && true || ${node}`,
    `true || ${cd} && ${node}`,
    `echo ok | ${cd} && ${node}`,
    `echo ok |& ${cd} && ${node}`,
    `${cd} & ${node}`,
    `${cd} && ( true ) || ${node}`,
    `${cd} && ( true ); ${node}`,
    `${cd}; ( true ) && ${node}`,
    `( ${cd} ) && ${node}`,
    `case q in q) true;; esac; ( ${cd} && true ) && ${node}`,
    `${cd} && bash -c "${node}"`,
    `${cd} && x="$(${node})"`,
  ];
  const first = [
    `! ${cd} && ${node}`,
    `if true; then ${cd} && ${node}; fi`,
    `X=1 ${cd} && ${node}`,
    // in a loop a `cd` also moves what stands before it (on main since #1100)
    `for i in 1 2; do\nnode scripts/container-scope.mjs\n${cd}\ndone`,
    `while true; do echo ok; ${cd} && ${node}; done`,
    `until node scripts/container-scope.mjs; ${cd}; do echo ok; done`,
  ];
  for (const [pattern, scripts] of [
    [line, unknown],
    [form('cd'), first],
  ])
    for (const script of scripts) {
      everywhere(script);
      for (const errors of steps(script)) assert.match(errors, pattern, script);
    }
  for (const errors of steps(`true || # c\n\n${cd} && ${node}`)) assert.match(errors, line);
  for (const script of [
    `${cd} && ${node}`,
    `${cd} 2>/dev/null && echo "$(true; true)" && { ${node} | tee log; }`,
    // under a condition too: what `&&` joins to the `cd` runs there whenever it runs
    `if true\nthen\n${cd} && ${node}\nfi`,
    `for i in 1 2; do echo ok; done\n${cd} &&\n${node}`,
    `${cd} && # c\n\n${node}`,
    `( true && ${cd} && PORT=1 ${node} > /tmp/log 2>&1 & )`,
  ])
    everywhere(script, null, true);
  assert.deepEqual(
    read('a && b; c && d || e && f | g && h |& i && j & k "$(m; n)" && l `o; p` && q').map(
      ({ list }) => list,
    ),
    [1, 1, 2, 2, 0, 0, 0, 0, 0, 0, 3, 4, 3, 3, 6, 3, 3],
  );
});

test('the shell that reads a step and the variables it is given are read at every level (FU-334)', () => {
  const env = "env:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n";
  const job = (steps) => `on: push\n${env}jobs:\n  a:\n    runs-on: x\n    steps:\n${steps}`;
  const run = (extra) => `      - run: bash scripts/ci-install-browser.sh\n${extra}`;
  const errors = (text) => workflowLifecycle('new.yml', text).errors.join('\n');
  assert.equal(errors(job(run(''))), '');
  const shell = /shell .* is not one this check reads/;
  const indirect = 'env -i bash {0}';
  for (const text of [
    job(run('')).replace('jobs:', `defaults:\n  run:\n    shell: ${indirect}\njobs:`),
    job(run('')).replace(
      '    steps:',
      `    defaults:\n      run:\n        shell: ${indirect}\n    steps:`,
    ),
    job(run(`        shell: ${indirect}\n`)),
    job(run('        shell: ${{ inputs.shell }}\n')),
  ])
    assert.match(errors(text), shell);
  const composite = `${repoText(ENTRY.action)}    - run: pnpm install\n`;
  assert.match(actionLifecycle(ENTRY.action, composite).errors.join('\n'), /names no shell/);
  // A package manager option as an `env` entry or a Dockerfile variable.
  const option = /a package manager option/;
  for (const text of [
    job(run('')).replace(env, `${env}  pnpm_config_script_shell: /tmp/sh\n`),
    job(run('        env:\n          NPM_CONFIG_SCRIPT_SHELL: /tmp/sh\n')),
    job('      - run: echo "PNPM_CONFIG_SCRIPT_SHELL=${shell}" >> "$GITHUB_ENV"\n'),
  ])
    assert.match(errors(text), /a package manager option|writes the environment of later steps/);
  for (const instruction of [
    'ENV pnpm_config_script_shell=/tmp/sh',
    'ARG npm_config_script_shell=/tmp/sh',
  ])
    refused(
      dockerfileLifecycle,
      ENTRY.docker,
      swap(
        repoText(ENTRY.docker),
        'ENV PNPM_HOME=/pnpm\n',
        `ENV PNPM_HOME=/pnpm\n${instruction}\n`,
      ),
      option,
    );
  // Where a step's text starts: a relative path is the checkout's only below the checkout.
  for (const directory of ['/tmp', '../elsewhere', '${{ inputs.directory }}', '-x'])
    assert.match(
      errors(job(run(`        working-directory: ${directory}\n`))),
      /working-directory is not/,
      directory,
    );
  assert.match(errors(job(run('        working-directory: services\n'))), form('bash'));
});

// Two of ci.yml's lines: refused below by where they run or what their image is, not as unread.
const semgrep =
  'docker run --rm -v "$PWD:/src" -w /src image semgrep scan --error --metrics=off --config p/typescript --config p/nodejs --config p/owasp-top-ten --config p/secrets';
const clamd = (image) =>
  `docker run --rm --entrypoint sh ${image} -c 'clamd --version; ls -l /var/lib/clamav/'`;
const changed = /a mount of \$PWD after the directory changed is not the checkout/;
test('a container runs only a reviewed program, body or script (FU-334)', () => {
  const dropped = 'env -i n\\"pm\\" rebuild';
  for (const [script, pattern] of [
    // 2. The reviewer's probes: Docker's second shell, by `run` and by `exec`.
    [`docker run --rm image sh -c "${dropped}"`, form('docker')],
    [`docker exec container sh -c "${dropped}"`, form('docker')],
    ['docker run --rm image bash /install.bash', form('docker')],
    ['docker exec container bash /install.bash', form('docker')],
    // The same class: every other way a container is handed a shell, a script or a program.
    ['docker run --rm --entrypoint sh image -c "npm rebuild"', form('docker')],
    ['docker run --rm --entrypoint=/bin/sh image -c "corepack pnpm install"', form('docker')],
    ['docker run --rm --entrypoint sh image -c "$body"', form('docker')],
    ['docker run --rm --entrypoint sh image -s', form('docker')],
    ['docker run --rm --entrypoint sh image', form('docker')],
    ['docker run --rm --entrypoint /install.sh image', form('docker')],
    [
      'docker run --rm --entrypoint promtool --entrypoint sh image -c "npm rebuild"',
      form('docker'),
    ],
    ['docker run --rm --health-cmd "npm rebuild" image', form('docker')],
    ['docker run --rm --env-file /tmp/env image', form('docker')],
    ['docker run --rm $options image', form('docker')],
    ['docker run "$@"', form('docker')],
    [clamd('"$IMAGE"'), /the image is neither written out nor a value of the workflow env/],
    ['docker run --rm image node /app/install.js', form('docker')],
    ['docker run --rm image unknown-tool', form('docker')],
    ['docker exec -u root container clamdscan --version', form('docker')],
    ['docker exec -u ls container npm rebuild', form('docker')],
    ['docker --config /tmp/plugins run --rm image', form('docker')],
    ['docker compose run --rm tool', form('docker')],
    ['docker build .', form('docker')],
    ['docker start stopped-container', form('docker')],
    ['docker buildx build -f /tmp/Dockerfile .', form('docker')],
    // A mount that puts a file where a container program is found, or is not the checkout.
    ['docker run --rm -v /tmp/tool:/usr/bin/promtool --entrypoint promtool image', form('docker')],
    ['docker run --rm --mount type=bind,src=/tmp,dst=/usr/bin image', form('docker')],
    [`cd services/api-gateway\n${semgrep}`, changed],
    [`PWD=/tmp ${semgrep}`, changed],
    // PR #1100 r1 F2, closed by the reader of #1099 (every binding form marks the name): `unset`.
    [`unset PWD\n${semgrep}`, changed],
  ])
    everywhere(script, pattern);
  // The Keycloak gate is the checkout's reviewed script only through the reviewed mount.
  const ci = repoText('.github/workflows/ci.yml');
  const mount = '-v "$PWD/infrastructure/docker/keycloak:/opt/keycloak/data/import:ro"';
  assert.ok(ci.includes(mount));
  for (const other of [
    '-v "/tmp/replacement:/opt/keycloak/data/import:ro"',
    '-v "$OTHER/infrastructure/docker/keycloak:/opt/keycloak/data/import:ro"',
    '-e UNMOUNTED=1',
  ])
    refused(workflowLifecycle, 'ci.yml', ci.replaceAll(mount, other), form('docker'));
  const gate = [...CONTAINER_SCRIPTS.values()];
  for (const { mount: reviewed, file, sha256 } of gate) {
    assert.ok(MOUNTS.has(reviewed) && FILES.has(file), file);
    assert.equal(`sha256:${createHash('sha256').update(repoText(file)).digest('hex')}`, sha256);
  }
  // No reviewed mount is stale: each is written in ci.yml.
  for (const reviewed of MOUNTS) assert.ok(ci.includes(` ${reviewed} `), reviewed);
  // Controls: the forms ci.yml uses.
  for (const script of [
    'docker run -d --name rasta-e2e-temporal --network host --entrypoint temporal image@sha256:0 server start-dev --ip 0.0.0.0 --port 7233 --headless',
    'docker run --rm -v "$PWD/infrastructure/docker/prometheus:/etc/prometheus:ro" --entrypoint promtool "${{ env.IMAGE }}" check config /etc/prometheus/prometheus.yml',
    'docker exec rasta-ci-clamav clamdscan --ping 1\ndocker logs --tail 100 rasta-ci-clamav',
    semgrep,
    clamd('"${{ env.IMAGE }}"'),
  ])
    for (const where of ['workflow', 'action'])
      assert.deepEqual(runs[where](script).errors, [], `${where}: ${script}`);
});

// PR #1100 r1 F1, F2 and PR #1101 r1 F5: every probe the reviewer ran and its class, one a line.
test('r1 probes: containers, services and directories are read only as reviewed (D-173)', () => {
  const each = (text) => text.trim().split(/\n\s*/);
  const lines = /only the lines reviewed in DOCKER_EXEC and REVIEWED_DIGESTS are read/;
  // F1: Docker reads its options before the container and the command, so no word is guessed.
  for (const script of each(`
    docker exec "--env" ls container sh -c "npm rebuild"
    docker exec "-u" root rasta-ci-clamav clamdscan --version
    docker exec "$OPTIONS" rasta-ci-clamav clamdscan --version
    docker exec rasta-ci-clamav clamdscan --ping 2
    docker exec rasta-ci-clamav sh
    docker run --rm -e "$ENV_ENTRY" --entrypoint bash image -c "ls"
    docker run --rm -e BASH_ENV=/src/install.bash image ls
    docker run --rm -e PATH --user 0 image ls
    docker run --rm --entrypoint sh image -c "ls"`))
    everywhere(script, lines);
  const mounted = 'docker run -e "$ENV_ENTRY" -v "$PWD:/src" --entrypoint bash image -c "ls"';
  assert.match(runs.workflow(mounted).errors.join(), lines);
  // F2, #1101 F5: a reviewed line is read where it was reviewed, after at most the one `cd`.
  for (const script of each(`
    node dist/main.js
    go vet ./...
    ( cd services/api-gateway && go vet ./... )
    ( cd services/api-gateway && git rev-list --count "$SCAN_BASE..$SCAN_HEAD" )`))
    everywhere(script, /only the lines reviewed in REVIEWED are read/);
  for (const script of each(`
    ( cd arbitrary && node dist/main.js )
    ( cd services && node dist/main.js )
    ( cd services/api-gateway/ && node dist/main.js )
    ( cd services/api-gateway x && node dist/main.js )
    ( cd services/api-gateway && cd dist && node main.js )
    cd services/api-gateway; ( cd services/economic-service && node dist/main.js )`))
    everywhere(script, form('cd'));
  for (const script of each(`
    CDPATH=/tmp cd services/api-gateway
    export CDPATH=/tmp; bash -c 'echo'
    NODE_OPTIONS=--require=/tmp/x.js node scripts/prisma-generate.mjs
    export NODE_PATH=/tmp
    for NODE_OPTIONS in -r; do echo; done`))
    everywhere(script, /the search path|what node loads/);
  // The reviewer's Dockerfile probe: no COPY origin is proven for a path in a RUN.
  assert.match(runs.dockerfile('bash scripts/ci-install-browser.sh').errors.join(), form('bash'));
  // What a job starts outside its steps, and the directory its steps start in.
  const env = "env:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n";
  const job = (extra, top = '', step = 'run: echo') =>
    workflowLifecycle(
      'new.yml',
      `on: push\n${env}${top}jobs:\n  a:\n    runs-on: x\n${extra}    steps:\n      - ${step}\n`,
    ).errors.join('\n');
  const health = (command) =>
    `'--health-cmd "${command}" --health-interval 10s --health-timeout 5s --health-retries 10'`;
  const db = (keys) => `    services: { db: { image: postgres, ${keys} } }\n`;
  const run = (keys) => `    defaults: { run: { ${keys} } }\n`;
  const at = (directory, text) =>
    job('', '', `{ run: '${text}', working-directory: ${directory} }`);
  assert.equal(job(db(`options: ${health('redis-cli ping')}, env: { A: b }, ports: ['1:1']`)), '');
  assert.equal(job(db('command: postgres -c max_connections=300') + run('shell: bash')), '');
  assert.equal(job('', 'defaults: { run: { shell: sh } }\n'), '');
  assert.equal(at('scripts/trivy-db-check', 'go vet ./...'), '');
  const service = /service db has a key, options or a command not reviewed/;
  const inherited = /an inherited directory is not read/;
  for (const [text, pattern] of [
    [
      job('    container: { image: node, options: --env PATH=/tmp/bin }\n'),
      /container is not a job/,
    ],
    [job(db(`options: ${health('npm rebuild')}`)), service],
    [job(db('options: postgres -c max_connections=300')), service],
    [job(db('command: sh -c "npm rebuild"')), service],
    [job(db('volumes: [/tmp/bin:/usr/local/bin]')), service],
    [job(db('env: { PATH: /tmp/bin }')), /service db: env sets PATH/],
    [job(db("env: '${{ fromJSON(inputs.env) }}'")), /service db: env is not a mapping/],
    [job('    services: { db: ~ }\n'), service],
    [job('    services: x\n'), /services is not a mapping/],
    [job(run('working-directory: /tmp')), inherited],
    [job(run('shell: bash, working-directory: services')), inherited],
    [job('    defaults: x\n'), inherited],
    [job('', 'defaults: { run: { working-directory: /tmp } }\n'), inherited],
    [at('services/api-gateway', 'go vet ./...'), /only the lines reviewed in REVIEWED/],
    [at('services/api-gateway', 'node dist/main.js'), /only the lines reviewed in REVIEWED/],
    [at('scripts', 'cd services/api-gateway'), form('cd')],
    [at('scripts', semgrep), changed],
  ])
    assert.match(text, pattern);
});

test('a step builds and uses only files of the inventory (FU-334)', () => {
  const env = "env:\n  PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'\n";
  const build = (inputs, uses = 'docker/build-push-action@0', matrix = '') =>
    `      - uses: ${uses}\n        with:\n${inputs.map((input) => `          ${input}\n`).join('')}${matrix}`;
  const job = (steps, matrix = "['economic-service', 'api-gateway']") =>
    `on: push\n${env}jobs:\n  a:\n    runs-on: x\n    strategy:\n      matrix:\n        service: ${matrix}\n    steps:\n${steps}`;
  const checks = {
    workflow: (step, matrix) => workflowLifecycle('new.yml', job(step, matrix)),
    action: (step) =>
      actionLifecycle(ENTRY.action, `${repoText(ENTRY.action)}${step.replaceAll(/^ {2}/gm, '')}`),
  };
  const notRead = /builds .*, a file this check does not read/;
  for (const [inputs, pattern] of [
    // 3. The reviewer's probes: a Dockerfile-shaped name outside the inspected inventory.
    [['file: /tmp/Dockerfile'], notRead],
    [['file: ../external/Dockerfile'], notRead],
    [['file: ${{ env.BUILD_ROOT }}/Dockerfile'], notRead],
    // The same class: every other way a build is given a file nobody read.
    [['file: services/not-in-the-inventory/Dockerfile'], notRead],
    [['file: services/economic-service/../../../tmp/Dockerfile'], notRead],
    [['file: ${{ inputs.dockerfile }}'], notRead],
    [['file: services/${{ matrix.other }}/Dockerfile'], notRead],
    [['context: .'], notRead], // no `file`: the Dockerfile of the root, which the inventory lacks
    [
      ['context: ../external', 'file: services/economic-service/Dockerfile'],
      /not from the checkout/,
    ],
    [['context: ${{ inputs.context }}', 'file: services/economic-service/Dockerfile'], /not from/],
    [
      ['file: services/economic-service/Dockerfile', 'build-contexts: deps=docker-image://x'],
      /build input build-contexts/,
    ],
    [
      ['file: services/economic-service/Dockerfile', 'build-args: BUILDKIT_SYNTAX=x/y'],
      /build input build-args/,
    ],
    [['file: services/economic-service/Dockerfile', 'target: deps'], /build input target/],
  ])
    for (const [where, check] of Object.entries(checks))
      assert.match(check(build(inputs)).errors.join('\n'), pattern, `${where}: ${inputs}`);
  // PR #1100 r1 F2, F3: what is run and built is the tested commit's checkout, at the root.
  for (const input of ['path: sub', 'repository: other/repo', 'ref: main'])
    for (const check of Object.values(checks))
      assert.match(check(build([input], 'actions/checkout@0')).errors.join(), /checkout input/);
  // A matrix value is read only from a list written in the job, or from the reviewed source.
  const perService = build(['context: .', 'file: services/${{ matrix.service }}/Dockerfile']);
  assert.deepEqual(checks.workflow(perService).errors, []);
  // PR #1100 r1 F3: the computed matrix is read only with its reviewed producer, key and consumer.
  const ci = repoText('.github/workflows/ci.yml');
  const producer = /the matrix is not computed by the producer reviewed in MATRIX/;
  assert.match(checks.workflow(perService, MATRIX.values).errors.join('\n'), producer);
  for (const [from, to, pattern] of [
    ['services: ${{ steps.scope.outputs.services }}', `services: '["../../tmp"]'`, producer],
    ['node scripts/container-scope.mjs --run', 'echo services=[] >> "$GITHUB_OUTPUT"', producer],
    ['id: scope\n', 'id: other\n', producer],
    [`service: ${MATRIX.values}`, `other: ${MATRIX.values}`, notRead],
    [MATRIX.consumer, 'services/${{ matrix.service }}/../Dockerfile', notRead],
  ])
    assert.match(workflowLifecycle('ci.yml', swap(ci, from, to)).errors.join('\n'), pattern, to);
  const scripts = createHash('sha256').update(MATRIX.scripts.map(repoText).join('')).digest('hex');
  assert.equal(`sha256:${scripts}`, MATRIX.scriptsSha256, 'read what they print, then pin again');
  for (const matrix of [
    "['economic-service', '../../tmp']",
    "['economic-service', 7]",
    '${{ fromJSON(inputs.services) }}',
    "['economic-service']\n        include:\n          - service: ../../tmp",
  ])
    assert.match(checks.workflow(perService, matrix).errors.join('\n'), notRead, matrix);
  assert.match(checks.action(perService).errors.join('\n'), notRead);
  assert.match(
    workflowLifecycle(
      'new.yml',
      job(perService).replace(
        '      matrix:\n        service:',
        '      matrix: ${{ fromJSON(inputs.matrix) }}\n      other:',
      ),
    ).errors.join('\n'),
    notRead,
  );
  // An action nobody reviewed can name a build file by any key; a local one is read as a file.
  const unreviewed = /an action this check has neither read nor reviewed/;
  for (const step of [
    build(['dockerfile: /tmp/Dockerfile'], 'someone/build-image-action@v1'),
    build(['args: sh -c "npm rebuild"'], 'docker://alpine:3'),
    build(['key: x'], './.github/actions/not-in-the-inventory'),
    build(['key: x'], './tmp/action'),
    build(['key: x'], '${{ inputs.action }}'),
    '      - run: echo\n        with:\n          file: /tmp/Dockerfile\n',
  ])
    for (const [where, check] of Object.entries(checks))
      assert.match(
        check(step).errors.join('\n'),
        step.includes('run: echo') ? /with is given to no action/ : unreviewed,
        `${where}: ${step}`,
      );
  assert.deepEqual(
    checks.workflow(build(['key: x'], './.github/actions/restore-trivy-db')).errors,
    [],
  );
});

// The shared reader by itself, under a policy that is not this guard's: what FU-338 will hand it.
test('the shared shell reader refuses whatever its policy does not list (FU-334)', () => {
  const policy = {
    programs: {
      echo: true,
      command: true,
      sudo: true,
      bash: (args, context) => context.shell(args, 'bash'),
    },
    file: (path) => (path === 'scripts/reviewed.sh' ? null : 'is not reviewed'),
    tolerated: new Set(['a pipeline, an || list or a background command', 'redirection']),
  };
  const problems = (text) => readShell(text, policy).problems.join('\n');
  for (const text of [
    'sudo /usr/bin/ap[t]-get install -y libnss3',
    'sudo apt-get install -y libnss3',
    'builtin source /tmp/setup-browser',
    'command source /tmp/setup-browser',
    'echo "$SETUP" | bash</dev/stdin',
    'bash -c "apt-get install -y libnss3"',
    'bash /tmp/setup-browser',
    '"$tool" install',
    'echo $(apt-get install -y libnss3)',
    'echo ok; (apt-get install -y libnss3)',
  ])
    assert.notEqual(problems(text), '', text);
  for (const text of ['echo ok', 'bash -c "echo ok"', 'bash scripts/reviewed.sh', 'sudo echo ok'])
    assert.equal(problems(text), '', text);
  // r1 F4: a wrapper's grammar is asked too, and an entry that is not `true` or a grammar lists nothing.
  const wrapped = readShell('sudo echo ok', { programs: { sudo: () => 'DENIED', echo: true } });
  assert.match(wrapped.problems.join(), /DENIED/);
  for (const entry of [false, null, undefined])
    assert.match(
      readShell('echo ok', { programs: { echo: entry } }).problems.join(),
      /does not list/,
    );
  // r1 F1: a redirection's target is marked, and a descriptor is no word.
  assert.deepEqual(
    parseCommands('2>&1 >echo env x <in 3<>f y&>>g').commands[0].words.map(
      ({ value, redirect }) => (redirect ?? '') + value,
    ),
    ['2>&1', '>echo', 'env', 'x', '<in', '3<>f', 'y', '&>>g'],
  );
  // A policy that gives no rule for a part of the text admits none of it: no assignment, no file.
  assert.match(problems('LEVEL=1 echo ok'), /assigns a variable/);
  assert.equal(readShell('LEVEL=1 echo ok', { ...policy, name: () => null }).problems.length, 0);
  assert.match(readShell('scripts/reviewed.sh', { programs: {} }).problems.join(), /does not list/);
  // A word keeps its spelling, so an exception can be bound to the exact text that was reviewed.
  const [{ words }] = parseCommands('x="${A}" docker -v "$PWD/a:/b" \'c d\'').commands;
  assert.deepEqual(
    words.map((word) => word.source),
    ['x="${A}"', 'docker', '-v', '"$PWD/a:/b"', "'c d'"],
  );
  // A subshell's `cd` does not reach the command after it; one in the same shell does.
  const scopes = (text) => parseCommands(text).commands.map(({ scope }) => scope);
  assert.deepEqual(scopes('a; (cd x; b); c; d=$(cd y; e); f'), [
    '',
    '1',
    '1',
    '',
    '2',
    '2',
    '',
    '',
  ]);
  // A `case` pattern closes with a `)` that opened nothing: after one, no subshell is left.
  assert.deepEqual(scopes('a; (cd x; case q in q) b;; esac; c); d'), ['', ...Array(6).fill('1')]);
  const table = { flags: '--prod', values: '--filter' };
  const read = (text, grammar = table) =>
    readOptions(parseCommands(text).commands[0].words, grammar);
  assert.deepEqual(
    read('--prod --filter a --filter=b /out').operands.map((word) => word.value),
    ['/out'],
  );
  for (const text of [
    '-c',
    '--shell-mode',
    '--prod=1',
    '--filter',
    '--filter "$x"',
    '"$option"',
    '--',
  ])
    assert.ok(read(text).problem, text);
  const run = (text) => dockerRun(parseCommands(text).commands[0].words);
  const split = run('--rm -e A="$b" --entrypoint=sh "$image" -c "x y"');
  assert.deepEqual(
    split.options.map(({ name, value }) => [name, value?.value ?? null]),
    [
      ['--rm', null],
      ['-e', 'A='],
      ['--entrypoint', 'sh'],
    ],
  );
  assert.deepEqual(
    split.command.map((word) => word.value),
    ['-c', 'x y'],
  );
  for (const text of [
    '--rm',
    '--unknown image',
    '$options image',
    '-e $value image',
    '"$@"',
    '--entrypoint',
  ])
    assert.ok(run(text).problem, text);
  const steps = { step: { shell: 'sh' }, job: { defaults: { run: { shell: 'bash' } } } };
  assert.deepEqual(effectiveShell(steps), { shell: 'sh' });
  assert.deepEqual(effectiveShell({ step: {}, job: steps.job }), { shell: 'bash' });
  assert.deepEqual(effectiveShell({ step: {} }), { shell: 'bash' });
  assert.ok(effectiveShell({ step: {}, composite: true }).problem);
  for (const shell of ['bash -e {0}', 'python', 'pwsh', '${{ inputs.shell }}', ['bash']])
    for (const level of [
      { step: { shell } },
      { job: { defaults: { run: { shell } } } },
      { workflow: { defaults: { run: { shell } } } },
    ])
      assert.ok(effectiveShell({ step: { shell: 'bash' }, ...level }).problem, String(shell));
});

// The class of F2: a script that hands PATH on by name builds a child's environment from scratch,
// so it sets the suppression itself, or is listed with why its child reaches no package manager.
test('every rebuilt child environment carries the suppression', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const startsNoPackageManager = {
    'apps/web/scripts/build-group.mjs': 'the signal sender; the build is sent the full environment',
    'scripts/marketplace-saga-drain-check.mjs': 'psql only',
  };
  const rebuilt = [];
  for (const file of authoredFiles(root)) {
    const path = relative(root, file).replaceAll('\\', '/');
    if (!/\.(?:[cm]?js|ts)$/.test(path) || /\.(?:test|[a-z-]*spec)\.|\/(?:test|e2e)\//.test(path))
      continue;
    const source = readFileSync(file, 'utf8');
    if (!/PATH: process\.env\.PATH|\[\s*'PATH'/.test(source)) continue;
    rebuilt.push(path);
    assert.equal(
      source.includes("PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'"),
      !Object.hasOwn(startsNoPackageManager, path),
      path,
    );
  }
  assert.deepEqual(
    rebuilt.sort(),
    [
      ...Object.keys(startsNoPackageManager),
      'scripts/backup-restore-drill-main.mjs',
      'scripts/ci-integration-split-lib.mjs',
      'scripts/prepush-parity-lib.mjs',
      'scripts/prepush-scope-lib.mjs',
    ].sort(),
  );
});
