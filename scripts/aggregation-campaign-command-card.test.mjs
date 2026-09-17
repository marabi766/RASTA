/**
 * Static contract test of the ADR-055 L11–L13 operator command card
 * (launch-readiness § 20).
 *
 * The card is read as text. Its four marked commands are checked against
 * `package.json` and the exported argument parsers of the four tools: the
 * exact package script, the forwarded `--`, the manifest option grammar, and
 * which placeholder lands in which role. Its pass and failure lines are checked
 * against the tools' own output text: formatters for the pass lines, and
 * in-process CLI runs with injected, failing reads for exit `1` and exit `2`.
 * Deliberate drift cases prove that the check fails when the card drifts.
 *
 * Offline and manual: run it directly with `node --test`. It reads only the
 * runbook, `package.json` and the CI and test-phase definitions. Every CLI run
 * here gets injected reads that name no real file, writes nothing, and calls no
 * network, GitHub, account or billing API. Nothing here is campaign evidence.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT, formatAccounting } from './aggregation-campaign-accounting-lib.mjs';
import { parseAccountingArgs, runAccountingCli } from './aggregation-campaign-accounting.mjs';
import { COHORT_DECISION, formatCohortReview } from './aggregation-campaign-image-cohort-lib.mjs';
import { parseImageCohortArgs, runImageCohortCli } from './aggregation-campaign-image-cohort.mjs';
import {
  LOG_RECOVERY_LIMITS,
  formatMaterialization,
  formatRecovery,
} from './aggregation-campaign-log-recovery-lib.mjs';
import { parseRecoveryArgs, runLogRecoveryCli } from './aggregation-campaign-log-recovery.mjs';
import {
  MAX_REPORT_MANIFEST_BYTES,
  PATH_MANIFEST_PROBLEM,
  pathManifestMaxBytes,
} from './aggregation-campaign-report-manifest-lib.mjs';
import {
  COMPARISON_DECISION,
  formatRetrievalComparison,
} from './aggregation-campaign-retrieval-comparison-lib.mjs';
import {
  parseComparisonArgs,
  runRetrievalComparisonCli,
} from './aggregation-campaign-retrieval-comparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const RUNBOOK = join(
  repoRoot,
  'docs',
  'evidence',
  'adr-055',
  'fresh-run-campaign-launch-readiness-2026-09-16.md',
);
const CARD_HEADING = '## 20. Appendix — L11–L13 operator command card (2026-09-17)';
const CMD_EXE_LIMIT = 8191;
const MAX_PATH_BYTES = 1024;

const runbookText = () => readFileSync(RUNBOOK, 'utf8');
const packageJson = () => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// The expected card: steps in runbook order, scripts, placeholders and roles

const PARSE_OPTIONS = Object.freeze({ platform: 'posix', cwd: '/card-caller' });

/**
 * Each step: its marker id, package script, script file, the placeholders its
 * command must contain once each, and how the parser's result maps placeholders
 * to roles. `mode` must be the manifest mode for every step.
 */
const CARD_STEPS = Object.freeze([
  {
    id: 'L11-recover',
    script: 'recover:aggregation-campaign-logs',
    file: 'scripts/aggregation-campaign-log-recovery.mjs',
    placeholders: ['<new-directory>', '<job-log-manifest>'],
    parse: (argv, options) => parseRecoveryArgs(argv, options),
    roles: (parsed) => ({
      '<new-directory>': parsed.outputDir,
      '<job-log-manifest>': parsed.manifest,
    }),
  },
  {
    id: 'L11-compare',
    script: 'compare:aggregation-campaign-retrievals',
    file: 'scripts/aggregation-campaign-retrieval-comparison.mjs',
    placeholders: ['<artifacts-report-manifest>', '<fallback-report-manifest>'],
    parse: (argv, options) => parseComparisonArgs(argv, options),
    roles: (parsed) => ({
      '<artifacts-report-manifest>': parsed.manifests?.artifacts,
      '<fallback-report-manifest>': parsed.manifests?.fallback,
    }),
  },
  {
    id: 'L12-account',
    script: 'account:aggregation-campaign',
    file: 'scripts/aggregation-campaign-accounting.mjs',
    placeholders: ['<selected-report-manifest>'],
    parse: (argv, options) => parseAccountingArgs(argv, options),
    roles: (parsed) => ({ '<selected-report-manifest>': parsed.manifest }),
  },
  {
    id: 'L13-review',
    script: 'review:aggregation-campaign-image-cohort',
    file: 'scripts/aggregation-campaign-image-cohort.mjs',
    placeholders: ['<image-cohort-manifest>', '<selected-report-manifest>'],
    parse: (argv, options) => parseImageCohortArgs(argv, options),
    roles: (parsed) => ({
      '<image-cohort-manifest>': parsed.reviewManifest,
      '<selected-report-manifest>': parsed.reportsManifest,
    }),
  },
]);

