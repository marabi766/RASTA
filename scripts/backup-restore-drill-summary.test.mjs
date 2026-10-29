import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SUMMARY_GATES,
  allowedStage,
  drillPassed,
  lastAllowedStage,
  renderDrillSummary,
  summarizeDrillReport,
} from './backup-restore-drill-lib.mjs';

const summaryCli = new URL('./backup-restore-drill-summary.mjs', import.meta.url).pathname;
const drillCli = new URL('./backup-restore-drill.mjs', import.meta.url).pathname;

// Strings a public log must never carry: table names, amounts, paths, URLs, SQL, project names.
const SENTINELS = [
  'SENTINEL_TABLE_public.secret_ledger',
  'SENTINEL_AMOUNT_7777777',
  'SENTINEL_URL postgresql://user:SENTINEL_PASSWORD@127.0.0.1:5432/x',
  'SENTINEL_SQL SELECT * FROM wallet',
  '/tmp/SENTINEL_PATH/report.json',
  'SENTINEL_CURRENCY_XYZ',
];

function ledger(overrides = {}) {
  return {
    journalsChecked: '2',
    entriesChecked: '4',
    walletsChecked: '1',
    journalMismatches: '0',
    walletMismatches: '0',
    amountsByCurrency: [
      { currency: 'IRR', total: '18014398509487486' },
      { currency: 'SENTINEL_CURRENCY_XYZ', total: '7777777' },
    ],
    fixtureAmount: '9007199254740993',
    ...overrides,
  };
}

function database(name) {
  return {
    database: name,
    before: {
      tables: { 'SENTINEL_TABLE_public.secret_ledger': { rows: '3', kind: 'application' } },
      summary: { application: { rows: '16' }, migration: { rows: '11' } },
      schemaDump: { milliseconds: 40, sha256: 'SENTINEL_SHA' },
      reference: { milliseconds: 90, checkConstraints: ['SENTINEL_SQL SELECT * FROM wallet'] },
    },
    after: { schemaDump: { milliseconds: 60 } },
    referenceChecked: true,
    fixedPointEqual: true,
    allowanceChecked: true,
    schemaDumpEqual: true,
    tablesEqual: true,
    migrationsEqual: true,
    databaseStateEqual: true,
    objectStateEqual: true,
  };
}

function passingReport() {
  return {
    version: 5,
    project: 'restore-drill-0123456789abcdef',
    temporary: '/tmp/SENTINEL_PATH/report.json',
    startedAt: '2026-11-01T03:17:00.000Z',
    finishedAt: '2026-11-01T03:29:30.000Z',
    passed: true,
    interrupted: false,
    schemaServices: ['economic', 'identity'],
    databases: [database('rasta_economic'), database('rasta_identity')],
    sourceLedger: ledger(),
    restoredLedger: ledger(),
    cleanup: { passed: true },
  };
}

const summarize = (report, options = { exitCode: 0 }) => summarizeDrillReport(report, options);
const failedGates = (summary) => SUMMARY_GATES.filter((name) => summary.gates[name] !== true);
const everyDatabase = (flag, value) => (report) => {
  for (const db of report.databases) db[flag] = value;
};
const oneDatabase = (flag, value) => (report) => {
  report.databases[1][flag] = value;
};

