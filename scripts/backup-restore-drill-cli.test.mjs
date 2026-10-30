import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
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
import {
  holdUntil,
  pollUntil,
  waitForFile as waitFor,
  waitForPid,
  waitForRecordedGroup,
} from './backup-restore-drill-test-support.mjs';

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
    // Cleanup ownership serializes before everything else, so a torn rewrite still names it.
    assert.deepEqual(Object.keys(evidence).slice(0, 2), ['project', 'temporary']);
    const raw = readFileSync(join(directory, 'report.json'), 'utf8');
    assert.ok(raw.indexOf('"project"') < raw.indexOf('"databases"'));
    assert.ok(raw.indexOf('"temporary"') < raw.indexOf('"databases"'));
    // No sibling residue of the atomic rewrite survives a normal run; the only file beside the
    // report is the journal whose checkpoint licensed the directory's removal.
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith('report.json.')),
      ['report.json.recovery-journal.json'],
    );
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
        `#!/bin/bash
[ "$DOCKER_CONTEXT" = default ] && [ "$DOCKER_HOST" = unix:///var/run/docker.sock ] || exit 99
case "$*" in
  *'up -d'*) touch '${directory}/started'; exec sleep 30 ;;
  *'down --volumes'*)
    touch '${directory}/cleaning'
    ${holdUntil(directory, `${directory}/release`)}
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
    'backup-restore-drill-main.mjs',
    'backup-restore-drill-lib.mjs',
    'backup-restore-drill-recovery.mjs',
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
  const target = ['bypass-ref', 'ignore-input'].includes(mode)
    ? join(copied, 'backup-restore-drill-main.mjs')
    : join(copied, 'backup-restore-drill-lib.mjs');
  let implementation = readFileSync(target, 'utf8');
  const replacements = {
    'bypass-ref': [
      'before.reference = await collectReference(source, `rasta_${service}`, before.schemaDump);',
      'before.reference = { checkLinesDifferent: 0, milliseconds: 0 };',
    ],
    'bypass-fixed': [
      "const dumped = await dump(name, index === 0 ? 'reference' : 'fixed-point', {",
      "const dumped = await dump(scratch[0], index === 0 ? 'reference' : 'fixed-point', {",
    ],
    // The WRONG VALID evidence: SOURCE's separate dump is restored again as the fixed point.
    'wrong-input': ['const input = index === 0 ? separate : reference;', 'const input = separate;'],
    // The restore callback ignores the evidence it is handed and reads SOURCE's file.
    'ignore-input': [
      "const fd = openSync(dumpPath(input), 'r');",
      "const fd = openSync(join(temporary, `${database}-reference-input.schema.sql`), 'r');",
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
    `#!/bin/bash
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
    ${['check-drift', 'ignore-input'].includes(mode) ? `case "$*" in *'drill_ref_'*|*'drill_fixed_'*|*'-restored '*) sed 's/((id >= 0))/(id >= 0)/' '${directory}/schema.sql';; *) cat '${directory}/schema.sql';; esac` : mode === 'original-and-drop-fail' ? `case "$*" in *'drill_ref_'*) sed 's/"id" integer/"id" bigint/' '${directory}/schema.sql';; *) cat '${directory}/schema.sql';; esac` : `cat '${directory}/schema.sql'`} ;;
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
            printf '%s\\n' "$body" >> '${directory}/ref-input'
            ${mode === 'signal-ref' ? `touch '${directory}/started'; exec sleep 30` : mode === 'failed-ref-restore' ? 'echo PRIVATE_REF_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
          *'drill_fixed_'*)
            printf '%s\\n' "$body" >> '${directory}/fixed-input'
            ${mode === 'signal-fixed' ? `touch '${directory}/started'; exec sleep 30` : mode === 'failed-fixed-restore' ? 'echo PRIVATE_FIXED_SQL; echo PRIVATE_ERROR >&2; exit 1' : ':'} ;;
        esac ;;
      *'json_agg(datname'*) echo '${JSON.stringify(names)}' ;;
      *'journalsChecked'*) echo '${JSON.stringify(ledger)}'
        ${mode === 'cleanup-write-fails' ? `[ -f '${directory}/ledger-seen' ] && chmod 555 '${directory}'; touch '${directory}/ledger-seen' 2>/dev/null` : ':'} ;;
      *'row_to_json(m)'*) echo '[{"migration_name":"fixture","checksum":"fixture","finished_at":"2026-01-01","rolled_back_at":null}]' ;;
      *'FROM pg_database d WHERE'*) echo '{"owner":"rasta","acl":[],"settings":[]}' ;;
      *'WITH namespaces AS'*) echo '{"schemas":[{"name":"public","owner":"rasta"}],"relations":[{"name":"public.fixture","owner":"rasta"}],"defaultPrivileges":[]}' ;;
      *'row_to_json(t)'*) echo '{"name":"public.fixture","rows":"1","kind":"application","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' ;;
    esac ;;
  *'down --volumes'*) ${mode === 'cleanup-write-fails' ? `${holdUntil(directory, `${directory}/writable`)}; ` : ''}touch '${directory}/cleaned' ;;
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
  'wrong-input',
  'ignore-input',
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
      const success = ['baseline', 'check-drift', 'ignore-input'].includes(mode);
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
      if (mode === 'bypass-fixed' || mode === 'wrong-input') {
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
      if (['check-drift', 'ignore-input'].includes(mode)) {
        // The stub's REF differs from SOURCE, so the restore inputs are observable: REF is restored
        // from SOURCE's separate dump, and the fixed point from REF (never SOURCE again).
        const ref = readFileSync(join(directory, 'ref-input'), 'utf8');
        const fixed = readFileSync(join(directory, 'fixed-input'), 'utf8');
        assert.match(ref, /CHECK \(\(id >= 0\)\)/);
        if (mode === 'check-drift') {
          assert.match(fixed, /CHECK \(id >= 0\)/);
          assert.doesNotMatch(fixed, /CHECK \(\(id >= 0\)\)/);
        } else assert.match(fixed, /CHECK \(\(id >= 0\)\)/);
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

const alive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitGone(pgid) {
  await pollUntil(() => !alive(pgid), `process group ${pgid} to stop`);
  return true;
}

test('SIGKILL leaves a provisional private report naming the project, directory and live process groups', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-sigkill-test-'));
  let child;
  let pgid;
  try {
    const root = fixture(directory);
    // The migration child's argv never contains the project name: pgrep -f <project> cannot find it.
    writeFileSync(
      join(directory, 'pnpm'),
      `#!/bin/bash
echo $$ > '${directory}/migrate-pgid'
touch '${directory}/migrating'
${holdUntil(directory, `${directory}/release`)}
touch '${directory}/migrate-released'
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'down --volumes'*) touch '${directory}/unexpected-cleanup' ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root);
    const exited = once(child, 'exit');
    await waitFor(join(directory, 'migrating'));
    pgid = Number(readFileSync(join(directory, 'migrate-pgid'), 'utf8'));
    // The child is blocked until `release`: its group must be recorded while it still runs. The
    // record is written right after spawn, so wait for it instead of racing the child's start.
    await waitForRecordedGroup(join(directory, 'report.json'), pgid, 'processGroups');
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
    // The detached child outlived the drill, and the report recorded its group before awaiting it.
    assert.ok(alive(pgid), 'the orphan keeps running after SIGKILL');
    assert.deepEqual(report.processGroups, [pgid]);
    assert.equal(
      execFileSync('ps', ['-o', 'args=', '-p', String(pgid)], { encoding: 'utf8' }).includes(
        report.project,
      ),
      false,
    );
  } finally {
    child?.kill('SIGKILL');
    if (pgid) process.kill(-pgid, 'SIGKILL');
    if (pgid) assert.ok(await waitGone(pgid), 'orphan group stopped');
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const holdsPipes of [false, true]) {
  test(
    `a group member that outlives its leader is killed, recorded and never ignored; holds stdout/stderr=${holdsPipes}`,
    { timeout: 60_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'drill-orphan-test-'));
      let child;
      let orphan;
      try {
        const root = fixture(directory);
        writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        // Holding the pipes keeps `close` from firing: only the leader's `exit` can end the wait,
        // far below the 10 minute command timeout.
        writeFileSync(
          join(directory, 'docker'),
          `#!/bin/sh
case "$*" in
  *'up -d'*)
    sleep 60 ${holdsPipes ? '' : '>/dev/null 2>&1 </dev/null'} &
    echo $! > '${directory}/orphan-pid' ;;
esac
`,
          { mode: 0o700 },
        );
        const started = Date.now();
        child = start(directory, root);
        const [code] = await once(child, 'exit');
        assert.ok(Date.now() - started < 30_000, 'reaped by the drain bound, not the timeout');
        assert.equal(code, 1);
        orphan = Number(readFileSync(join(directory, 'orphan-pid'), 'utf8'));
        const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
        assert.equal(report.reapedProcessGroups.length, 1);
        assert.match(report.reapedProcessGroups[0].stage, /start disposable source PostgreSQL/);
        assert.equal(report.orphanProcessGroups, undefined);
        assert.deepEqual(report.processGroups, []);
        assert.equal(report.cleanup.passed, true);
        assert.ok(await waitGone(report.reapedProcessGroups[0].pgid), 'reaped group is gone');
        assert.throws(() => process.kill(orphan, 0), /ESRCH/);
      } finally {
        child?.kill('SIGKILL');
        if (orphan) {
          try {
            process.kill(orphan, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

test('a failed final report write keeps the provisional report and its cleanup ownership', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const directory = mkdtempSync(join(tmpdir(), 'drill-writefail-test-'));
  let child;
  try {
    const root = fixture(directory);
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // The report directory becomes read-only before cleanup: sibling creation (and the
    // temporary directory's removal) then fail, so the final write cannot replace the report.
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'up -d'*) exit 1 ;;
  *'down --volumes'*) chmod 555 '${directory}' ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'close');
    chmodSync(directory, 0o755);
    assert.equal(code, 1);
    assert.match(stderr, /final report could not be written/);
    assert.doesNotMatch(stderr, new RegExp(directory));
    const path = join(directory, 'report.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(report.project, /^restore-drill-[a-f0-9]{16}$/);
    assert.ok(report.temporary.startsWith(directory + '/rasta-restore-drill-'));
    assert.equal(report.passed, false);
    assert.equal(report.cleanup.passed, false);
    assert.equal(report.finishedAt, undefined);
    // A write that started before the directory turned read-only cannot unlink its sibling:
    // any such residue is private like the report itself.
    for (const name of readdirSync(directory).filter((entry) => entry.startsWith('report.json.')))
      assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
  } finally {
    child?.kill('SIGKILL');
    try {
      chmodSync(directory, 0o755);
    } catch {
      /* removed already */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a full passing drill whose final report write fails is never reported as passed', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const directory = mkdtempSync(join(tmpdir(), 'drill-final-write-'));
  const scratch = mkdtempSync(join(tmpdir(), 'drill-final-write-tmp-'));
  let child;
  try {
    const { root, path } = await referenceCliFixture(directory, 'final-write-fails');
    // Temporary files live elsewhere, so cleanup itself succeeds (the checkpoint is written and
    // the directory removed); only the replacement of the report fails, after the removal.
    child = start(
      directory,
      root,
      {
        TMPDIR: scratch,
        ...faultEnv({
          rm: { mode: 'after', times: 0 },
          rename: {
            match: join(directory, 'report.json'),
            exact: true,
            afterRm: true,
            times: 1000,
          },
        }),
      },
      path,
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'close');
    chmodSync(directory, 0o755);
    assert.equal(code, 1);
    const summary = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(summary.passed, false);
    assert.equal(summary.cleanup.passed, true);
    assert.match(stderr, /final report could not be written; the previous report remains/);
    assert.doesNotMatch(stderr, new RegExp(directory));
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.finishedAt, undefined);
    assert.match(report.project, /^restore-drill-[a-f0-9]{16}$/);
    assert.ok(report.temporary.startsWith(scratch));
    assert.equal(statSync(join(directory, 'report.json')).mode & 0o777, 0o600);
    assert.equal(readdirSync(scratch).length, 0, 'temporary files were still removed');
  } finally {
    child?.kill('SIGKILL');
    try {
      chmodSync(directory, 0o755);
    } catch {
      /* removed already */
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a report write that fails while cleanup starts is never forgotten: the run cannot pass', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const directory = mkdtempSync(join(tmpdir(), 'drill-cleanup-write-'));
  const scratch = mkdtempSync(join(tmpdir(), 'drill-cleanup-write-tmp-'));
  let child;
  try {
    // Every comparison passes. The directory turns read-only after the restored ledger query, so
    // the write that records the `compose down` group fails; `down` makes it writable again, and
    // every later write succeeds.
    const { root, path } = await referenceCliFixture(directory, 'cleanup-write-fails');
    child = start(directory, root, { TMPDIR: scratch }, path);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // `compose down` is held until the drill has REPORTED the write it could not make: a stub that
    // made the directory writable the moment it started raced the parent, which records the
    // group right after the spawn, and a loaded machine let the stub win.
    // (The whole drill runs before this point, hence the long budget.)
    await pollUntil(
      () => /a report write failed/.test(stderr),
      'the drill to report the failed cleanup write',
      300_000,
    );
    chmodSync(directory, 0o755);
    writeFileSync(join(directory, 'writable'), '');
    const [code] = await once(child, 'close');
    chmodSync(directory, 0o755);
    assert.equal(code, 1);
    assert.match(stderr, /a report write failed; the run cannot be reported as passed/);
    assert.doesNotMatch(stderr, new RegExp(directory));
    const summary = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(summary.passed, false);
    assert.ok(existsSync(join(directory, 'cleaned')), 'cleanup continued after the failed write');
    assert.equal(summary.cleanup.passed, true);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.deepEqual(report.reportWriteFailures, [
      { stage: 'cleanup owned containers, networks and volumes' },
    ]);
    assert.ok(report.finishedAt, 'the final write succeeded and carries the marker');
    assert.ok(
      report.databases.every((db) => db.tablesEqual),
      'the comparisons themselves passed',
    );
    assert.equal(readdirSync(scratch).length, 0, 'temporary files were removed');
  } finally {
    child?.kill('SIGKILL');
    try {
      chmodSync(directory, 0o755);
      writeFileSync(join(directory, 'writable'), '');
    } catch {
      /* removed already */
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a failed process-group record stops the child, confirms it is gone and still cleans up', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const directory = mkdtempSync(join(tmpdir(), 'drill-record-fails-'));
  const scratch = mkdtempSync(join(tmpdir(), 'drill-record-fails-tmp-'));
  let child;
  let leader;
  try {
    const root = fixture(directory);
    // The write that records the next child's group fails (read-only directory); the cleanup
    // command makes it writable again.
    writeFileSync(join(directory, 'pnpm'), `#!/bin/sh\nchmod 555 '${directory}'\n`, {
      mode: 0o700,
    });
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'up -d'*) echo $$ > '${directory}/up-pid' 2>/dev/null; exec sleep 60 ;;
  *'down --volumes'*) chmod 755 '${directory}'; touch '${directory}/cleaned' ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root, { TMPDIR: scratch });
    const [code] = await once(child, 'close');
    chmodSync(directory, 0o755);
    assert.equal(code, 1);
    if (existsSync(join(directory, 'up-pid'))) {
      leader = Number(readFileSync(join(directory, 'up-pid'), 'utf8'));
      assert.ok(await waitGone(leader), 'the unrecorded group was stopped');
    }
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.error.message, 'Could not record process group');
    assert.ok(report.reportWriteFailures.length >= 1);
    assert.deepEqual(report.processGroups, []);
    assert.ok(existsSync(join(directory, 'cleaned')));
    assert.equal(report.cleanup.passed, true);
  } finally {
    child?.kill('SIGKILL');
    if (leader) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      chmodSync(directory, 0o755);
    } catch {
      /* removed already */
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a failing container check while volume and network still run: no final report until both settled and their groups are reaped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-parallel-check-'));
  const scratch = mkdtempSync(join(tmpdir(), 'drill-parallel-check-tmp-'));
  const descendants = [];
  let child;
  try {
    const root = fixture(directory);
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // The container check fails at once. The volume and network checks keep running, leave a
    // descendant holding their stdout, and note whether the final report already existed when
    // they finished.
    const slow = (name, seconds, output) =>
      `sleep ${seconds}; sleep 60 & echo $! > '${directory}/${name}-pid'; grep -c finishedAt '${directory}/report.json' > '${directory}/${name}-final-seen'; echo '${output}'`;
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'up -d'*) exit 1 ;;
  *'container ls'*) exit 1 ;;
  *'volume ls'*) ${slow('volume', 1, 'vol-left')} ;;
  *'network ls'*) ${slow('network', 2, '')} ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root, { TMPDIR: scratch });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    for (const name of ['volume', 'network'])
      descendants.push(Number(readFileSync(join(directory, `${name}-pid`), 'utf8')));
    for (const name of ['volume', 'network'])
      assert.equal(
        readFileSync(join(directory, `${name}-final-seen`), 'utf8').trim(),
        '0',
        `${name}: the final report did not exist while the check was still running`,
      );
    const summary = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(summary.cleanup.passed, false);
    assert.deepEqual(summary.cleanup.leftovers, ['volume']);
    assert.deepEqual(summary.cleanup.unverified, ['container']);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.ok(report.finishedAt, 'the final report was written');
    assert.equal(report.passed, false);
    assert.deepEqual(report.cleanup.leftovers, ['volume']);
    assert.deepEqual(report.cleanup.unverified, ['container']);
    const cleanupReaps = report.reapedProcessGroups.filter(
      (entry) => entry.stage === 'cleanup owned containers, networks and volumes',
    );
    assert.equal(
      cleanupReaps.length,
      2,
      'both siblings were reaped and recorded in the final report',
    );
    assert.deepEqual(report.processGroups, []);
    assert.equal(report.orphanProcessGroups, undefined);
    for (const pid of descendants) {
      await pollUntil(() => !pidExists(pid), `process ${pid} to exit`);
      assert.equal(pidExists(pid), false, 'the descendant is gone');
    }
    assert.doesNotMatch(stderr, new RegExp(directory));
    assert.doesNotMatch(JSON.stringify(report.cleanup), /vol-left/);
  } finally {
    child?.kill('SIGKILL');
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a rejected compose down still reaches the final report with a failed cleanup verdict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-down-rejects-'));
  const scratch = mkdtempSync(join(tmpdir(), 'drill-down-rejects-tmp-'));
  let child;
  try {
    const root = fixture(directory);
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
case "$*" in
  *'up -d'*) exit 1 ;;
  *'down --volumes'*) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    child = start(directory, root, { TMPDIR: scratch });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.ok(report.finishedAt);
    assert.equal(report.passed, false);
    assert.equal(report.cleanup.passed, false);
    assert.deepEqual(report.processGroups, []);
  } finally {
    child?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("children get PNPM_HOME (the install's store), the run's recovery id and no other inherited variable", async () => {
  for (const withHome of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-env-pass-'));
    try {
      const root = fixture(directory);
      writeFileSync(
        join(directory, 'pnpm'),
        `#!/bin/sh\nenv | sort > '${directory}/child-env'\nexit 1\n`,
        {
          mode: 0o700,
        },
      );
      writeFileSync(join(directory, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const child = start(directory, root, {
        PNPM_HOME: withHome ? '/synthetic/pnpm-home' : '',
        SYNTHETIC_SECRET_TOKEN: 'inherited-secret',
        DATABASE_URL_ECONOMIC: 'postgresql://real.example/prod',
        CI: 'true',
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 1);
      const lines = readFileSync(join(directory, 'child-env'), 'utf8').split('\n');
      assert.equal(lines.includes('PNPM_HOME=/synthetic/pnpm-home'), withHome);
      assert.ok(!lines.some((line) => line.startsWith('PNPM_HOME=')) || withHome);
      const names = lines.filter(Boolean).map((line) => line.split('=')[0]);
      for (const name of [
        'SYNTHETIC_SECRET_TOKEN',
        'DATABASE_URL_ECONOMIC',
        'CI',
        'RASTA_DRILL_ROOT',
        'TMPDIR',
      ])
        assert.ok(!names.includes(name), name);
      assert.ok(lines.includes('RASTA_ALLOW_DEMO_SEED=true'));
      // The id the report records is the one every child carries (recovery proves groups by it).
      const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.match(report.recoveryId, /^[0-9a-f]{32}$/);
      assert.ok(lines.includes(`RASTA_DRILL_RECOVERY_ID=${report.recoveryId}`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

// --- --cleanup-from ---------------------------------------------------------------------------
function recover(directory, root, reportPath, extra = {}) {
  const child = spawn(process.execPath, [cli.pathname, '--cleanup-from', reportPath], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TMPDIR: directory,
      RASTA_DRILL_ROOT: root,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
}
// A docker stand-in that records what it was asked and lists nothing (or what `ls` is told to).
const recordingDocker = (directory, extra = '') =>
  writeFileSync(
    join(directory, 'docker'),
    `#!/bin/bash
echo "$*" >> '${directory}/docker-calls'
${extra}
`,
    { mode: 0o700 },
  );

/**
 * A genuine record: the CLI is SIGKILLed while its first child (a stand-in `pnpm` that carries
 * the run's environment) is blocked, so the report, directory, marker, compose.json and the
 * recorded process group are exactly what a crashed run leaves.
 */
async function crashedRun(directory, root) {
  writeFileSync(
    join(directory, 'pnpm'),
    `#!/bin/bash
echo $$ > '${directory}/blocked-pgid'
${holdUntil(directory, `${directory}/release`)}
`,
    { mode: 0o700 },
  );
  writeFileSync(join(directory, 'docker'), '#!/bin/sh\ntouch "' + directory + '/early-docker"\n', {
    mode: 0o700,
  });
  const child = start(directory, root);
  const exited = once(child, 'exit');
  const pgid = await waitForPid(join(directory, 'blocked-pgid'));
  const reportPath = join(directory, 'report.json');
  await waitForRecordedGroup(reportPath, pgid, 'processGroups');
  child.kill('SIGKILL');
  await exited;
  rmSync(join(directory, 'early-docker'), { force: true });
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  return { child, pgid, reportPath, report };
}

test('--cleanup-from recovers a crashed run: its process group, its compose project, its directory; the record is not rewritten', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-'));
  let pgid;
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    pgid = run.pgid;
    assert.ok(alive(pgid), 'the blocked child outlived the CLI');
    assert.deepEqual(run.report.processGroups, [pgid]);
    recordingDocker(directory);
    const before = readFileSync(run.reportPath, 'utf8');
    const result = await recover(directory, root, run.reportPath);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitGone(pgid), 'the recorded group was stopped');
    const calls = readFileSync(join(directory, 'docker-calls'), 'utf8').split('\n').filter(Boolean);
    assert.ok(
      calls.some((call) =>
        call.startsWith(
          `compose --project-name ${run.report.project} --file ${run.report.temporary}/compose.json down --volumes`,
        ),
      ),
      calls.join('\n'),
    );
    for (const kind of ['container', 'volume', 'network'])
      assert.ok(
        calls.includes(
          `${kind} ls${kind === 'container' ? ' -a' : ''} --quiet --filter label=com.docker.compose.project=${run.report.project}`,
        ),
        kind,
      );
    assert.equal(existsSync(run.report.temporary), false, 'the directory is removed');
    assert.equal(
      readFileSync(run.reportPath, 'utf8'),
      before,
      'recovery never rewrites the record',
    );
    assert.doesNotMatch(result.stderr, new RegExp(directory));
  } finally {
    if (pgid) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--cleanup-from refuses (exit 2) a record it cannot prove, touching nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-refuse-'));
  const other = mkdtempSync(join(tmpdir(), 'drill-recover-refuse-b-'));
  let pgids = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    pgids.push(run.pgid);
    const otherRoot = fixture(other);
    // A second crashed run, under the same TMPDIR as the first so its directory is a valid shape.
    const second = await crashedRun(other, otherRoot);
    pgids.push(second.pgid);
    recordingDocker(directory);
    const original = readFileSync(run.reportPath, 'utf8');
    const keep = (change) =>
      writeFileSync(run.reportPath, JSON.stringify({ ...run.report, ...change }), { mode: 0o600 });
    const refusals = {
      'no ownership': () => writeFileSync(run.reportPath, '{}', { mode: 0o600 }),
      'unreadable JSON': () => writeFileSync(run.reportPath, '{"project": "res', { mode: 0o600 }),
      'a mixed record: this project, the other run directory': () => {
        // Move the other run's directory under this TMPDIR so only the binding is wrong.
        const moved = join(directory, second.report.temporary.split('/').at(-1));
        cpSync(second.report.temporary, moved, { recursive: true });
        keep({ temporary: moved });
      },
      'another invocation id': () => keep({ recoveryId: 'b'.repeat(32) }),
      'a symlinked compose.json': () => {
        const compose = join(run.report.temporary, 'compose.json');
        const copy = join(directory, 'compose-copy.json');
        writeFileSync(copy, readFileSync(compose), { mode: 0o600 });
        rmSync(compose);
        symlinkSync(copy, compose);
        writeFileSync(run.reportPath, original, { mode: 0o600 });
      },
    };
    const restoreCompose = join(directory, 'compose-restore.json');
    writeFileSync(restoreCompose, readFileSync(join(run.report.temporary, 'compose.json')));
    for (const [name, arrange] of Object.entries(refusals)) {
      arrange();
      const result = await recover(directory, root, run.reportPath);
      assert.equal(result.code, 2, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /recovery refused: /, name);
      assert.doesNotMatch(
        result.stderr,
        new RegExp(`${directory}|restore-drill-[0-9a-f]{16}`),
        name,
      );
      assert.equal(
        existsSync(join(directory, 'docker-calls')),
        false,
        `${name}: docker not called`,
      );
      assert.ok(alive(run.pgid), `${name}: the recorded group was not signalled`);
      assert.ok(existsSync(run.report.temporary), `${name}: the directory is intact`);
      // Put the arranged compose.json back (the symlink case replaced it).
      const compose = join(run.report.temporary, 'compose.json');
      rmSync(compose, { force: true });
      writeFileSync(compose, readFileSync(restoreCompose), { mode: 0o600 });
      writeFileSync(run.reportPath, original, { mode: 0o600 });
    }
    // Missing report: refused as well, not "nothing recorded".
    const missing = await recover(directory, root, join(directory, 'no-such-report.json'));
    assert.equal(missing.code, 2);
    assert.equal(existsSync(join(directory, 'docker-calls')), false);
    // A compose definition other than the drill's: refused before Compose reads it.
    const definition = JSON.parse(readFileSync(restoreCompose, 'utf8'));
    definition.services.source.privileged = true;
    writeFileSync(join(run.report.temporary, 'compose.json'), JSON.stringify(definition), {
      mode: 0o600,
    });
    const altered = await recover(directory, root, run.reportPath);
    assert.equal(altered.code, 2);
    assert.equal(existsSync(join(directory, 'docker-calls')), false);
  } finally {
    for (const pgid of pgids) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('--cleanup-from signals only process groups that carry the run id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-groups-'));
  const strangers = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    // A group of someone else (no id in its environment) listed in the record.
    const stranger = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    strangers.push(stranger);
    await new Promise((resolve) => stranger.once('spawn', resolve));
    writeFileSync(
      run.reportPath,
      JSON.stringify({ ...run.report, processGroups: [run.pgid, stranger.pid] }),
      { mode: 0o600 },
    );
    recordingDocker(directory);
    const result = await recover(directory, root, run.reportPath);
    assert.equal(result.code, 1, 'an unproven group fails the cleanup');
    assert.ok(
      result.stderr.includes(`process group ${stranger.pid} is not proven to be ours`),
      'the unproven group is named by id, and only by id',
    );
    assert.doesNotMatch(result.stderr, new RegExp(`${directory}|restore-drill-[0-9a-f]{16}`));
    assert.ok(alive(stranger.pid), 'the stranger was not signalled');
    assert.ok(await waitGone(run.pgid), 'the group that carries the id was stopped');
    assert.ok(existsSync(run.report.temporary), 'a failed cleanup keeps the directory');
  } finally {
    for (const stranger of strangers) stranger.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--cleanup-from never reports success for a failed teardown or a leftover resource', async () => {
  for (const mode of ['down-fails', 'volume-left', 'check-fails']) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-recover-fails-'));
    let pgid;
    try {
      const root = fixture(directory);
      const run = await crashedRun(directory, root);
      pgid = run.pgid;
      recordingDocker(
        directory,
        {
          'down-fails': 'case "$*" in *"down --volumes"*) exit 1 ;; esac',
          'volume-left': 'case "$*" in *"volume ls"*) echo vol-secret-id ;; esac',
          'check-fails': 'case "$*" in *"network ls"*) exit 1 ;; esac',
        }[mode],
      );
      const result = await recover(directory, root, run.reportPath);
      assert.equal(result.code, 1, mode);
      assert.ok(existsSync(run.report.temporary), `${mode}: the directory is kept for another try`);
      assert.doesNotMatch(result.stderr, /vol-secret-id/, mode);
    } finally {
      if (pgid) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('--cleanup-from settles every resource check before it exits, even when one rejects at once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-settle-'));
  const descendants = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    const slow = (name, seconds) =>
      `sleep ${seconds}; sleep 60 & echo $! > '${directory}/${name}-pid'; touch '${directory}/${name}-done'`;
    recordingDocker(
      directory,
      `case "$*" in
  *'container ls'*) exit 1 ;;
  *'volume ls'*) ${slow('volume', 1)} ;;
  *'network ls'*) ${slow('network', 2)} ;;
esac`,
    );
    const result = await recover(directory, root, run.reportPath);
    for (const name of ['volume', 'network']) {
      assert.ok(existsSync(join(directory, `${name}-done`)), `${name}: finished before the exit`);
      descendants.push(Number(readFileSync(join(directory, `${name}-pid`), 'utf8')));
    }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unverified: container/);
    for (const pid of descendants) {
      await pollUntil(() => !pidExists(pid), `process ${pid} to exit`);
      assert.equal(pidExists(pid), false, 'the siblings were reaped before the exit');
    }
  } finally {
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the normal teardown uses the same compose gate: a definition swapped during the run is never handed to `compose down`', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-teardown-gate-'));
  try {
    const root = fixture(directory);
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // `up` replaces the project's compose.json with a privileged service, then fails.
    recordingDocker(
      directory,
      `case "$*" in
  *'up -d'*)
    file=$(echo "$*" | sed -n 's/.*--file \\([^ ]*\\) .*/\\1/p')
    printf '%s' '{"services":{"source":{"privileged":true,"container_name":"host"}},"volumes":{}}' > "$file"
    exit 1 ;;
esac`,
    );
    const child = start(directory, root);
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    const calls = readFileSync(join(directory, 'docker-calls'), 'utf8');
    assert.doesNotMatch(calls, /down --volumes/, 'compose down never ran on the swapped file');
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.cleanup.passed, false, 'a refused teardown is a failed cleanup');
    assert.equal(report.passed, false);
    assert.ok(existsSync(report.temporary), 'the directory is kept for recovery');
    // ... and recovery refuses the same definition (exit 2) rather than trusting the report.
    rmSync(join(directory, 'docker-calls'));
    const result = await recover(directory, root, join(directory, 'report.json'));
    assert.equal(result.code, 2);
    assert.equal(existsSync(join(directory, 'docker-calls')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- recovery is itself recoverable (#478 r3 R1) ---------------------------------------------
const faultEnv = (spec) => ({
  NODE_OPTIONS: `--import=${new URL('./backup-restore-drill-fault.mjs', import.meta.url).href}`,
  DRILL_FAULT: JSON.stringify(spec),
});
// Next to the report: outside the directory recovery removes.
const recoveryJournal = (run) => `${run.reportPath}.recovery-journal.json`;
function startRecovery(directory, root, reportPath) {
  return spawn(process.execPath, [cli.pathname, '--cleanup-from', reportPath], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TMPDIR: directory,
      RASTA_DRILL_ROOT: root,
    },
    stdio: 'ignore',
  });
}
/** A docker stand-in whose FIRST `compose down` blocks (recording its group and environment). */
const blockingFirstDown = (directory) =>
  recordingDocker(
    directory,
    `case "$*" in
  *'down --volumes'*)
    if mkdir '${directory}/first-down' 2>/dev/null; then
      env | grep '^RASTA_DRILL_RECOVERY_ID=' > '${directory}/down-env'
      echo $$ > '${directory}/down-pgid'
      ${holdUntil(directory, `${directory}/release-down`)}
    fi ;;
esac`,
  );
const kill = (pgid) => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* gone */
  }
};

test('a recovery killed mid-command is itself recovered: the next one reaps its blocked child and never reports success while it lives', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-twice-'));
  const stray = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    stray.push(run.pgid);
    blockingFirstDown(directory);
    const first = startRecovery(directory, root, run.reportPath);
    const killed = once(first, 'exit');
    const downGroup = await waitForPid(join(directory, 'down-pgid'));
    stray.push(downGroup);
    // Ownership is on disk while the child runs: the journal names its group, the child carries
    // the run's id, and the original record is untouched. The journal is written after the spawn,
    // so wait for it to name the group instead of racing the recovery.
    await waitForRecordedGroup(recoveryJournal(run), downGroup, 'groups');
    const journal = JSON.parse(readFileSync(recoveryJournal(run), 'utf8'));
    assert.ok(journal.groups.includes(downGroup), 'the journal names the recovery child');
    assert.equal(journal.id, run.report.recoveryId);
    assert.equal(journal.checkpoint, undefined);
    assert.equal(
      readFileSync(join(directory, 'down-env'), 'utf8').trim(),
      `RASTA_DRILL_RECOVERY_ID=${run.report.recoveryId}`,
    );
    const before = readFileSync(run.reportPath, 'utf8');
    first.kill('SIGKILL');
    await killed;
    assert.ok(alive(downGroup), 'the first recovery left its blocked child running');
    const second = await recover(directory, root, run.reportPath);
    const stillAlive = alive(downGroup);
    assert.ok(
      !(second.code === 0 && stillAlive),
      'the second recovery reported success while the first one’s child lives',
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stillAlive, false, 'the first recovery’s group was reaped before the exit');
    assert.equal(existsSync(run.report.temporary), false);
    assert.equal(
      readFileSync(run.reportPath, 'utf8'),
      before,
      'the original record stays immutable',
    );
    assert.doesNotMatch(second.stderr, new RegExp(directory));
  } finally {
    stray.forEach(kill);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a recovery that cannot prove its predecessor’s group fails and keeps the directory; the journal keeps the group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-journal-unknown-'));
  const stray = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    stray.push(run.pgid);
    // A journal naming a live group that does not carry the run's id (it is not provably ours).
    const stranger = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => stranger.once('spawn', resolve));
    stray.push(stranger.pid);
    writeFileSync(
      recoveryJournal(run),
      JSON.stringify({
        version: 1,
        id: run.report.recoveryId,
        project: run.report.project,
        directory: run.report.temporary.split('/').at(-1),
        groups: [stranger.pid],
      }),
      { mode: 0o600 },
    );
    recordingDocker(directory);
    const result = await recover(directory, root, run.reportPath);
    assert.equal(result.code, 1, result.stderr);
    assert.ok(alive(stranger.pid), 'the unproven group was not signalled');
    assert.ok(
      result.stderr.includes(`process group ${stranger.pid} is not proven to be ours`),
      result.stderr,
    );
    assert.doesNotMatch(result.stderr, new RegExp(`${directory}|restore-drill-[0-9a-f]{16}`));
    assert.ok(existsSync(run.report.temporary), 'the directory is kept');
    const journal = JSON.parse(readFileSync(recoveryJournal(run), 'utf8'));
    assert.ok(journal.groups.includes(stranger.pid), 'the unsettled group stays owned');
    assert.equal(journal.checkpoint, undefined, 'no recovered checkpoint');
  } finally {
    stray.forEach(kill);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the directory is removed only after the recovered checkpoint is on disk; a removal cut short is finished without Docker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-checkpoint-'));
  const stray = [];
  let locked;
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    stray.push(run.pgid);
    recordingDocker(directory);
    // A subdirectory nobody may enter makes the removal fail after everything else is deleted.
    locked = join(run.report.temporary, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'f'), 'x');
    chmodSync(locked, 0o500);
    const first = await recover(directory, root, run.reportPath);
    assert.equal(first.code, 1, 'a directory that cannot be removed is not a success');
    const journal = JSON.parse(readFileSync(recoveryJournal(run), 'utf8'));
    assert.equal(journal.checkpoint, 'recovered', 'the checkpoint preceded the removal');
    assert.deepEqual(journal.groups, []);
    // The removal may have taken the marker with it; the checkpoint stands on its own.
    chmodSync(locked, 0o700);
    rmSync(join(directory, 'docker-calls'));
    const again = await recover(directory, root, run.reportPath);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(existsSync(run.report.temporary), false);
    assert.equal(existsSync(join(directory, 'docker-calls')), false, 'nothing left to ask Docker');
  } finally {
    if (locked && existsSync(locked)) chmodSync(locked, 0o700);
    stray.forEach(kill);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a journal that cannot be written at all is never a success, and nothing is removed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-journal-write-'));
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    recordingDocker(directory);
    const result = await recover(
      directory,
      root,
      run.reportPath,
      faultEnv({ rename: { match: 'recovery-journal', times: 1000 } }),
    );
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /a journal write failed/);
    assert.match(result.stderr, /success is not reported/);
    assert.ok(existsSync(run.report.temporary), 'the directory is kept');
    // Nothing was published: all the journal holds is the run's own reservation.
    assert.deepEqual(JSON.parse(readFileSync(recoveryJournal(run), 'utf8')), {
      version: 1,
      id: run.report.recoveryId,
      reservation: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- one owner at a time, publication that cannot fail silently, a checkpoint that outlives the
// --- tree (#478 r4 F1/F2) ----------------------------------------------------------------------
const SHORT_LOCK_WAIT = { RASTA_DRILL_LOCK_WAIT_MS: '1500' };
function spawnRecovery(directory, root, reportPath, extra = {}) {
  const child = spawn(process.execPath, [cli.pathname, '--cleanup-from', reportPath], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TMPDIR: directory,
      RASTA_DRILL_ROOT: root,
      ...SHORT_LOCK_WAIT,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, done: once(child, 'close').then(([code]) => ({ code, stdout, stderr })) };
}
const released = (directory, name) => writeFileSync(join(directory, name), '');
const calls = (directory) =>
  existsSync(join(directory, 'docker-calls'))
    ? readFileSync(join(directory, 'docker-calls'), 'utf8')
    : '';

for (const order of ['the second starts once the first one’s child runs', 'both start together']) {
  test(`two recoveries of one report: neither reports success while the other’s child lives (${order})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-recover-overlap-'));
    const stray = [];
    try {
      const root = fixture(directory);
      const run = await crashedRun(directory, root);
      stray.push(run.pgid);
      blockingFirstDown(directory);
      const processes = [spawnRecovery(directory, root, run.reportPath)];
      if (order === 'both start together')
        processes.push(spawnRecovery(directory, root, run.reportPath));
      const downGroup = await waitForPid(join(directory, 'down-pgid'));
      stray.push(downGroup);
      if (order !== 'both start together')
        processes.push(spawnRecovery(directory, root, run.reportPath));
      // Whoever does not own the blocked child ends first, and not with 0.
      const first = await Promise.race(processes.map((p) => p.done.then((r) => ({ p, r }))));
      assert.ok(alive(downGroup), 'the other recovery’s child is still running');
      assert.notEqual(
        first.r.code,
        0,
        `an overlapping recovery reported success: ${first.r.stderr}`,
      );
      assert.doesNotMatch(first.r.stderr, new RegExp(`${directory}|restore-drill-[0-9a-f]{16}`));
      released(directory, 'release-down');
      const owner = await processes.find((p) => p !== first.p).done;
      assert.equal(owner.code, 0, owner.stderr);
      assert.equal(alive(downGroup), false);
      assert.equal(existsSync(run.report.temporary), false);
      assert.equal(JSON.parse(readFileSync(recoveryJournal(run), 'utf8')).checkpoint, 'removed');
      // Once finished, a repeat (the caller never saw the 0) is a success too.
      const again = await recover(directory, root, run.reportPath);
      assert.equal(again.code, 0, again.stderr);
    } finally {
      stray.forEach(kill);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a recovery never signals or removes what a LIVE run still owns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-live-run-'));
  let child;
  let pgid;
  try {
    const root = fixture(directory);
    writeFileSync(
      join(directory, 'pnpm'),
      `#!/bin/bash\necho $$ > '${directory}/blocked-pgid'\n${holdUntil(directory, `${directory}/release`)}\n`,
      { mode: 0o700 },
    );
    recordingDocker(directory);
    child = start(directory, root);
    pgid = await waitForPid(join(directory, 'blocked-pgid'));
    const reportPath = join(directory, 'report.json');
    await waitForRecordedGroup(reportPath, pgid, 'processGroups');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const result = await recover(directory, root, reportPath, SHORT_LOCK_WAIT);
    assert.notEqual(result.code, 0, result.stderr);
    assert.ok(alive(pgid), 'the live run’s child was not signalled');
    assert.ok(existsSync(report.temporary), 'the live run’s directory was not removed');
    assert.equal(calls(directory), '', 'Docker was not asked anything');
    assert.doesNotMatch(result.stderr, new RegExp(`${directory}|restore-drill-[0-9a-f]{16}`));
  } finally {
    child?.kill('SIGKILL');
    if (pgid) kill(pgid);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a recovery of a drill whose directory is already gone is journaled too: killed during a listing, the next one reaps it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-absent-'));
  const stray = [];
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    kill(run.pgid);
    // What an ordinary successful drill leaves: its directory is gone and its record says so.
    rmSync(run.report.temporary, { recursive: true, force: true });
    writeFileSync(
      run.reportPath,
      JSON.stringify({ ...run.report, processGroups: [], cleanup: { passed: true } }),
    );
    recordingDocker(
      directory,
      `case "$*" in
  *'container ls'*)
    if mkdir '${directory}/first-ls' 2>/dev/null; then
      echo $$ > '${directory}/ls-pgid'
      ${holdUntil(directory, `${directory}/release-ls`)}
    fi ;;
esac`,
    );
    const first = spawnRecovery(directory, root, run.reportPath);
    const listing = await waitForPid(join(directory, 'ls-pgid'));
    stray.push(listing);
    // Kill the first recovery only once its journal names the listing: killed earlier, there is
    // nothing for the second one to find and the test would prove nothing.
    await waitForRecordedGroup(recoveryJournal(run), listing, 'groups');
    first.child.kill('SIGKILL');
    await first.done;
    assert.ok(alive(listing), 'the killed recovery left its listing running');
    const second = await recover(directory, root, run.reportPath);
    assert.ok(
      !(second.code === 0 && alive(listing)),
      'the second recovery reported success while the first one’s listing lives',
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(alive(listing), false, 'the listing was reaped before the exit');
  } finally {
    stray.forEach(kill);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one failed journal write is never forgotten: later writes succeed, the recovery still does not report success, and a retry does', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-transient-'));
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    recordingDocker(directory);
    const failed = await recover(
      directory,
      root,
      run.reportPath,
      faultEnv({ rename: { match: 'recovery-journal', times: 1 } }),
    );
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /a journal write failed/);
    assert.ok(existsSync(run.report.temporary), 'the directory is kept for the retry');
    const retry = await recover(directory, root, run.reportPath);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(existsSync(run.report.temporary), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a journal write whose directory fsync fails is not a durable checkpoint: nothing is removed, the exit is not 0', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-recover-fsync-'));
  try {
    const root = fixture(directory);
    const run = await crashedRun(directory, root);
    recordingDocker(directory);
    const failed = await recover(
      directory,
      root,
      run.reportPath,
      faultEnv({ fsyncDirectory: { times: 1000 } }),
    );
    assert.equal(failed.code, 1, failed.stderr);
    assert.ok(existsSync(run.report.temporary), 'no durable checkpoint, so no removal');
    const retry = await recover(directory, root, run.reportPath);
    assert.equal(retry.code, 0, retry.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A crashed run whose recovery has everything gone (Docker lists nothing). */
async function recoverable(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const root = fixture(directory);
  const run = await crashedRun(directory, root);
  recordingDocker(directory);
  return { directory, root, run };
}

test('a removal interrupted at any step is finished or refused correctly by the next recovery', async () => {
  const steps = {
    'checkpoint written, nothing removed': async ({ directory, root, run }) => {
      const first = await recover(
        directory,
        root,
        run.reportPath,
        faultEnv({ rm: { mode: 'before' } }),
      );
      assert.equal(first.code, 1, first.stderr);
      assert.ok(existsSync(run.report.temporary));
    },
    'the marker, compose.json and everything else already deleted but the directory': async ({
      directory,
      root,
      run,
    }) => {
      const first = await recover(
        directory,
        root,
        run.reportPath,
        faultEnv({ rm: { mode: 'before' } }),
      );
      assert.equal(first.code, 1, first.stderr);
      for (const name of readdirSync(run.report.temporary))
        rmSync(join(run.report.temporary, name), { recursive: true, force: true });
    },
    'the directory gone, the exit lost': async ({ directory, root, run }) => {
      const first = await recover(
        directory,
        root,
        run.reportPath,
        faultEnv({ rm: { mode: 'after' } }),
      );
      assert.equal(first.code, 1, first.stderr);
      assert.equal(existsSync(run.report.temporary), false);
    },
    'the directory gone, the write that follows lost': async ({ directory, root, run }) => {
      const first = await recover(
        directory,
        root,
        run.reportPath,
        faultEnv({
          rm: { mode: 'after', times: 0 },
          rename: { match: 'recovery-journal', afterRm: true, times: 1 },
        }),
      );
      assert.equal(first.code, 1, first.stderr);
      assert.equal(existsSync(run.report.temporary), false);
    },
    'a complete success whose exit never reached the caller': async ({ directory, root, run }) => {
      const first = await recover(directory, root, run.reportPath);
      assert.equal(first.code, 0, first.stderr);
    },
  };
  for (const [name, interrupt] of Object.entries(steps)) {
    const context = await recoverable('drill-recover-steps-');
    try {
      await interrupt(context);
      rmSync(join(context.directory, 'docker-calls'), { force: true });
      const retry = await recover(context.directory, context.root, context.run.reportPath);
      assert.equal(retry.code, 0, `${name}: ${retry.stderr}`);
      assert.equal(existsSync(context.run.report.temporary), false, name);
      assert.equal(calls(context.directory), '', `${name}: nothing left to ask Docker`);
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  }
});

// --- one deletion boundary for a run's own teardown, recovery and resumption (#478 r5 F2) ---------
/**
 * An ordinary run that fails early (the stand-in `docker compose up` exits 1) and so reaches its
 * own teardown and the removal of its directory. Resolves when the process is gone.
 */
async function ordinaryRun(directory, root, extra = {}) {
  writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(
    join(directory, 'docker'),
    `#!/bin/sh
case "$*" in
  *'up -d'*) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  const child = start(directory, root, extra);
  const [code, signal] = await once(child, 'close');
  const reportPath = join(directory, 'report.json');
  return { code, signal, reportPath, report: JSON.parse(readFileSync(reportPath, 'utf8')) };
}
const journalOf = (reportPath) =>
  JSON.parse(readFileSync(`${reportPath}.recovery-journal.json`, 'utf8'));

test('a run killed during its own directory removal, or before its report is replaced, is finished cleanly by the next recovery', async () => {
  for (const mode of ['kill-before', 'kill-mid', 'kill-after']) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-ordinary-kill-'));
    try {
      const root = fixture(directory);
      const run = await ordinaryRun(directory, root, faultEnv({ rm: { mode } }));
      assert.equal(run.signal, 'SIGKILL', mode);
      // The provisional report is all the killed run left; the checkpoint is outside the tree.
      assert.equal(run.report.cleanup.passed, false, mode);
      assert.equal(journalOf(run.reportPath).checkpoint, 'recovered', mode);
      assert.equal(existsSync(run.report.temporary), mode !== 'kill-after', mode);
      recordingDocker(directory);
      const retry = await recover(directory, root, run.reportPath);
      assert.equal(retry.code, 0, `${mode}: ${retry.stderr}`);
      assert.doesNotMatch(retry.stderr, /marker is missing|does not say cleanup finished/, mode);
      assert.equal(existsSync(run.report.temporary), false, mode);
      assert.equal(journalOf(run.reportPath).checkpoint, 'removed', mode);
      assert.equal(calls(directory), '', `${mode}: nothing left to ask Docker`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a normal run removes its directory only once the checkpoint is durable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-ordinary-durable-'));
  try {
    const root = fixture(directory);
    const run = await ordinaryRun(directory, root, faultEnv({ fsyncDirectory: { times: 1000 } }));
    assert.equal(run.code, 1);
    assert.equal(
      run.report.cleanup.passed,
      false,
      'no durable checkpoint, so cleanup did not finish',
    );
    assert.equal(existsSync(run.report.temporary), true, 'and the directory was not removed');
    recordingDocker(directory);
    const retry = await recover(directory, root, run.reportPath);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(existsSync(run.report.temporary), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a checkpoint read back from disk is made durable again before it licenses a removal', async () => {
  const context = await recoverable('drill-recover-reload-');
  try {
    // The "recovered" write renames, then its directory fsync fails: readable, not confirmed.
    const fault = faultEnv({ fsyncDirectory: { afterCheckpoint: true, times: 1000 } });
    const first = await recover(context.directory, context.root, context.run.reportPath, fault);
    assert.equal(first.code, 1, first.stderr);
    assert.equal(journalOf(context.run.reportPath).checkpoint, 'recovered');
    assert.equal(existsSync(context.run.report.temporary), true);
    rmSync(join(context.directory, 'docker-calls'), { force: true });
    // Retried with the fault still there: the loaded checkpoint proves nothing, so nothing goes.
    const again = await recover(context.directory, context.root, context.run.reportPath, fault);
    assert.equal(again.code, 1, again.stderr);
    assert.equal(existsSync(context.run.report.temporary), true, 'the directory is kept');
    // The fault gone: it completes, without asking Docker anything.
    const retry = await recover(context.directory, context.root, context.run.reportPath);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(existsSync(context.run.report.temporary), false);
    assert.equal(journalOf(context.run.reportPath).checkpoint, 'removed');
    assert.equal(calls(context.directory), '');
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test('without any checkpoint a vanished directory is still refused, touching nothing', async () => {
  const context = await recoverable('drill-recover-no-evidence-');
  try {
    kill(context.run.pgid);
    rmSync(context.run.report.temporary, { recursive: true, force: true });
    const result = await recover(context.directory, context.root, context.run.reportPath);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(calls(context.directory), '');
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test('a lock whose owner cannot be proven gone is refused with one fixed line, touching nothing', async () => {
  const context = await recoverable('drill-recover-lock-unknown-');
  try {
    // A claim from another pid namespace: its pid means nothing here, so it is neither alive nor gone.
    writeFileSync(
      `${context.run.reportPath}.lock.0123456789abcdef`,
      JSON.stringify({ version: 1, pid: 4242, start: null, boot: null, ns: 'pid:[1]' }),
      { mode: 0o600 },
    );
    const result = await recover(context.directory, context.root, context.run.reportPath);
    assert.equal(result.code, 2);
    assert.equal(
      result.stderr,
      '[backup-restore-drill] a lock left next to the report cannot be proven stale; nothing was done\n',
    );
    assert.equal(calls(context.directory), '');
    assert.ok(existsSync(context.run.report.temporary));
    // The same refusal for a normal run on that report path.
    const run = await new Promise((resolve) => {
      const child = start(context.directory, context.root);
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /cannot be proven stale; nothing was done/);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

// --- the guarded entry (#478 r3 R4) ----------------------------------------------------------
// A copy of the CLI's own files in a directory with no node_modules above it: `yaml` and the
// shared URL reader cannot be resolved there, as in a checkout without `pnpm install`.
function bareCopy(directory, omit = []) {
  const scripts = join(directory, 'bare', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of [
    'backup-restore-drill.mjs',
    'backup-restore-drill-main.mjs',
    'backup-restore-drill-lib.mjs',
    'backup-restore-drill-recovery.mjs',
  ])
    if (!omit.includes(name)) cpSync(join(repo, 'scripts', name), join(scripts, name));
  return join(scripts, 'backup-restore-drill.mjs');
}
const runEntry = (entry, args, directory) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { PATH: process.env.PATH, TMPDIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
const FIXED_LOAD_FAILURE =
  '[backup-restore-drill] the command could not run to completion (a module failed to load or an internal error occurred); details are not printed\n';

test('--cleanup-from needs nothing a normal run needs: without yaml or the URL reader it still reaches its own refusal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-bare-'));
  try {
    const entry = bareCopy(directory);
    const result = await runEntry(
      entry,
      ['--cleanup-from', join(directory, 'nothing.json')],
      directory,
    );
    assert.equal(result.code, 2);
    assert.equal(result.stderr, '[backup-restore-drill] recovery refused: the report is missing\n');
    assert.equal(result.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a module that cannot be loaded ends in one fixed line: no stack, no path, no module name', async () => {
  for (const [omit, args] of [
    ['backup-restore-drill-lib.mjs', ['--cleanup-from', 'x.json']],
    ['backup-restore-drill-recovery.mjs', ['--cleanup-from', 'x.json']],
    ['backup-restore-drill-main.mjs', ['--cleanup-from', 'x.json']],
    ['backup-restore-drill-lib.mjs', ['--report', 'x.json']],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-bare-missing-'));
    try {
      const entry = bareCopy(directory, [omit]);
      const result = await runEntry(entry, args, directory);
      assert.equal(result.code, 1, omit);
      assert.equal(result.stderr, FIXED_LOAD_FAILURE, omit);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // A dependency of a normal run that is missing there is a failed RUN with a private report.
  const directory = mkdtempSync(join(tmpdir(), 'drill-bare-run-'));
  try {
    const entry = bareCopy(directory);
    const report = join(directory, 'report.json');
    const result = await runEntry(entry, ['--report', report], directory);
    assert.equal(result.code, 1);
    assert.doesNotMatch(
      result.stderr + result.stdout,
      /ERR_MODULE_NOT_FOUND|node:internal|yaml|\bat /,
    );
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).passed, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- the report's whole artifact namespace is reserved before anything is allocated (#478 r6 F4) ---
const JOURNAL_REFUSED =
  '[backup-restore-drill] a recovery journal already exists next to the report path (an earlier run left it, or another report claims the name); remove or archive it together with its report, then start again; nothing was done\n';
const NAME_REFUSED =
  '[backup-restore-drill] the --report path ends in a name this drill derives from a report path (.recovery-journal.json, .lock.<hex>, .<hex>.tmp); nothing was done\n';
/** One invocation (`--report` or `--cleanup-from`) run to its end, output captured. */
function invoke(directory, root, flag, reportPath, extra = {}) {
  const child = spawn(process.execPath, [cli.pathname, flag, reportPath], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TMPDIR: directory,
      RASTA_DRILL_ROOT: root,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, done: once(child, 'close').then(([code]) => ({ code, stdout, stderr })) };
}
/** Nothing the refused invocation did is left: no directory, no Docker call, no lock claim. */
function assertUntouched(directory, before) {
  assert.deepEqual(readdirSync(directory).sort(), before);
  assert.equal(calls(directory), '');
  assert.equal(existsSync(join(directory, 'pnpm-called')), false);
}
const stubs = (directory) => {
  recordingDocker(directory);
  writeFileSync(join(directory, 'pnpm'), `#!/bin/sh\ntouch '${directory}/pnpm-called'\n`, {
    mode: 0o700,
  });
};

test('a journal left by a finished run refuses the next run on that report path, touching nothing; cleared together with its report the path is free', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-reuse-'));
  try {
    const root = fixture(directory);
    const a = await ordinaryRun(directory, root);
    assert.equal(journalOf(a.reportPath).checkpoint, 'removed');
    // The operator archives A's report only and starts B on the same path.
    rmSync(a.reportPath);
    const journal = `${a.reportPath}.recovery-journal.json`;
    const bytes = readFileSync(journal);
    stubs(directory);
    rmSync(join(directory, 'docker-calls'), { force: true });
    const before = readdirSync(directory).sort();
    const b = await invoke(directory, root, '--report', a.reportPath).done;
    assert.equal(b.code, 2, b.stderr);
    assert.equal(b.stderr, JOURNAL_REFUSED);
    assert.doesNotMatch(b.stderr, new RegExp(directory));
    assertUntouched(directory, before);
    assert.deepEqual(readFileSync(journal), bytes, 'A’s journal is exactly as it was');
    assert.equal(existsSync(a.reportPath), false, 'no report was created');
    // Archived together with its report, the path is free, and a run killed after it allocated
    // is recovered by ITS OWN journal (the original failure: recovery read A's and refused).
    rmSync(journal);
    const run = await crashedRun(directory, root);
    recordingDocker(directory);
    const recovery = await recover(directory, root, run.reportPath);
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.doesNotMatch(recovery.stderr, /does not match the directory/);
    assert.equal(existsSync(run.report.temporary), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('overlapping names, a live run first: a report named like its journal, lock claim or write sibling is refused and the run’s files stand', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-overlap-live-'));
  let live;
  try {
    const root = fixture(directory);
    writeFileSync(
      join(directory, 'pnpm'),
      `#!/bin/bash
echo $$ > '${directory}/blocked-pgid'
${holdUntil(directory, `${directory}/release`)}
`,
      { mode: 0o700 },
    );
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\ncase "$*" in *"up -d"*) exit 1;; esac\n', {
      mode: 0o700,
    });
    const reportPath = join(directory, 'report.json');
    live = invoke(directory, root, '--report', reportPath);
    // The run records its child's group right after the spawn and then writes nothing until the
    // child ends: snapshot the directory only once that record (and so its write sibling's
    // rename) is on disk, not on the child's own marker.
    await waitForRecordedGroup(
      reportPath,
      await waitForPid(join(directory, 'blocked-pgid')),
      'processGroups',
    );
    const journal = `${reportPath}.recovery-journal.json`;
    const reserved = readFileSync(journal);
    const reportBytes = readFileSync(reportPath);
    const before = readdirSync(directory).sort();
    for (const name of [
      `${reportPath}.recovery-journal.json`,
      `${reportPath}.lock.0123456789abcdef`,
      `${reportPath}.0123456789abcdef.tmp`,
      `${journal}.recovery-journal.json`,
    ])
      for (const flag of ['--report', '--cleanup-from']) {
        const result = await invoke(directory, root, flag, name).done;
        assert.equal(result.code, 2, `${flag} ${name}: ${result.stderr}`);
        assert.equal(result.stderr, NAME_REFUSED);
        assert.deepEqual(readdirSync(directory).sort(), before, 'not one file was created');
      }
    assert.deepEqual(readFileSync(journal), reserved, 'the live run’s journal is untouched');
    assert.deepEqual(readFileSync(reportPath), reportBytes);
    // The live run finishes: its teardown journal is ITS OWN, not overwritten into anything else.
    writeFileSync(join(directory, 'release'), '');
    const done = await live.done;
    assert.equal(done.code, 1, done.stderr);
    const final = journalOf(reportPath);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(final.id, report.recoveryId);
    assert.equal(final.project, report.project);
    assert.equal(final.checkpoint, 'removed');
    assert.equal(report.cleanup.passed, true);
  } finally {
    writeFileSync(join(directory, 'release'), '');
    // The stub polls for `release` inside the directory: let the live run end before the directory
    // is removed, or a failed assertion above strands the run and the test process never exits.
    await live?.done;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('overlapping names, the journal’s name taken first: the run is refused and what holds the name is not touched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-overlap-first-'));
  try {
    const root = fixture(directory);
    stubs(directory);
    const reportPath = join(directory, 'report.json');
    const journal = `${reportPath}.recovery-journal.json`;
    // What an earlier B (report named `<R>.recovery-journal.json`) would hold there, or any file.
    for (const text of ['{"project":"restore-drill-0123456789abcdef"}', '', 'operator notes']) {
      writeFileSync(journal, text, { mode: 0o600 });
      const before = readdirSync(directory).sort();
      const result = await invoke(directory, root, '--report', reportPath).done;
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stderr, JOURNAL_REFUSED);
      assertUntouched(directory, before);
      assert.equal(readFileSync(journal, 'utf8'), text);
      rmSync(journal);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