const PLACEHOLDER = /^<[a-z][a-z-]*>$/;
const OPTION = /^--[a-z][a-z-]*$/;

/** The card section: from its heading to the next top-level heading or the end. */
function cardSection(text) {
  const start = text.indexOf(`\n${CARD_HEADING}\n`);
  if (start === -1) return null;
  const next = text.indexOf('\n## ', start + CARD_HEADING.length + 2);
  return text.slice(start + 1, next === -1 ? text.length : next + 1);
}

/** The step subsections (`### `) of the card, each with its heading and body. */
function subsections(section) {
  return section
    .split(/\n(?=### )/)
    .filter((part) => part.startsWith('### '))
    .map((part) => ({ heading: part.slice(0, part.indexOf('\n')), body: part }));
}

const MARKER = /<!-- command-card:([^ ]*) -->/g;
const MARKED_COMMAND = /<!-- command-card:([A-Za-z0-9-]+) -->\n\n```text\n([^\n`]*)\n```\n/g;

/** Every marked command, in document order: `{ id, command }`; and the count of markers. */
function markedCommands(section) {
  const markers = [...section.matchAll(MARKER)].length;
  const commands = [...section.matchAll(MARKED_COMMAND)].map(([, id, command]) => ({
    id,
    command,
  }));
  return { markers, commands };
}

/** A distinct absolute value for each placeholder; `long` makes each 1024 bytes. */
const valueFor = (placeholder, { long = false, platform = 'posix' } = {}) => {
  const name = placeholder.slice(1, -1);
  const base = platform === 'win32' ? `C:\\card\\${name}` : `/card/${name}`;
  return long ? `${base}-${'x'.repeat(MAX_PATH_BYTES - base.length - 1)}` : base;
};

/**
 * Checks one command line against its expected step. Returns problem strings,
 * empty when the command is exact.
 */
function checkCommand(step, command, pkg) {
  const problems = [];
  const fail = (problem) => problems.push(`${step.id}: ${problem}`);
  const tokens = command.split(' ');
  if (tokens.some((token) => token === '')) fail('empty token (repeated or edge space)');
  const [program, verb, script, separator, ...args] = tokens;
  if (program !== 'pnpm' || verb !== 'run') fail('not a `pnpm run` command');
  if (script !== step.script) fail('wrong package script');
  if (pkg.scripts?.[step.script] !== `node ${step.file}`) {
    fail('package script does not run the expected file');
  }
  if (!existsSync(join(repoRoot, step.file))) fail('script file does not exist');
  if (separator !== '--') fail('arguments are not forwarded after `--`');

  const used = args.filter((arg) => PLACEHOLDER.test(arg));
  for (const arg of args) {
    if (!PLACEHOLDER.test(arg) && !OPTION.test(arg))
      fail('argument is neither option nor placeholder');
  }
  if (
    used.length !== step.placeholders.length ||
    [...used].sort().join() !== [...step.placeholders].sort().join()
  ) {
    fail('placeholders differ from the expected set');
  }
  if (problems.length > 0) return problems;

  for (const platform of ['posix', 'win32']) {
    for (const long of [false, true]) {
      const argv = args.map((arg) =>
        PLACEHOLDER.test(arg) ? valueFor(arg, { long, platform }) : arg,
      );
      // `pnpm run <script> -- …` forwards the separator itself.
      const parsed = step.parse(['--', ...argv], {
        platform,
        cwd: platform === 'win32' ? 'C:\\card-caller' : PARSE_OPTIONS.cwd,
      });
      const label = `${platform}${long ? ' with 1024-byte paths' : ''}`;
      if (!parsed.ok) {
        fail(`parser refuses the command (${label}): ${parsed.output.split('\n')[0]}`);
        continue;
      }
      if (parsed.mode !== 'manifest') fail(`not the manifest mode (${label})`);
      const roles = step.roles(parsed);
      for (const placeholder of step.placeholders) {
        if (roles[placeholder] !== valueFor(placeholder, { long, platform })) {
          fail(`${placeholder} is not in its role (${label})`);
        }
      }
      if (long) {
        const length = ['pnpm', 'run', step.script, '--', ...argv]
          .map((word) => word.length + 3)
          .reduce((a, b) => a + b, 0);
        if (length >= CMD_EXE_LIMIT) fail('longest command line reaches the cmd.exe limit');
      }
    }
  }
  return problems;
}

/** Checks the whole card against `package.json`; returns problem strings, empty when exact. */
function checkCommandCard(text, pkg) {
  const section = cardSection(text);
  if (section === null) return ['card section is missing'];
  const problems = [];
  const { markers, commands } = markedCommands(section);
  if (markers !== commands.length) problems.push('a command marker is not followed by one command');
  const ids = commands.map(({ id }) => id);
  if (ids.join() !== CARD_STEPS.map(({ id }) => id).join()) {
    problems.push('marked commands are missing, extra or out of runbook order');
  }
  for (const step of CARD_STEPS) {
    const found = commands.filter(({ id }) => id === step.id);
    if (found.length !== 1) continue;
    problems.push(...checkCommand(step, found[0].command, pkg));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The tools' own output text: pass lines from the formatters, failures from injected CLI runs

const COMMIT = 'c'.repeat(40);
const DIGEST = '0123456789abcdef';

const completeAccounting = () => ({
  inputs: CAMPAIGN_SLOT_COUNT,
  rejected: {},
  provenance: { commits: [COMMIT], topologyDigests: [DIGEST] },
  slots: [],
  problems: [],
  totals: { nonEvents: 58, events: 1, blockers: 0, missing: 0 },
  accounted: CAMPAIGN_SLOT_COUNT,
  invariantHolds: true,
  complete: true,
});

const linesOf = (text) => text.split('\n').map((line) => line.trim());
const lineStarting = (text, prefix) => linesOf(text).find((line) => line.startsWith(prefix));

/** A read that always fails and records that it was attempted. */
const failingRead = (log) => (path) => {
  log.push(path);
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

const manifestBytes = (prefix, count) =>
  Buffer.from(
    Array.from({ length: count }, (_, i) => `${prefix}/r-${String(i).padStart(2, '0')}.txt\n`).join(
      '',
    ),
  );

/** A file-system adapter for materialization that allows no call. */
const forbiddenFs = (calls) =>
  new Proxy(
    {},
    {
      get: (_, name) => () => {
        calls.push(String(name));
        throw new Error('unexpected output file system call');
      },
    },
  );

/**
 * Per step: the exact text lines the card must quote, and the observed exit
 * codes of real CLI runs with injected reads. Nothing here touches a real file.
 */
function observedOutcomes() {
  const P = PATH_MANIFEST_PROBLEM;
  const outcomes = {};

  // Step 1 — recovery.
  {
    const accounting = completeAccounting();
    const pass = formatRecovery(
      {
        recovery: {
          logs: CAMPAIGN_SLOT_COUNT,
          readableLogs: CAMPAIGN_SLOT_COUNT,
          reports: Array.from({ length: CAMPAIGN_SLOT_COUNT }, () => ''),
          rejectedCount: 0,
          rejections: {},
          clean: true,
        },
        accounting,
        ok: true,
      },
      { materialization: { written: true, count: CAMPAIGN_SLOT_COUNT } },
    );
    const reads = [];
    const calls = [];
    const fail = runLogRecoveryCli({
      argv: ['--', '--output-dir', '/card/new-directory', '--logs-manifest', '/card/logs.list'],
      manifestSizeOf: () => manifestBytes('logs', 1).length,
      readManifestBytes: () => manifestBytes('logs', 1),
      sizeOf: failingRead(reads),
      readText: failingRead(reads),
      fs: forbiddenFs(calls),
      ...PARSE_OPTIONS,
    });
    const usageReads = [];
    const usage = runLogRecoveryCli({
      argv: ['--', '--output-dir', '/card/new-directory', '--logs-manifest', '/card/logs.list'],
      manifestSizeOf: failingRead(usageReads),
      readManifestBytes: failingRead(usageReads),
      sizeOf: failingRead(usageReads),
      readText: failingRead(usageReads),
      fs: forbiddenFs(calls),
      ...PARSE_OPTIONS,
    });
    assert.deepEqual(calls, [], 'recovery made no output file system call');
    outcomes['L11-recover'] = {
      pass: {
        lines: [
          lineStarting(pass, 'accounting: COMPLETE'),
          formatMaterialization({ written: true, count: CAMPAIGN_SLOT_COUNT }),
          'RESULT: PASS',
        ],
        lastLine: linesOf(pass).at(-2),
      },
      fail: { exitCode: fail.exitCode, lines: ['RESULT: FAIL', 'materialization: NOT WRITTEN'] },
      failOutput: fail.output,
      usage: {
        exitCode: usage.exitCode,
        firstLine: usage.output.split('\n')[0],
        reads: usageReads,
      },
      usagePrefix: 'logs manifest: ',
      expectedUsageLine: `logs manifest: ${P.unreadable}`,
    };
  }

  // Step 2 — comparison.
  {
    const accepted = {
      accepted: true,
      inputs: CAMPAIGN_SLOT_COUNT,
      read: CAMPAIGN_SLOT_COUNT,
      accountingComplete: true,
      problems: [],
    };
    const pass = formatRetrievalComparison({
      artifacts: accepted,
      fallback: accepted,
      comparison: { compared: 59, identical: 59, different: 0 },
      decision: COMPARISON_DECISION.match,
    });
    const reads = [];
    const fail = runRetrievalComparisonCli({
      argv: ['--', '--artifacts-manifest', '/card/a.list', '--fallback-manifest', '/card/f.list'],
      manifestSizeOf: (path) => manifestBytes(path.includes('a.list') ? 'a' : 'f', 59).length,
      readManifestBytes: (path) => manifestBytes(path.includes('a.list') ? 'a' : 'f', 59),
      sizeOf: failingRead(reads),
      readBytes: failingRead(reads),
      ...PARSE_OPTIONS,
    });
    const usageReads = [];
    const usage = runRetrievalComparisonCli({
      argv: ['--', '--artifacts-manifest', '/card/a.list', '--fallback-manifest', '/card/f.list'],
      manifestSizeOf: failingRead(usageReads),
      readManifestBytes: failingRead(usageReads),
      sizeOf: failingRead(usageReads),
      readBytes: failingRead(usageReads),
      ...PARSE_OPTIONS,
    });
    outcomes['L11-compare'] = {
      pass: {
        lines: [
          lineStarting(pass, 'artifacts cohort: '),
          lineStarting(pass, 'fallback cohort: '),
          lineStarting(pass, 'comparison: '),
          `COMPARISON: ${COMPARISON_DECISION.match}`,
        ],
      },
      fail: {
        exitCode: fail.exitCode,
        lines: [
          `COMPARISON: ${COMPARISON_DECISION.different}`,
          `COMPARISON: ${COMPARISON_DECISION.rejected}`,
        ],
      },
      failOutput: fail.output,
      failLine: `COMPARISON: ${COMPARISON_DECISION.rejected}`,
      usage: {
        exitCode: usage.exitCode,
        firstLine: usage.output.split('\n')[0],
        reads: usageReads,
      },
      usagePrefix: 'artifacts manifest: ',
      extraUsagePrefixes: ['fallback manifest: '],
      expectedUsageLine: `artifacts manifest: ${P.unreadable}`,
    };
  }

  // Step 3 — accounting.
  {
    const pass = formatAccounting(completeAccounting());
    const reads = [];
    const fail = runAccountingCli({
      argv: ['--', '--reports-manifest', '/card/selected.list'],
      manifestSizeOf: () => manifestBytes('s', 59).length,
      readManifestBytes: () => manifestBytes('s', 59),
      readText: failingRead(reads),
      ...PARSE_OPTIONS,
    });
    const usageReads = [];
    const usage = runAccountingCli({
      argv: ['--', '--reports-manifest', '/card/selected.list'],
      manifestSizeOf: failingRead(usageReads),
      readManifestBytes: failingRead(usageReads),
      readText: failingRead(usageReads),
      ...PARSE_OPTIONS,
    });
    const invariant = lineStarting(pass, 'invariant: ');
    outcomes['L12-account'] = {
      pass: {
        lines: [
          invariant.slice(invariant.indexOf('= 59 (expected')),
          lineStarting(pass, 'accounting: '),
        ],
      },
      fail: { exitCode: fail.exitCode, lines: ['accounting: INCOMPLETE - '] },
      failOutput: fail.output,
      failLine: lineStarting(fail.output, 'accounting: '),
      usage: {
        exitCode: usage.exitCode,
        firstLine: usage.output.split('\n')[0],
        reads: usageReads,
      },
      usagePrefix: 'reports manifest: ',
      expectedUsageLine: `reports manifest: ${P.unreadable}`,
    };
  }

  // Step 4 — image-cohort review.
  {
    const pass = formatCohortReview({
      snapshot: { accepted: true, problems: [] },
      cohort: {
        reports: 59,
        accountingComplete: true,
        resolvedSlots: 59,
        blockers: 0,
        missing: 0,
        rejectedInputs: 0,
        commits: 1,
        commitMatchesManifest: true,
        measuredTopologies: 1,
        topologyDigest: DIGEST,
        problems: [],
      },
      decision: COHORT_DECISION.consistent,
    });
    const reads = [];
    const fail = runImageCohortCli({
      argv: ['--', '/card/image-cohort.json', '--reports-manifest', '/card/selected.list'],
      reportsManifestSizeOf: () => manifestBytes('s', 59).length,
      readReportsManifestBytes: () => manifestBytes('s', 59),
      sizeOf: failingRead(reads),
      readText: failingRead(reads),
      now: new Date('2026-09-17T00:00:00Z'),
      ...PARSE_OPTIONS,
    });
    const usageReads = [];
    const usage = runImageCohortCli({
      argv: ['--', '/card/image-cohort.json', '--reports-manifest', '/card/selected.list'],
      reportsManifestSizeOf: failingRead(usageReads),
      readReportsManifestBytes: failingRead(usageReads),
      sizeOf: failingRead(usageReads),
      readText: failingRead(usageReads),
      now: new Date('2026-09-17T00:00:00Z'),
      ...PARSE_OPTIONS,
    });
    outcomes['L13-review'] = {
      pass: {
        lines: [
          lineStarting(pass, 'pre-launch snapshot: '),
          lineStarting(pass, 'commits='),
          `COHORT: ${COHORT_DECISION.consistent}`,
        ],
      },
      fail: { exitCode: fail.exitCode, lines: [`COHORT: ${COHORT_DECISION.branchC}`] },
      failOutput: fail.output,
      failLine: `COHORT: ${COHORT_DECISION.branchC}`,
      usage: {
        exitCode: usage.exitCode,
        firstLine: usage.output.split('\n')[0],
        reads: usageReads,
      },
      usagePrefix: 'reports manifest: ',
      expectedUsageLine: `reports manifest: ${P.unreadable}`,
    };
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Tests

test('card: the four marked commands are exact package scripts, in runbook order, parsed into the intended manifest roles', () => {
  const text = runbookText();
  const section = cardSection(text);
  assert.ok(section, 'the § 20 card exists');
  assert.equal(text.indexOf(CARD_HEADING), text.lastIndexOf(CARD_HEADING), 'one card only');
  assert.deepEqual(checkCommandCard(text, packageJson()), []);

  const { markers, commands } = markedCommands(section);
  assert.equal(markers, 4);
  assert.deepEqual(
    commands.map(({ command }) => command),
    [
      'pnpm run recover:aggregation-campaign-logs -- --output-dir <new-directory> --logs-manifest <job-log-manifest>',
      'pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest <artifacts-report-manifest> --fallback-manifest <fallback-report-manifest>',
      'pnpm run account:aggregation-campaign -- --reports-manifest <selected-report-manifest>',
      'pnpm run review:aggregation-campaign-image-cohort -- <image-cohort-manifest> --reports-manifest <selected-report-manifest>',
    ],
  );
  // Each command sits in its own step subsection, whose heading names the step.
  const parts = subsections(section);
  for (const [id, heading] of [
    ['L11-recover', '### 20.3 Step 1 — L11 fallback recovery'],
    ['L11-compare', '### 20.4 Step 2 — optional L11 byte comparison'],
    ['L12-account', '### 20.5 Step 3 — L12 accounting'],
    ['L13-review', '### 20.6 Step 4 — L13 image-cohort review'],
  ]) {
    const holding = parts.filter(({ body }) => body.includes(`<!-- command-card:${id} -->`));
    assert.equal(holding.length, 1, id);
    assert.ok(holding[0].heading.startsWith(heading), `${id} is under ${heading}`);
  }
  // The marked commands are the only `pnpm run` commands on the card, so nothing unchecked hides there.
  assert.equal(section.split('pnpm run ').length - 1, 4);
});

test('card: quoted pass lines and exit codes are the tools’ own text, and failures are fail-closed', () => {
  const section = cardSection(runbookText());
  const parts = subsections(section);
  const outcomes = observedOutcomes();

  for (const step of CARD_STEPS) {
    const observed = outcomes[step.id];
    const { body } = parts.find((part) => part.body.includes(`<!-- command-card:${step.id} -->`));
    const quoted = (value) => body.includes(`\`${value}`);

    // Pass: exit 0, and every required line quoted exactly as the formatter prints it.
    assert.ok(body.includes('**Pass — exit `0`.**'), `${step.id} pass exit`);
    for (const line of observed.pass.lines) {
      assert.ok(typeof line === 'string' && line.length > 0, `${step.id} formatter line`);
      assert.ok(quoted(line), `${step.id} quotes ${line}`);
    }
    if (observed.pass.lastLine !== undefined) assert.equal(observed.pass.lastLine, 'RESULT: PASS');

    // Exit 1: a real CLI run with failing injected reads, and the card's failure lines.
    assert.equal(observed.fail.exitCode, 1, `${step.id} failure is exit 1`);
    assert.ok(body.includes('**Exit `1`'), `${step.id} names exit 1`);
    for (const line of observed.fail.lines) assert.ok(quoted(line), `${step.id} quotes ${line}`);
    if (observed.failLine !== undefined) {
      assert.ok(observed.failOutput.includes(observed.failLine), `${step.id} real failure line`);
    }
    for (const line of observed.fail.lines.filter((l) => !l.startsWith('COMPARISON: DIFF'))) {
      assert.ok(observed.failOutput.includes(line.trimEnd()), `${step.id} output has ${line}`);
    }

    // Exit 2: a real manifest-contract refusal, before any report or log is read.
    assert.equal(observed.usage.exitCode, 2, `${step.id} manifest failure is exit 2`);
    assert.equal(observed.usage.firstLine, observed.expectedUsageLine, step.id);
    assert.equal(
      observed.usage.reads.length,
      1,
      `${step.id}: only the manifest size was attempted`,
    );
    assert.ok(body.includes('**Exit `2`.**'), `${step.id} names exit 2`);
    for (const prefix of [observed.usagePrefix, ...(observed.extraUsagePrefixes ?? [])]) {
      assert.ok(quoted(`${prefix}<problem>`), `${step.id} quotes ${prefix}`);
    }
  }

  // Fail-closed consequences in the card's own words.
  const body = (id) => parts.find((part) => part.body.includes(`<!-- command-card:${id} -->`)).body;
  assert.match(body('L11-compare'), /This is a \*\*STOP\*\*, and the campaign is \*\*Branch C\*\*/);
  assert.match(body('L11-compare'), /It is \*\*not\*\* permission to choose a source/);
  assert.match(body('L11-compare'), /decision to compare was recorded before running it/);
  assert.match(body('L12-account'), /The result is \*\*Branch C\*\*/);
  assert.match(body('L12-account'), /only after `COMPARISON: MATCH`/);
  assert.match(body('L12-account'), /Never mix the two/);
  assert.match(body('L13-review'), /image_cohort_manifest_sha256/);
  assert.match(body('L13-review'), /same file used in\s+step 3/);
  assert.match(body('L13-review'), /The result is \*\*Branch C\*\*/);
  assert.match(body('L11-recover'), /only when\*\* the 59 per-slot artifacts cannot be retrieved/);
  assert.match(body('L11-recover'), /must not exist yet/);
  assert.match(
    body('L11-recover'),
    /outside the tracked tree and outside\s+`\.github\/workflows\/`/,
  );
});