test('a passing report passes every gate and reports counts and durations only', () => {
  const summary = summarize(passingReport());
  assert.equal(summary.passed, true);
  assert.deepEqual(failedGates(summary), []);
  assert.deepEqual(summary.counts, {
    databases: 2,
    expectedDatabases: 2,
    tables: '2',
    applicationRows: '32',
    migrationRows: '22',
    journals: '2',
    entries: '4',
    wallets: '1',
    journalMismatches: '0',
    walletMismatches: '0',
  });
  assert.equal(summary.durations.totalSeconds, 750);
  assert.equal(summary.durations.schemaDumpMilliseconds, '200');
  assert.equal(summary.durations.referenceAndFixedPointMilliseconds, '180');
  assert.match(renderDrillSummary(summary), /^## Monthly backup\/restore drill: PASSED/);
});

test('every gate has a mutation that turns exactly it red, and the verdict with it', () => {
  const cases = [
    ['database-coverage', (r) => r.schemaServices.push('third')],
    ['rows-and-digests', oneDatabase('tablesEqual', false)],
    ['migrations', oneDatabase('migrationsEqual', false)],
    ['database-and-object-state', oneDatabase('databaseStateEqual', false)],
    ['database-and-object-state', oneDatabase('objectStateEqual', false)],
    ['schema-dump', oneDatabase('schemaDumpEqual', false)],
    ['reference-allowance', oneDatabase('referenceChecked', false)],
    ['reference-allowance', oneDatabase('allowanceChecked', undefined)],
    ['fixed-point', oneDatabase('fixedPointEqual', false)],
    // Restored per-currency total differs from the source's: equality fails, balance still holds.
    ['ledger-equality', (r) => (r.restoredLedger.amountsByCurrency[0].total = '1')],
    // A restored wallet no longer matching its postings or holds.
    ['wallet-escrow-and-holds', (r) => (r.restoredLedger.walletMismatches = '1')],
    ['wallet-escrow-and-holds', (r) => (r.restoredLedger.journalMismatches = '1')],
    ['wallet-escrow-and-holds', (r) => (r.restoredLedger.walletsChecked = '0')],
    ['cleanup', (r) => (r.cleanup.passed = false)],
  ];
  for (const [gate, mutate] of cases) {
    const report = passingReport();
    mutate(report);
    const summary = summarize(report);
    assert.equal(summary.gates[gate], false, `${gate} stays green`);
    assert.equal(summary.gates.acceptance, false, `${gate}: verdict stays green`);
    assert.equal(summary.passed, false);
  }
  // The fixture amount above Number.MAX_SAFE_INTEGER, restored as something else.
  for (const side of ['sourceLedger', 'restoredLedger']) {
    const report = passingReport();
    report[side].fixtureAmount = '9007199254740992';
    const summary = summarize(report);
    assert.equal(summary.gates['beyond-safe-integer-amount'], false, side);
    assert.equal(summary.passed, false);
  }
});

test('the per-gate split is the CLI predicate: all gates but cleanup green <=> drillPassed', () => {
  const flags = [
    'tablesEqual',
    'migrationsEqual',
    'databaseStateEqual',
    'objectStateEqual',
    'schemaDumpEqual',
    'referenceChecked',
    'allowanceChecked',
    'fixedPointEqual',
  ];
  const variants = [(r) => r];
  for (const flag of flags) variants.push((r) => (r.databases[1][flag] = false));
  variants.push(
    (r) => r.databases.pop(),
    (r) => r.schemaServices.push('third'),
    (r) => (r.schemaServices.length = 0),
    (r) => (r.restoredLedger.amountsByCurrency[0].total = '1'),
    (r) => (r.restoredLedger.walletMismatches = '1'),
    (r) => (r.sourceLedger.journalMismatches = '2'),
    (r) => (r.restoredLedger.entriesChecked = '0'),
    (r) => (r.restoredLedger.fixtureAmount = '1'),
    (r) => (r.sourceLedger = null),
    (r) => (r.restoredLedger.amountsByCurrency = []),
  );
  for (const [index, mutate] of variants.entries()) {
    const report = passingReport();
    mutate(report);
    const gates = summarize(report).gates;
    const green = SUMMARY_GATES.filter((name) => name !== 'acceptance' && name !== 'cleanup').every(
      (name) => gates[name] === true,
    );
    let cli;
    try {
      cli = drillPassed(
        report.databases,
        report.schemaServices.length,
        report.sourceLedger,
        report.restoredLedger,
      );
    } catch {
      cli = false;
    }
    // The summary also demands the fixture amount, which drillPassed checks inside ledgerPassed.
    assert.equal(green, cli, `variant ${index}`);
  }
});

test('the verdict needs the CLI status and the CLI verdict to agree with the evidence', () => {
  assert.equal(summarize(passingReport(), { exitCode: 1 }).passed, false);
  assert.equal(summarize(passingReport(), { exitCode: null }).passed, false);
  assert.equal(summarize(passingReport(), {}).passed, false);
  const claimed = passingReport();
  claimed.passed = false;
  assert.equal(summarize(claimed).passed, false);
  const interrupted = passingReport();
  interrupted.interrupted = true;
  assert.equal(summarize(interrupted).passed, false);
  // Evidence red but the report says passed with exit 0: the recomputation still refuses.
  const lying = passingReport();
  everyDatabase('tablesEqual', false)(lying);
  const summary = summarize(lying);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.failingDatabases, ['rasta_economic', 'rasta_identity']);
});

