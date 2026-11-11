import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoredFiles } from './authored-source-inventory.cjs';
import { generate, schemaArgs } from './prisma-generate.mjs';
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
const refused = (check, name, text, pattern) => {
  const { errors } = check(name, text);
  assert.ok(errors.length > 0, `${name} was accepted`);
  assert.match(errors.join('\n'), pattern, name);
};

test('every Dockerfile stage, workflow step and action runs lifecycle hooks suppressed', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const seen = { dockerfile: [], workflow: [], action: [] };
  for (const file of authoredFiles(root)) {
    const path = relative(root, file).replaceAll('\\', '/');
    const kind = lifecycleFileKind(path);
    if (!kind) continue;
    seen[kind].push(path);
    const { errors, commands } = LIFECYCLE_CHECKS[kind](path, readFileSync(file, 'utf8'));
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
    [swap(real, deploy, `env -i ${deploy}`), /`env` can replace the environment/],
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
    [
      swap(real, 'CMD ["node", "dist/main.js"]', 'CMD ["pnpm", "start"]'),
      /CMD names a package manager/,
    ],
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
    [first('      - run: env -i pnpm deploy /out\n'), /`env` can replace the environment/],
    [first(`${install}        shell: env -i bash {0}\n`), /shell .* is not one this check reads/],
    [
      `${real}  called:\n    uses: ./.github/workflows/other.yml\n`,
      /a called workflow gets no env/,
    ],
  ])
    refused(workflowLifecycle, name, mutant, pattern);

  // Control: an environment wrapper in a step that names no package manager is not this check's.
  const apt = workflowLifecycle(name, first('      - run: sudo apt-get install -y jq\n'));
  assert.deepEqual(apt.errors, []);

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
    [more('    - shell: bash\n      run: sudo pnpm i\n'), /`sudo` can replace the environment/],
    [swap(composite, 'using: composite', 'using: node20'), /not a composite action/],
  ])
    refused(actionLifecycle, action, mutant, pattern);
});
