import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const cli = new URL('./backup-restore-drill.mjs', import.meta.url);
const repo = new URL('..', import.meta.url).pathname;

function fixture(directory) {
  const root = join(directory, 'root');
  mkdirSync(root);
  for (const file of [
    'docker-compose.yml',
    '.env.example',
    '.env.migrator.example',
    'infrastructure/docker/postgres/lib/role-passwords.bash',
  ]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  // Copy only schema discovery inputs; never copy a developer's .env.
  for (const entry of readdirSync(join(repo, 'services'))) {
    const schema = join('services', entry, 'prisma/schema.prisma');
    if (existsSync(join(repo, schema))) {
      mkdirSync(join(root, schema, '..'), { recursive: true });
      cpSync(join(repo, schema), join(root, schema));
    }
  }
  return root;
}
async function waitFor(path) {
  for (let attempt = 0; attempt < 400 && !existsSync(path); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(path), path);
}
function start(directory, root, extra = {}, executable = cli.pathname) {
  const child = spawn(process.execPath, [executable, '--report', join(directory, 'report.json')], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TMPDIR: directory,
      RASTA_DRILL_ROOT: root,
      DOCKER_CONTEXT: 'remote',
      DOCKER_HOST: 'ssh://unwanted',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

test('early mkdtemp failure writes a nonempty failure report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-early-test-'));
  try {
    const child = start(directory, fixture(directory), { TMPDIR: join(directory, 'missing') });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.error.stage, 'preflight');
    assert.equal(evidence.cleanup.passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator root with local .env still refuses before setup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-env-test-'));
  try {
    const root = fixture(directory);
    writeFileSync(join(root, '.env'), 'SYNTHETIC_TEST=true\n');
    const child = start(directory, root);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.match(evidence.error.message, /Use a clean worktree without local env files/);
    assert.equal(evidence.databases.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema coverage fails in both directions before any setup or fixture writes', async () => {
  for (const direction of ['missing', 'extra']) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-coverage-cli-'));
    try {
      const root = fixture(directory);
      if (direction === 'missing') {
        mkdirSync(join(root, 'services/unlisted-service/prisma'), { recursive: true });
        writeFileSync(
          join(root, 'services/unlisted-service/prisma/schema.prisma'),
          'datasource db {}',
        );
      } else rmSync(join(root, 'services/economic-service'), { recursive: true });
      writeFileSync(join(directory, 'pnpm'), `#!/bin/sh\ntouch '${directory}/side-effect'\n`, {
        mode: 0o700,
      });
      writeFileSync(join(directory, 'docker'), `#!/bin/sh\ntouch '${directory}/side-effect'\n`, {
        mode: 0o700,
      });
      const [code] = await once(start(directory, root), 'exit');
      assert.equal(code, 1);
      const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.match(evidence.error.message, /Service coverage mismatch/);
      // Resource enumeration is read-only and allowed after a refusal, but no commands are needed
      // until Compose has been written.
      assert.equal(existsSync(join(directory, 'side-effect')), false);
      assert.equal(
        readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

for (const stoppedLeftover of [false, true]) {
  test(`SIGHUP, second signal and broken stderr complete teardown; stopped leftover=${stoppedLeftover}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-signal-test-'));
    let child;
    try {
      const root = fixture(directory);
      writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh
[ "$DOCKER_CONTEXT" = default ] && [ "$DOCKER_HOST" = unix:///var/run/docker.sock ] || exit 99
case "$*" in
  *'up -d'*) touch '${directory}/started'; exec sleep 30 ;;
  *'down --volumes'*)
    touch '${directory}/cleaning'
    while [ ! -f '${directory}/release' ]; do sleep 0.05; done
    touch '${directory}/cleaned' ;;
  'container ls -a '*) ${stoppedLeftover ? 'echo stopped-owned-container' : ':'} ;;
esac
`,
        { mode: 0o700 },
      );
      child = start(directory, root);
      const exit = once(child, 'exit');
      await waitFor(join(directory, 'started'));
      child.kill('SIGHUP');
      await waitFor(join(directory, 'cleaning'));
      // Close the read end of a real pipe. The next signal writes to the broken pipe.
      child.stderr.destroy();
      child.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(join(directory, 'release'), 'go');
      const [code] = await exit;
      assert.equal(code, 1);
      const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.equal(evidence.interrupted, true);
      assert.equal(evidence.passed, false);
      assert.deepEqual(evidence.signals, [
        { signal: 'SIGHUP', duringCleanup: false },
        { signal: 'SIGINT', duringCleanup: true },
      ]);
      assert.equal(evidence.cleanup.passed, !stoppedLeftover);
      assert.ok(existsSync(join(directory, 'cleaned')), 'blocked teardown completed');
      if (stoppedLeftover) assert.ok(evidence.cleanup.temporary);
      else
        assert.equal(
          readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
          false,
        );
    } finally {
      child?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('bounded command diagnostics redact database URLs and retain synthetic stdout honestly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-diagnostic-test-'));
  try {
    const root = fixture(directory);
    writeFileSync(
      join(directory, 'pnpm'),
      '#!/bin/sh\nprintf "synthetic-demo-row\\n"\nprintf "postgresql://demo:example@127.0.0.1/disposable\\n" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const [code] = await once(start(directory, root), 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.match(evidence.error.message, /synthetic-demo-row/);
    assert.match(evidence.error.message, /database URL redacted/);
    assert.doesNotMatch(evidence.error.message, /postgresql:|demo:example/);
    assert.equal(evidence.cleanup.passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const direction of ['missing', 'extra', 'empty']) {
  test(`.env.example ${direction} service refuses before setup`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-env-coverage-'));
    try {
      const root = fixture(directory);
      const path = join(root, '.env.example');
      const baseline = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        direction === 'missing'
          ? baseline.replace(/^DATABASE_URL_ECONOMIC=.*\n/m, '')
          : direction === 'extra'
            ? baseline + '\nDATABASE_URL_UNKNOWN=postgresql://example\n'
            : '',
      );
      for (const command of ['pnpm', 'docker'])
        writeFileSync(join(directory, command), `#!/bin/sh\ntouch '${directory}/side-effect'\n`, {
          mode: 0o700,
        });
      const [code] = await once(start(directory, root), 'exit');
      assert.equal(code, 1);
      assert.match(
        JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')).error.message,
        /(?:coverage|Service coverage) mismatch|Invalid .env.example/,
      );
      assert.equal(existsSync(join(directory, 'side-effect')), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const mode of ['failed', 'empty', 'truncated', 'complete']) {
  test(`schema dump subprocess ${mode}: byte preservation and private failure diagnostics`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-dump-command-'));
    try {
      const root = fixture(directory);
      for (const entry of readdirSync(join(root, 'services'))) {
        writeFileSync(
          join(root, 'services', entry, 'package.json'),
          JSON.stringify({ scripts: { 'db:migrate': 'true' } }),
        );
      }
      const names = readdirSync(join(root, 'services')).map(
        (name) => 'rasta_' + name.replace(/-service$/, '').replaceAll('-', '_'),
      );
      const ledger = {
        journalsChecked: '2',
        entriesChecked: '4',
        walletsChecked: '1',
        journalMismatches: '0',
        walletMismatches: '0',
        amountsByCurrency: [{ currency: 'IRR', total: '1' }],
        fixtureAmount: '9007199254740993',
      };
      const complete =
        '--\\n-- PostgreSQL database dump\\n--\\n\\n-- Dumped from database version 16.4\\n-- Dumped by pg_dump version 16.4\\n\\nSET statement_timeout = 0;\\nCREATE TABLE fixture (id integer);\\n--\\n-- PostgreSQL database dump complete\\n--\\n\\n';
      writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh
case "$*" in
  *'port source 5432'*) echo 127.0.0.1:54321 ;;
  *'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 16.4' ;;
  *'pg_dump --help'*) echo help ;;
  *'pg_dump --schema-only'*)
    ${mode === 'failed' ? 'echo PRIVATE_FUNCTION_BODY; echo PRIVATE_ERROR >&2; exit 1' : mode === 'truncated' ? "printf '%s' '--\\n-- PostgreSQL database dump\\nCREATE PRIVATE_FUNCTION_BODY'" : mode === 'complete' ? `printf '%b' '${complete}'` : ':'} ;;
  *'psql '*)
    body=$(cat)
    case "$body" in
      *'json_agg(datname'*) echo '${JSON.stringify(names)}' ;;
      *'journalsChecked'*) echo '${JSON.stringify(ledger)}' ;;
    esac ;;
esac
`,
        { mode: 0o700 },
      );
      const [code] = await once(start(directory, root), 'exit');
      assert.equal(code, 1);
      const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.equal(evidence.error.stage, 'dump rasta_identity');
      assert.match(
        evidence.error.message ?? '',
        mode === 'failed'
          ? /^$/
          : mode === 'complete'
            ? // The complete dump passed; this stub intentionally supplies no inventory.
              /Unexpected end of JSON input/
            : /Missing schema dump|Incomplete schema dump/,
      );
      if (mode === 'failed')
        assert.deepEqual(evidence.error, {
          stage: 'dump rasta_identity',
          database: 'rasta_identity',
          exitCode: 1,
        });
      assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_FUNCTION_BODY|PRIVATE_ERROR/);
      assert.equal(evidence.cleanup.passed, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

// Full operator path with synthetic subprocesses, including both owned scratch databases.
// Mutate only isolated copies; never edit an implementation file while another test runs.
async function referenceCliFixture(directory, mode) {
  const root = fixture(directory);
  for (const entry of readdirSync(join(root, 'services'))) {
    writeFileSync(
      join(root, 'services', entry, 'package.json'),
      JSON.stringify({ scripts: { 'db:migrate': 'true' } }),
    );
  }
  const names = readdirSync(join(root, 'services')).map(
    (name) => 'rasta_' + name.replace(/-service$/, ''),
  );
  const copied = join(directory, 'cli');
  mkdirSync(copied);
  for (const name of [
    'backup-restore-drill.mjs',
    'backup-restore-drill-lib.mjs',
    'infra-preflight-lib.mjs',
    'check-kafka-credential-scope-lib.mjs',
    'database-services.mjs',
  ])
    cpSync(join(repo, 'scripts', name), join(copied, name));
  // The drill reads example URLs through the shared reader, imported relative to scripts/.
  const reader = 'packages/config/src/url-reader.js';
  mkdirSync(join(directory, reader, '..'), { recursive: true });
  cpSync(join(repo, reader), join(directory, reader));
  symlinkSync(join(repo, 'node_modules'), join(copied, 'node_modules'), 'dir');
  const path = join(copied, 'backup-restore-drill.mjs');
  const target = mode === 'bypass-ref' ? path : join(copied, 'backup-restore-drill-lib.mjs');
  let implementation = readFileSync(target, 'utf8');
  const replacements = {
    'bypass-ref': [
      'before.reference = await collectReference(source, `rasta_${service}`, before.schemaDump);',
      'before.reference = { checkLinesDifferent: 0, milliseconds: 0 };',
    ],
    'bypass-fixed': [
      "const dumped = await dump(name, index === 0 ? 'reference' : 'fixed-point');",
      "const dumped = await dump(scratch[0], index === 0 ? 'reference' : 'fixed-point');",
    ],
    'bypass-guard': [
      'const allowance = checkSourceReference(sourceDump, reference.evidence, database);',
      'const allowance = undefined;',
    ],
  };
  if (replacements[mode]) {
    const [before, after] = replacements[mode];
    assert.equal(implementation.split(before).length, 2, 'mutant must change one call');
    implementation = implementation.replace(before, after);
  }
  writeFileSync(target, implementation);
  const dump =
    '--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version 16.4\n-- Dumped by pg_dump version 16.4\n\nSET statement_timeout = 0;\nCREATE TABLE "public"."fixture" (\n    "id" integer,\n    CONSTRAINT "ck" CHECK ((id >= 0))\n);\n--\n-- PostgreSQL database dump complete\n--\n\n';
  writeFileSync(join(directory, 'schema.sql'), dump);
  writeFileSync(
    join(directory, 'pnpm'),
    `#!/bin/sh
${mode === 'failed-migrate' ? 'case "$*" in *db:migrate*) echo PRIVATE_MIGRATION_SQL; echo PRIVATE_MIGRATION_SQL >&2; exit 43;; esac' : ':'}
exit 0
`,
    { mode: 0o700 },
  );
  const ledger = {
    journalsChecked: '2',
    entriesChecked: '4',
    walletsChecked: '1',
    journalMismatches: '0',
    walletMismatches: '0',
    amountsByCurrency: [{ currency: 'IRR', total: '1' }],
    fixtureAmount: '9007199254740993',
  };
  writeFileSync(
    join(directory, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${directory}/commands'
case "$*" in
  *'port source 5432'*) echo 127.0.0.1:54321 ;;
  *'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 16.4' ;;
  *'pg_dump --help'*) echo help ;;
  *'pg_dump --schema-only'*)
    case "$*" in
      *'drill_ref_'*) ${mode === 'failed-ref-dump' ? 'echo PRIVATE_REF_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
      *'drill_fixed_'*) ${mode === 'failed-fixed-dump' ? 'echo PRIVATE_FIXED_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
    esac
    ${mode === 'check-drift' ? `case "$*" in *'drill_ref_'*|*'drill_fixed_'*|*'-restored '*) sed 's/((id >= 0))/(id >= 0)/' '${directory}/schema.sql';; *) cat '${directory}/schema.sql';; esac` : mode === 'original-and-drop-fail' ? `case "$*" in *'drill_ref_'*) sed 's/"id" integer/"id" bigint/' '${directory}/schema.sql';; *) cat '${directory}/schema.sql';; esac` : `cat '${directory}/schema.sql'`} ;;
  *'pg_restore '*) ${mode === 'failed-archive' ? 'echo PRIVATE_ARCHIVE_SQL; echo PRIVATE_ARCHIVE_SQL >&2; exit 42' : ':'} ;;
  *'psql '*)
    body=$(cat)
    case "$body" in
      *'CREATE DATABASE "drill_'*)
        printf '%s\\n' "$body" >> '${directory}/scratch-created' ;;
      *'DROP DATABASE IF EXISTS "drill_'*)
        printf '%s\\n' "$body" >> '${directory}/scratch-dropped'
        ${mode === 'failed-drop' || mode === 'original-and-drop-fail' ? 'echo PRIVATE_DROP_SQL >&2; exit 44' : ':'} ;;
      *'PostgreSQL database dump'*)
        case "$*" in
          *'drill_ref_'*)
            ${mode === 'signal-ref' ? `touch '${directory}/started'; exec sleep 30` : mode === 'failed-ref-restore' ? 'echo PRIVATE_REF_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
          *'drill_fixed_'*)
            ${mode === 'signal-fixed' ? `touch '${directory}/started'; exec sleep 30` : mode === 'failed-fixed-restore' ? 'echo PRIVATE_FIXED_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
        esac ;;
      *'json_agg(datname'*) echo '${JSON.stringify(names)}' ;;
      *'journalsChecked'*) echo '${JSON.stringify(ledger)}' ;;
      *'row_to_json(m)'*) echo '[{"migration_name":"fixture","checksum":"fixture","finished_at":"2026-01-01","rolled_back_at":null}]' ;;
      *'FROM pg_database d WHERE'*) echo '{"owner":"rasta","acl":[],"settings":[]}' ;;
      *'WITH namespaces AS'*) echo '{"schemas":[{"name":"public","owner":"rasta"}],"relations":[{"name":"public.fixture","owner":"rasta"}],"defaultPrivileges":[]}' ;;
      *'row_to_json(t)'*) echo '{"name":"public.fixture","rows":"1","kind":"application","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' ;;
    esac ;;
  *'down --volumes'*) touch '${directory}/cleaned' ;;
esac
`,
    { mode: 0o700 },
  );
  return { root, path };
}

for (const mode of [
  'baseline',
  'check-drift',
  'failed-archive',
  'failed-migrate',
  'failed-drop',
  'original-and-drop-fail',
  'bypass-ref',
  'bypass-fixed',
  'bypass-guard',
  'failed-ref-restore',
  'failed-fixed-restore',
  'failed-ref-dump',
  'failed-fixed-dump',
  'signal-ref',
  'signal-fixed',
]) {
  test(`full CLI reference acceptance and scratch cleanup: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-reference-cli-'));
    let child;
    try {
      const { root, path } = await referenceCliFixture(directory, mode);
      child = start(directory, root, {}, path);
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = once(child, 'close');
      if (mode.startsWith('signal-')) {
        await waitFor(join(directory, 'started'));
        const privateDirectory = join(
          directory,
          readdirSync(directory).find((name) => name.startsWith('rasta-restore-drill-')),
        );
        assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
        const sqlFiles = readdirSync(privateDirectory).filter((name) => name.endsWith('.sql'));
        assert.ok(sqlFiles.length >= 2);
        for (const name of sqlFiles)
          assert.equal(statSync(join(privateDirectory, name)).mode & 0o777, 0o600);
        child.kill('SIGTERM');
      }
      const [code] = await exited;
      const success = ['baseline', 'check-drift'].includes(mode);
      assert.equal(code, success ? 0 : 1);
      const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.equal(report.passed, success);
      assert.equal(report.cleanup.passed, true);
      assert.ok(existsSync(join(directory, 'cleaned')));
      assert.doesNotMatch(
        JSON.stringify(report) + stdout + stderr,
        /PRIVATE_REF_SQL|PRIVATE_FIXED_SQL|PRIVATE_ERROR|PRIVATE_ARCHIVE_SQL|PRIVATE_MIGRATION_SQL|PRIVATE_DROP_SQL/,
      );
      assert.equal(
        readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
        false,
      );
      if (mode === 'bypass-fixed') {
        assert.equal(report.error.message, 'Invalid schema dump provenance');
        assert.doesNotMatch(report.error.message, /TypeError|undefined|properties/);
      }
      if (mode === 'failed-archive' || mode === 'failed-migrate') {
        assert.deepEqual(report.error, {
          stage:
            mode === 'failed-archive' ? 'restore and compare rasta_identity' : 'migrate identity',
          database: 'rasta_identity',
          exitCode: mode === 'failed-archive' ? 42 : 43,
        });
      }
      if (mode === 'failed-drop' || mode === 'original-and-drop-fail') {
        assert.equal(report.scratchDropFailed.length, 2);
        assert.ok(
          report.scratchDropFailed.every(
            (error) => error.stage === 'scratch drop' && error.exitCode === 44,
          ),
        );
        if (mode === 'original-and-drop-fail')
          assert.equal(report.error.message, 'SOURCE/REF non-CHECK difference');
        else assert.equal(report.error.stage, 'scratch drop');
      }
      if (mode === 'check-drift') {
        assert.ok(report.databases.every((db) => db.before.reference.checkLinesDifferent === 1));
        assert.ok(
          report.databases.every(
            (db) =>
              JSON.stringify(db.before.reference.checkConstraints) ===
              JSON.stringify([{ schema: 'public', table: 'fixture', name: 'ck' }]),
          ),
        );
        assert.doesNotMatch(JSON.stringify(report), /id >= 0|CONSTRAINT|CREATE TABLE/);
      }
      if (!['bypass-ref', 'failed-migrate'].includes(mode)) {
        const created = readFileSync(join(directory, 'scratch-created'), 'utf8');
        assert.match(
          created,
          new RegExp(`drill_ref_${report.project.slice('restore-drill-'.length)}`),
        );
        if (mode === 'baseline' || mode === 'signal-fixed') assert.match(created, /drill_fixed_/);
        if (!mode.startsWith('signal-')) {
          const dropped = readFileSync(join(directory, 'scratch-dropped'), 'utf8');
          assert.match(dropped, /drill_ref_/);
          assert.match(dropped, /drill_fixed_/);
        }
      }
      if (mode === 'baseline') {
        assert.equal(report.databases.length, 16);
        assert.ok(
          report.databases.every(
            (db) =>
              db.before.reference.checkLinesDifferent === 0 &&
              db.referenceChecked &&
              db.fixedPointEqual &&
              db.allowanceChecked,
          ),
        );
      }
    } finally {
      child?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('SIGKILL leaves a provisional private report with project and Compose cleanup path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-sigkill-test-'));
  let child;
  try {
    const root = fixture(directory);
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'up -d'*)
    touch '${directory}/started'
    while [ ! -f '${directory}/release' ]; do sleep 0.05; done
    touch '${directory}/released' ;;
  *'down --volumes'*) touch '${directory}/unexpected-cleanup' ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root);
    const exited = once(child, 'exit');
    await waitFor(join(directory, 'started'));
    child.kill('SIGKILL');
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const path = join(directory, 'report.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(report.project, /^restore-drill-[a-f0-9]{16}$/);
    assert.equal(report.passed, false);
    assert.equal(report.cleanup.passed, false);
    assert.equal(report.finishedAt, undefined);
    assert.ok(report.temporary.startsWith(directory + '/rasta-restore-drill-'));
    const compose = JSON.parse(readFileSync(join(report.temporary, 'compose.json'), 'utf8'));
    assert.equal(compose.services.source.container_name, `${report.project}-source`);
    assert.equal(existsSync(join(directory, 'unexpected-cleanup')), false);
  } finally {
    child?.kill('SIGKILL');
    writeFileSync(join(directory, 'release'), 'go');
    await waitFor(join(directory, 'released'));
    rmSync(directory, { recursive: true, force: true });
  }
});