test('an absent, partial or malformed report fails closed without throwing', () => {
  for (const report of [
    null,
    undefined,
    [],
    'text',
    7,
    {},
    { databases: 'x' },
    { databases: [null] },
  ]) {
    const summary = summarize(report);
    assert.equal(summary.passed, false, JSON.stringify(report));
    assert.deepEqual(failedGates(summary), SUMMARY_GATES);
    renderDrillSummary(summary);
  }
  assert.equal(summarize(null).reportReadable, false);
  assert.match(renderDrillSummary(summarize(null)), /left no readable report/);
});

test('nothing outside the allowlist reaches the summary, whatever the report holds', () => {
  const report = passingReport();
  report.error = {
    stage: `restore and compare rasta_economic ${SENTINELS[2]}`,
    message: SENTINELS.join(' '),
    database: SENTINELS[0],
    exitCode: 'SENTINEL_AMOUNT_7777777',
  };
  report.databases[0].database = SENTINELS[0];
  report.databases[0].tablesEqual = false;
  report.databases[1].schemaDiff = { identity: SENTINELS[3] };
  report.cleanup = { passed: false, project: SENTINELS[4], temporary: SENTINELS[4] };
  report.unknownFutureField = SENTINELS;
  report.restoredLedger.journalsChecked = SENTINELS[1];
  report.restoredLedger.entriesChecked = 4.5;
  const summary = summarize(report, { exitCode: 1, lastStage: SENTINELS[3] });
  const printed = `${JSON.stringify(summary)}\n${renderDrillSummary(summary)}`;
  const amounts = ['7777777', '18014398509487486', '9007199254740993'];
  for (const sentinel of [...SENTINELS, ...amounts]) {
    assert.ok(!printed.includes(sentinel), `${sentinel} leaked`);
    assert.ok(!printed.includes(sentinel.split(' ')[0]), `${sentinel} leaked in part`);
  }
  assert.equal(summary.failure.stage, null);
  assert.equal(summary.failure.database, null);
  assert.equal(summary.failure.commandExitCode, null);
  assert.equal(summary.counts.journals, null);
  assert.equal(summary.counts.entries, null);
  assert.equal(summary.lastStage, null);
  assert.deepEqual(
    summary.failingDatabases,
    ['rasta_identity'].filter(() => false),
  );
});

