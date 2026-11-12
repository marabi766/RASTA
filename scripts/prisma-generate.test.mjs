import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoredFiles } from './authored-source-inventory.cjs';
import { generate, schemaArgs } from './prisma-generate.mjs';
import { effectiveShell, readOptions, readShell } from './ci-shell-policy-lib.mjs';
import { parseCommands } from './ci-shell-text-lib.mjs';
import {
  actionLifecycle,
  dockerfileLifecycle,
  lifecycleFileKind,
  workflowLifecycle,
} from './prisma-lifecycle-suppression-lib.mjs';

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
    if (accepted) assert.deepEqual(errors, [], `${where}: ${script}`);
    else assert.match(errors.join('\n'), pattern, `${where}: ${script}`);
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
    'echo "INTERNAL_TOKEN_SECRET=${secret}" >> "$GITHUB_ENV"',
    'if ! command -v gitleaks >/dev/null 2>&1; then pnpm exec turbo run build | tee out.log; fi',
    'docker run --rm --entrypoint sh image@sha256:0 -c "promtool test rules /etc/x.yml"',
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
  assert.deepEqual(
    workflowLifecycle('new.yml', file('services/${{ matrix.service }}/Dockerfile')).errors,
    [],
  );
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
    ['export PNPM_CONFIG_SCRIPT_SHELL=/tmp/sh', form('export')],
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
    ['n>pm install', /writes a redirection into a word/],
    ['pnp>m deploy /out', /writes a redirection into a word/],
    ['nod<e scripts/prisma-generate.mjs', /writes a redirection into a word/],
    ['n2>&1pm install', UNPROVEN],
    // `bash` runs a file of this repository, or text that was read.
    ['bash -c "env -i pnpm deploy /out"', form('bash')],
    ['bash -lc "pnpm install"', form('bash')],
    ['bash /tmp/install.sh', form('bash')],
  ])
    everywhere(script, pattern);
  // Controls: the read forms.
  for (const script of [
    'pnpm --filter @rasta/web exec playwright test -c playwright.config.ts',
    'pnpm run test:integration --shard=economic -- --verbose',
    'npm install -g pnpm@11.22.0\npnpm config set store-dir /pnpm/store',
    'bash -c "pnpm install --frozen-lockfile"',
  ])
    everywhere(script, null, true);
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
