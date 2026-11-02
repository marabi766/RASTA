import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, symlinkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  summaryRegistry,
} from './backup-restore-drill-lib.mjs';
import { servicesFromLibrary } from './infra-preflight-lib.mjs';

const summaryCli = new URL('./backup-restore-drill-summary.mjs', import.meta.url).pathname;
const scripts = new URL('.', import.meta.url).pathname;
// The service registry the drill itself iterates; the summary CLI reads the same file.
const REGISTRY = servicesFromLibrary();
// The library tests use two of them: names come from the registry, not from the report.
const SERVICES = ['economic', 'identity'];

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

function passingReport(services = SERVICES) {
  return {
    version: 5,
    project: 'restore-drill-0123456789abcdef',
    temporary: '/tmp/SENTINEL_PATH/report.json',
    startedAt: '2026-11-01T03:17:00.000Z',
    finishedAt: '2026-11-01T03:29:30.000Z',
    passed: true,
    interrupted: false,
    schemaServices: services,
    databases: services.map((service) => database(`rasta_${service}`)),
    sourceLedger: ledger(),
    restoredLedger: ledger(),
    cleanup: { passed: true },
  };
}

const summarize = (report, options = { exitCode: 0 }) =>
  summarizeDrillReport(report, { services: SERVICES, ...options });
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
    ['database-coverage', (r) => r.databases.pop()],
    // A database the registry does not know, in place of one it does; a duplicate of one.
    ['database-coverage', (r) => (r.databases[1].database = 'rasta_9007199254740993')],
    ['database-coverage', (r) => (r.databases[1].database = 'rasta_economic')],
    ['database-coverage', (r) => r.databases.push(database('rasta_identity'))],
    // The report's own list of services is not evidence of what should exist.
    ['database-coverage', (r) => ((r.schemaServices = ['economic']), r.databases.pop())],
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
    (r) => (r.databases.length = 0),
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
        SERVICES.length,
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
  const registry = summaryRegistry(SERVICES);
  for (const stage of [
    'preflight',
    'scratch drop',
    'build seed dependencies serially',
    'migrate economic',
    'generate and demo seed identity',
    'dump rasta_economic',
    'restore and compare rasta_economic',
    'cleanup owned containers, networks and volumes',
  ])
    assert.equal(allowedStage(stage, registry), stage);
  // Suffix patterns are gone: a service the registry does not list is not a stage, however
  // plausible the name looks.
  for (const stage of [
    '',
    'migrate',
    'migrate x; rm',
    'migrate 9007199254740993',
    'migrate fleet',
    'dump rasta_9007199254740993',
    'dump rasta_x\nY',
    'restore and compare rasta_audit',
    null,
    7,
    {},
    SENTINELS[3],
  ])
    assert.equal(allowedStage(stage, registry), null, String(stage));
  assert.equal(allowedStage('preflight', undefined), null, 'no registry, no stage');
  const stderr = [
    '[backup-restore-drill] migrate economic',
    `[backup-restore-drill] rasta_economic: ${SENTINELS[3]}`,
    'unprefixed migrate identity',
    '[backup-restore-drill] dump rasta_economic',
    '[backup-restore-drill] migrate 9007199254740993',
    '[backup-restore-drill] SELECT leak',
    '',
  ].join('\n');
  assert.equal(lastAllowedStage(stderr, registry), 'dump rasta_economic');
  assert.equal(lastAllowedStage('', registry), null);
  assert.equal(lastAllowedStage(stderr, undefined), null);
});