test('failure names the stage, the database and the command status the CLI recorded', () => {
  const report = passingReport();
  report.databases.pop();
  report.error = {
    stage: 'restore and compare rasta_economic',
    database: 'rasta_economic',
    exitCode: 1,
  };
  report.passed = false;
  const text = renderDrillSummary(summarize(report, { exitCode: 1 }));
  assert.match(text, /^## Monthly backup\/restore drill: FAILED/);
  assert.match(
    text,
    /Failed stage: restore and compare rasta_economic \(rasta_economic\), command exit 1/,
  );
  assert.match(text, /Failing gates: .*database-coverage/);
  assert.match(text, /CLI exit code: 1/);
});

test('stage names are a closed list; progress lines outside it are ignored', () => {
  for (const stage of [
    'preflight',
    'scratch drop',
    'build seed dependencies serially',
    'migrate economic',
    'generate and demo seed identity',
    'dump rasta_economic',
    'restore and compare rasta_audit',
    'cleanup owned containers, networks and volumes',
  ])
    assert.equal(allowedStage(stage), stage);
  for (const stage of ['', 'migrate', 'migrate x; rm', 'dump rasta_x\nY', null, 7, SENTINELS[3]])
    assert.equal(allowedStage(stage), null, String(stage));
  const stderr = [
    '[backup-restore-drill] migrate economic',
    `[backup-restore-drill] rasta_economic: ${SENTINELS[3]}`,
    'unprefixed migrate identity',
    '[backup-restore-drill] dump rasta_audit',
    '[backup-restore-drill] SELECT leak',
    '',
  ].join('\n');
  assert.equal(lastAllowedStage(stderr), 'dump rasta_audit');
  assert.equal(lastAllowedStage(''), null);
});

function runSummary(directory, report, exitCode, extra = []) {
  const reportPath = join(directory, 'report.json');
  if (report !== undefined) writeFileSync(reportPath, JSON.stringify(report));
  return spawnSync(
    process.execPath,
    [summaryCli, '--report', reportPath, '--exit-code', exitCode, ...extra],
    { encoding: 'utf8' },
  );
}

test('summary CLI: exit 0 only for a passing run; stdout is the allowlisted markdown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-summary-cli-'));
  try {
    const ok = runSummary(directory, passingReport(), '0');
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /PASSED/);
    assert.equal(ok.stderr, '');
    for (const sentinel of [...SENTINELS, '7777777', '18014398509487486', '9007199254740993'])
      assert.ok(!ok.stdout.includes(sentinel), sentinel);
    const bad = runSummary(directory, passingReport(), '1');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAILED/);
    for (const value of ['', 'abc', '-1', '1000', '0x1']) {
      const refused = runSummary(directory, passingReport(), value);
      assert.equal(refused.status, 1, value);
    }
    writeFileSync(join(directory, 'stderr.log'), '[backup-restore-drill] dump rasta_audit\n');
    const progress = runSummary(directory, undefined, '137', [
      '--progress',
      join(directory, 'stderr.log'),
    ]);
    assert.equal(progress.status, 1);
    assert.match(progress.stdout, /Last stage started: dump rasta_audit/);
    rmSync(join(directory, 'report.json'));
    const missing = runSummary(directory, undefined, '0');
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /left no readable report/);
    assert.ok(!missing.stdout.includes(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('summary CLI: a bad command line is refused by position, never repeated', () => {
  const secret = 'SENTINEL_ARGUMENT_/tmp/secret';
  for (const argv of [
    [],
    ['--report'],
    ['--report', 'a'],
    ['--exit-code', '0'],
    [secret, 'x'],
    ['--report', secret, '--report', secret, '--exit-code', '0'],
  ]) {
    const result = spawnSync(process.execPath, [summaryCli, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 2, argv.join(' '));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('SENTINEL_ARGUMENT'));
  }
});

// --- --cleanup-from -----------------------------------------------------------------------
const PROJECT = 'restore-drill-0123456789abcdef';

function fakeDocker(directory, { leftover = false } = {}) {
  const log = join(directory, 'docker.log');
  writeFileSync(
    join(directory, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *'down --volumes'*) : ;;
  'container ls -a '*) ${leftover ? 'echo owned-container' : ':'} ;;
esac
`,
  );
  chmodSync(join(directory, 'docker'), 0o700);
  return log;
}

function recorded(directory, project = PROJECT) {
  const temporary = join(directory, 'rasta-restore-drill-Ab12Cd');
  mkdirSync(temporary, { mode: 0o700 });
  writeFileSync(join(temporary, 'compose.json'), '{}');
  writeFileSync(join(temporary, 'a.dump'), 'synthetic');
  const report = join(directory, 'report.json');
  writeFileSync(report, JSON.stringify({ project, temporary, passed: false }));
  return { report, temporary };
}

function runCleanup(directory, report) {
  return spawnSync(process.execPath, [drillCli, '--cleanup-from', report], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TMPDIR: directory },
  });
}

test('--cleanup-from removes exactly the recorded project and its private directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-cleanup-cli-'));
  try {
    const log = fakeDocker(directory);
    const { report, temporary } = recorded(directory);
    const result = runCleanup(directory, report);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(temporary), false);
    const calls = (existsSync(log) ? readText(log) : '').trim().split('\n');
    assert.match(
      calls[0],
      new RegExp(
        `^compose --project-name ${PROJECT} --file ${temporary}/compose.json down --volumes`,
      ),
    );
    assert.deepEqual(
      calls
        .slice(1)
        .map((line) => line.split(' ')[0])
        .sort(),
      ['container', 'network', 'volume'],
    );
    for (const line of calls.slice(1))
      assert.ok(line.endsWith(`--filter label=com.docker.compose.project=${PROJECT}`), line);
    // Idempotent: the directory and compose file are gone, the label check alone answers.
    const again = runCleanup(directory, report);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(temporary));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--cleanup-from fails (and keeps the directory) when an owned resource survives', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-cleanup-left-'));
  try {
    fakeDocker(directory, { leftover: true });
    const { report, temporary } = recorded(directory);
    const result = runCleanup(directory, report);
    assert.equal(result.status, 1);
    assert.equal(existsSync(temporary), true);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(temporary));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--cleanup-from acts on nothing but a name and a directory the drill itself makes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-cleanup-refuse-'));
  try {
    const log = fakeDocker(directory);
    const outside = mkdtempSync(join(tmpdir(), 'drill-cleanup-outside-'));
    const cases = [
      { project: 'other-project', temporary: join(directory, 'rasta-restore-drill-Ab12Cd') },
      { project: `${PROJECT};x`, temporary: join(directory, 'rasta-restore-drill-Ab12Cd') },
      { project: PROJECT, temporary: outside },
      { project: PROJECT, temporary: join(directory, 'rasta-restore-drill-Ab12Cd', '..') },
      { project: PROJECT, temporary: `${join(directory, 'rasta-restore-drill-Ab12Cd')}/nested` },
      // Same length as the real directory, so the name check alone would pass it.
      {
        project: PROJECT,
        temporary: join(
          `${directory.slice(0, -1)}${directory.endsWith('X') ? 'Y' : 'X'}`,
          'rasta-restore-drill-Ab12Cd',
        ),
      },
      { project: PROJECT, temporary: 7 },
      { project: 7, temporary: join(directory, 'rasta-restore-drill-Ab12Cd') },
      { project: PROJECT },
    ];
    for (const entry of cases) {
      writeFileSync(join(directory, 'report.json'), JSON.stringify(entry));
      const result = runCleanup(directory, join(directory, 'report.json'));
      assert.equal(result.status, 2, JSON.stringify(entry));
      assert.equal(existsSync(outside), true);
    }
    assert.equal(existsSync(log), false, 'docker was never called');
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--cleanup-from with nothing recorded is a no-op, not a failure; usage stays closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-cleanup-none-'));
  try {
    const log = fakeDocker(directory);
    const missing = runCleanup(directory, join(directory, 'absent.json'));
    assert.equal(missing.status, 0);
    writeFileSync(join(directory, 'empty.json'), '');
    assert.equal(runCleanup(directory, join(directory, 'empty.json')).status, 0);
    writeFileSync(join(directory, 'bare.json'), '{"passed":false}');
    assert.equal(runCleanup(directory, join(directory, 'bare.json')).status, 0);
    assert.equal(existsSync(log), false);
    for (const argv of [
      [],
      ['--cleanup-from'],
      ['--cleanup-from', 'a', 'b'],
      ['--report', 'a', '--cleanup-from', 'b'],
    ]) {
      assert.equal(
        spawnSync(process.execPath, [drillCli, ...argv], { encoding: 'utf8' }).status,
        2,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { readFileSync } from 'node:fs';
function readText(path) {
  return readFileSync(path, 'utf8');
}