test('card: rules, manifest kinds, bounds and non-claims match the implemented contracts', () => {
  const section = cardSection(runbookText());
  const [rules, kinds] = subsections(section);
  assert.ok(rules.heading.startsWith('### 20.1 '));
  assert.ok(kinds.heading.startsWith('### 20.2 '));

  assert.match(rules.body, /as an absolute path/);
  assert.match(rules.body, /`pnpm run` runs the script from the repository\s+root/);
  assert.match(rules.body, /An exit-`2` correction \*\*never\*\* edits/);
  for (const kept of ['job log', 'artifact', 'report', 'JSON snapshot', 'output directory']) {
    assert.ok(rules.body.includes(kept), kept);
  }

  // The bounds on the card are the implemented ones.
  assert.equal(LOG_RECOVERY_LIMITS.maxLogs, 128);
  assert.equal(pathManifestMaxBytes(LOG_RECOVERY_LIMITS.maxLogs), 131200);
  assert.equal(MAX_REPORT_MANIFEST_BYTES, 60475);
  assert.equal(CAMPAIGN_SLOT_COUNT, 59);
  const row = (label) => kinds.body.split('\n').find((line) => line.includes(label));
  assert.match(row('**job-log manifest**'), /\*\*1–128\*\* lines\s+\| 131 200\s+\|$/);
  assert.match(row('**report-path manifest**'), /\*\*exactly 59\*\* lines\s+\| 60 475\s+\|$/);
  assert.match(row('**image-cohort JSON snapshot**'), /\*\*not\*\* a path list .*\| 4 KiB\s+\|$/);
  assert.match(kinds.body, /one path of 1–1024 UTF-8 bytes per line/);
  assert.match(kinds.body, /resolves against the manifest's own directory/);
  assert.match(kinds.body, /It is \*\*not\*\* evidence/);

  const nonClaims = subsections(section).find(({ heading }) => heading.startsWith('### 20.7 '));
  assert.ok(nonClaims, 'the non-claims subsection exists');
  for (const word of [
    'authentic',
    'retrievable',
    'from the authorized run',
    'fresh',
    'attempt `1`',
    'Branch A or B',
    'NO-GO',
  ]) {
    assert.ok(nonClaims.body.replace(/\s+/g, ' ').includes(word), word);
  }
  assert.match(nonClaims.body, /Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`, row 11\s+`UNVERIFIED`/);
});

test('card drift: wrong script, option, order, missing argument, swapped roles or package drift are all caught', () => {
  const text = runbookText();
  const pkg = packageJson();
  const replaceOnce = (source, from, to) => {
    const at = source.indexOf(from);
    assert.ok(at >= 0 && source.indexOf(from, at + 1) === -1, `unique anchor: ${from}`);
    return source.slice(0, at) + to + source.slice(at + from.length);
  };
  const recover =
    'pnpm run recover:aggregation-campaign-logs -- --output-dir <new-directory> --logs-manifest <job-log-manifest>';
  const compare =
    'pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest <artifacts-report-manifest> --fallback-manifest <fallback-report-manifest>';
  const account =
    'pnpm run account:aggregation-campaign -- --reports-manifest <selected-report-manifest>';
  const review =
    'pnpm run review:aggregation-campaign-image-cohort -- <image-cohort-manifest> --reports-manifest <selected-report-manifest>';

  const drifts = [
    [
      'wrong recovery script',
      recover,
      recover.replace('recover:aggregation-campaign-logs', 'recover:aggregation-campaign-log'),
      /wrong package script/,
    ],
    [
      'wrong accounting script',
      account,
      account.replace('account:aggregation-campaign', 'review:aggregation-campaign-image-cohort'),
      /wrong package script|placeholders differ/,
    ],
    [
      'misspelled logs option',
      recover,
      recover.replace('--logs-manifest', '--log-manifest'),
      /parser refuses/,
    ],
    [
      'inline manifest value',
      account,
      account.replace(
        '--reports-manifest <selected-report-manifest>',
        '--reports-manifest=<selected-report-manifest>',
      ),
      /neither option nor placeholder|placeholders differ/,
    ],
    [
      'recovery without --output-dir',
      recover,
      recover.replace('--output-dir <new-directory> ', ''),
      /placeholders differ/,
    ],
    [
      'recovery with an explicit log instead of a manifest',
      recover,
      recover.replace('--logs-manifest <job-log-manifest>', '<job-log-manifest>'),
      /not the manifest mode/,
    ],
    [
      'comparison missing its fallback manifest',
      compare,
      compare.replace(' --fallback-manifest <fallback-report-manifest>', ''),
      /placeholders differ/,
    ],
    [
      'comparison missing the fallback option',
      compare,
      compare.replace('--fallback-manifest ', ''),
      /parser refuses|not the manifest mode/,
    ],
    [
      'swapped comparison roles',
      compare,
      compare
        .replace('<artifacts-report-manifest>', '<TMP>')
        .replace('<fallback-report-manifest>', '<artifacts-report-manifest>')
        .replace('<TMP>', '<fallback-report-manifest>'),
      /is not in its role/,
    ],
    [
      'swapped comparison options',
      compare,
      compare
        .replace('--artifacts-manifest', '--TMP')
        .replace('--fallback-manifest', '--artifacts-manifest')
        .replace('--TMP', '--fallback-manifest'),
      /is not in its role/,
    ],
    [
      'review with the report manifest first',
      review,
      'pnpm run review:aggregation-campaign-image-cohort -- --reports-manifest <selected-report-manifest> <image-cohort-manifest>',
      /parser refuses/,
    ],
    [
      'review with swapped placeholders',
      review,
      review
        .replace('<image-cohort-manifest>', '<TMP>')
        .replace('<selected-report-manifest>', '<image-cohort-manifest>')
        .replace('<TMP>', '<selected-report-manifest>'),
      /is not in its role/,
    ],
    [
      'review using the job-log manifest',
      review,
      review.replace('<selected-report-manifest>', '<job-log-manifest>'),
      /placeholders differ/,
    ],
    [
      'accounting over explicit reports',
      account,
      'pnpm run account:aggregation-campaign -- <selected-report-manifest>',
      /not the manifest mode/,
    ],
    ['missing forwarded separator', account, account.replace(' -- ', ' '), /not forwarded/],
    [
      'npm instead of pnpm',
      account,
      account.replace('pnpm run', 'npm run'),
      /not a `pnpm run` command/,
    ],
    [
      'double space',
      account,
      account.replace(' --reports-manifest', '  --reports-manifest'),
      /empty token/,
    ],
  ];
  for (const [label, from, to, expected] of drifts) {
    const problems = checkCommandCard(replaceOnce(text, from, to), pkg);
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${label}: ${problems.join(' | ')}`,
    );
  }

  // Structural drift: order, missing or unmarked commands, a malformed block, no card at all.
  const recoverBlock = `<!-- command-card:L11-recover -->\n\n\`\`\`text\n${recover}\n\`\`\`\n`;
  const accountBlock = `<!-- command-card:L12-account -->\n\n\`\`\`text\n${account}\n\`\`\`\n`;
  const swapped = replaceOnce(
    replaceOnce(text, recoverBlock, '@@RECOVER@@'),
    accountBlock,
    recoverBlock,
  ).replace('@@RECOVER@@', accountBlock);
  assert.ok(
    checkCommandCard(swapped, pkg).includes(
      'marked commands are missing, extra or out of runbook order',
    ),
  );
  assert.ok(
    checkCommandCard(replaceOnce(text, recoverBlock, ''), pkg).includes(
      'marked commands are missing, extra or out of runbook order',
    ),
  );
  assert.ok(
    checkCommandCard(
      replaceOnce(
        text,
        '<!-- command-card:L12-account -->\n\n```text\n',
        '<!-- command-card:L12-account -->\n```text\n',
      ),
      pkg,
    ).includes('a command marker is not followed by one command'),
  );
  assert.deepEqual(checkCommandCard(text.replace(CARD_HEADING, '## 20. Something else'), pkg), [
    'card section is missing',
  ]);

  // Package drift: a script renamed, removed, or pointed at another file.
  for (const scripts of [
    {
      ...pkg.scripts,
      'recover:aggregation-campaign-logs': 'node scripts/aggregation-campaign-accounting.mjs',
    },
    Object.fromEntries(
      Object.entries(pkg.scripts).filter(
        ([name]) => name !== 'compare:aggregation-campaign-retrievals',
      ),
    ),
    {
      ...pkg.scripts,
      'account:aggregation-campaign': 'node scripts/aggregation-campaign-accounting.mjs --json',
    },
  ]) {
    const problems = checkCommandCard(text, { ...pkg, scripts });
    assert.ok(
      problems.some((problem) => /package script does not run the expected file/.test(problem)),
      problems.join(' | '),
    );
  }
});

test('card: the static test stays manual — outside pnpm verify, the test phases and ordinary CI; no workflow added', () => {
  const pkg = packageJson();
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.ok(!command.includes('command-card'), name);
  }
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/run-test-phases.mjs',
    'scripts/test-phases-lib.mjs',
    'scripts/check-test-phases.mjs',
  ]) {
    assert.ok(!readFileSync(join(repoRoot, file), 'utf8').includes('command-card'), file);
  }
  assert.deepEqual(readdirSync(join(repoRoot, '.github', 'workflows')), ['ci.yml']);
});