function runSummary(directory, report, exitCode, extra = []) {
  const reportPath = join(directory, 'report.json');
  if (report !== undefined) writeFileSync(reportPath, JSON.stringify(report));
  return spawnSync(
    process.execPath,
    [summaryCli, '--report', reportPath, '--exit-code', exitCode, ...extra],
    { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
  );
}

test('summary CLI: exit 0 only for a passing run; stdout is the allowlisted markdown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-summary-cli-'));
  try {
    const ok = runSummary(directory, passingReport(REGISTRY), '0');
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /PASSED/);
    assert.equal(ok.stderr, '');
    for (const sentinel of [...SENTINELS, '7777777', '18014398509487486', '9007199254740993'])
      assert.ok(!ok.stdout.includes(sentinel), sentinel);
    const bad = runSummary(directory, passingReport(REGISTRY), '1');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAILED/);
    for (const value of ['', 'abc', '-1', '1000', '0x1']) {
      const refused = runSummary(directory, passingReport(REGISTRY), value);
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
    const result = spawnSync(process.execPath, [summaryCli, ...argv], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 2, argv.join(' '));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('SENTINEL_ARGUMENT'));
  }
});

// --- F3: names come from the registry; every failure of the summary is sanitized ------------
const HUGE = '9007199254740993';

test('a name or stage that merely looks like one is never printed: rasta_<digits>, migrate <digits>', () => {
  const report = passingReport();
  report.passed = false;
  report.databases[0].tablesEqual = false;
  report.databases[0].database = `rasta_${HUGE}`;
  report.error = {
    stage: `migrate ${HUGE}`,
    database: `rasta_${HUGE}`,
    exitCode: 1,
  };
  const summary = summarize(report, { exitCode: 1, lastStage: `migrate ${HUGE}` });
  const printed = `${JSON.stringify(summary)}\n${renderDrillSummary(summary)}`;
  assert.ok(!printed.includes(HUGE), 'none of failingDatabases, failure.*, lastStage prints it');
  assert.deepEqual(summary.failingDatabases, []);
  assert.equal(summary.failure.stage, null);
  assert.equal(summary.failure.database, null);
  assert.equal(summary.lastStage, null);
  // A real registry name is still named.
  report.databases[0].database = 'rasta_economic';
  report.error = { stage: 'migrate economic', database: 'rasta_economic', exitCode: 1 };
  const named = renderDrillSummary(summarize(report, { exitCode: 1 }));
  assert.match(named, /Failing databases: rasta_economic/);
  assert.match(named, /Failed stage: migrate economic \(rasta_economic\)/);
  // No registry at all: nothing is accepted, nothing is named.
  const none = summarizeDrillReport(report, { exitCode: 0 });
  assert.equal(none.passed, false);
  assert.deepEqual(none.failingDatabases, []);
});

test('a report whose fields carry objects, getters or odd types cannot make the summary throw', () => {
  for (const patch of [
    { startedAt: { toString: null } },
    { startedAt: { toString: () => '2026-11-01T03:17:00.000Z' } },
    { finishedAt: { valueOf: () => 1 } },
    { startedAt: [], finishedAt: [[]] },
    { databases: [{ database: { toString: null }, before: { tables: 5, summary: [] } }] },
    { error: { stage: { toString: null }, database: Symbol.iterator === 1, exitCode: 1e300 } },
    { sourceLedger: { amountsByCurrency: { length: 2 } } },
  ]) {
    const report = { ...passingReport(), ...patch };
    const summary = summarize(report);
    renderDrillSummary(summary);
    assert.equal(
      summary.durations.totalSeconds === null || Number.isInteger(summary.durations.totalSeconds),
      true,
    );
  }
});

function sandboxedSummary(directory, { without = [] } = {}) {
  const copy = join(directory, 'scripts');
  mkdirSync(copy, { recursive: true });
  for (const name of [
    'backup-restore-drill-summary.mjs',
    'backup-restore-drill-lib.mjs',
    'infra-preflight-lib.mjs',
    'check-kafka-credential-scope-lib.mjs',
    'database-services.mjs',
  ])
    if (!without.includes(name)) cpSync(join(scripts, name), join(copy, name));
  const role = 'infrastructure/docker/postgres/lib/role-passwords.bash';
  mkdirSync(join(directory, role, '..'), { recursive: true });
  cpSync(join(scripts, '..', role), join(directory, role));
  // The registry reader imports `yaml` through the shared libraries, as in the workflow's checkout.
  symlinkSync(join(scripts, '..', 'node_modules'), join(directory, 'node_modules'), 'dir');
  return join(copy, 'backup-restore-drill-summary.mjs');
}

test('summary CLI: its own failures are one fixed message, never a stack, a path or report content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-summary-fail-'));
  try {
    const report = join(directory, 'report.json');
    writeFileSync(report, JSON.stringify(passingReport(REGISTRY)));
    for (const without of [
      ['backup-restore-drill-lib.mjs'], // the import fails
      ['infra-preflight-lib.mjs'], // the registry cannot be loaded
    ]) {
      const cli = sandboxedSummary(join(directory, without[0]), { without });
      const result = spawnSync(process.execPath, [cli, '--report', report, '--exit-code', '0'], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const printed = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, without[0]);
      assert.match(result.stdout, /Monthly backup\/restore drill: FAILED/);
      assert.match(result.stderr, /the summary could not be built/);
      assert.doesNotMatch(printed, /\bat \w|node:internal|\.mjs|Error|ERR_|file:\/\/|\/tmp|\/home/);
      assert.ok(!printed.includes(directory));
    }
    // The same script with every module present prints the verdict instead.
    const fine = sandboxedSummary(join(directory, 'fine'));
    const ok = spawnSync(process.execPath, [fine, '--report', report, '--exit-code', '0'], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /PASSED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('summary CLI: a report that claims two databases is not a pass against the real registry; odd names are not printed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-summary-registry-'));
  try {
    const report = join(directory, 'report.json');
    writeFileSync(report, JSON.stringify(passingReport(SERVICES)));
    const short = spawnSync(
      process.execPath,
      [summaryCli, '--report', report, '--exit-code', '0'],
      {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
    );
    assert.equal(short.status, 1);
    assert.match(short.stdout, new RegExp(`expectedDatabases \\| ${REGISTRY.length} \\|`));
    const odd = passingReport(REGISTRY);
    odd.passed = false;
    odd.databases[0].database = `rasta_${HUGE}`;
    odd.databases[0].tablesEqual = false;
    odd.startedAt = { toString: null };
    odd.error = { stage: `migrate ${HUGE}`, database: `rasta_${HUGE}` };
    writeFileSync(report, JSON.stringify(odd));
    writeFileSync(join(directory, 'stderr.log'), `[backup-restore-drill] migrate ${HUGE}\n`);
    const result = spawnSync(
      process.execPath,
      [
        summaryCli,
        '--report',
        report,
        '--exit-code',
        '1',
        '--progress',
        join(directory, 'stderr.log'),
      ],
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(HUGE));
    assert.doesNotMatch(result.stderr, /at |Error/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// #478 r3 R3: the summary's two inputs are read like the recovery's: never blocking on a special
// file, only as a regular file, bounded. The child has a deadline, so a blocking open fails the
// test instead of hanging it.
test('summary CLI: a FIFO as the report or the progress file is "no input", never a hang', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-summary-fifo-'));
  try {
    const fifo = join(directory, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const run = (args) =>
      spawnSync(process.execPath, [summaryCli, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        killSignal: 'SIGKILL',
      });
    const asReport = run(['--report', fifo, '--exit-code', '0']);
    assert.equal(asReport.signal, null, 'blocked on a FIFO report');
    assert.equal(asReport.status, 1);
    assert.match(asReport.stdout, /FAILED|did not pass|not available/i);
    const report = join(directory, 'report.json');
    writeFileSync(report, JSON.stringify(passingReport(REGISTRY)));
    const asProgress = run(['--report', report, '--exit-code', '0', '--progress', fifo]);
    assert.equal(asProgress.signal, null, 'blocked on a FIFO progress file');
    assert.ok(asProgress.status === 0 || asProgress.status === 1, asProgress.stderr);
    const bounded = join(directory, 'progress.log');
    writeFileSync(bounded, 'x'.repeat(9 * 1024 * 1024));
    const asBig = run(['--report', report, '--exit-code', '0', '--progress', bounded]);
    assert.equal(asBig.signal, null);
    assert.ok(asBig.status === 0 || asBig.status === 1, asBig.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
