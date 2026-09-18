/**
 * Static contract test of the ADR-055 L11–L13 operator command card
 * (launch-readiness § 20).
 *
 * The card is read as text. Its four marked commands are read with a small,
 * strict reader for their one fixed template grammar (bare tokens, and path
 * placeholders each enclosed in one pair of double quotes), not a shell parser.
 * They are checked against `package.json` and the exported argument parsers of
 * the four tools: the exact package script, the forwarded `--`, the manifest
 * option grammar, and which placeholder lands in which role, with absolute
 * replacement paths that contain spaces. Its pass and failure lines are checked
 * against the tools' own output text: formatters for the pass lines, and
 * in-process CLI runs with injected, failing reads for exit `1` and exit `2`.
 * Deliberate drift cases prove that the check fails when the card drifts.
 *
 * On Windows only, the exact quoted commands are also run through `cmd.exe`
 * with `pnpm`, over absolute paths with spaces in a test-owned temporary
 * directory that names no manifest that exists; each must stop at its manifest
 * contract (exit `2`), not at a usage error from a split argument. A package
 * manager preflight comes first: a `pnpm` that cmd.exe resolves is preferred;
 * otherwise the Corepack launcher next to the active Node executable is exposed
 * as a test-owned `pnpm.cmd` shim on a PATH prepended for child processes only.
 * Each spawn is checked for a runner failure (shell, timeout, unresolved pnpm,
 * script not started) with fixed sentences before its output is judged.
 *
 * Offline and manual: run it directly with `node --test`. It reads the runbook,
 * `package.json` and the CI and test-phase definitions. The in-process CLI runs
 * get injected reads that name no real file and write nothing. The Windows
 * shell run reads and writes nothing outside its own temporary directory, which
 * it removes, and prints no supplied path. Nothing calls a network, GitHub,
 * account or billing API. Nothing here is campaign evidence.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import process from 'node:process';
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

/** The four marked commands exactly as the card must give them. */
const CARD_COMMANDS = Object.freeze({
  recover:
    'pnpm run recover:aggregation-campaign-logs -- --output-dir "<new-directory>" --logs-manifest "<job-log-manifest>"',
  compare:
    'pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest "<artifacts-report-manifest>" --fallback-manifest "<fallback-report-manifest>"',
  account:
    'pnpm run account:aggregation-campaign -- --reports-manifest "<selected-report-manifest>"',
  review:
    'pnpm run review:aggregation-campaign-image-cohort -- "<image-cohort-manifest>" --reports-manifest "<selected-report-manifest>"',
});

const PLACEHOLDER = /^<[a-z][a-z-]*>$/;
const OPTION = /^--[a-z][a-z-]*$/;
/** A bare token of the template: program, verb, script, `--` or an option. */
const BARE = /^[A-Za-z0-9:_-]+$/;

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

/**
 * A distinct absolute value for each placeholder, containing spaces; `long`
 * makes each exactly 1024 UTF-8 bytes, the per-path limit of every tool.
 */
const valueFor = (placeholder, { long = false, platform = 'posix' } = {}) => {
  const name = placeholder.slice(1, -1);
  const base =
    platform === 'win32' ? `C:\\card operator\\${name} path` : `/card operator/${name} path`;
  return long ? `${base} ${'x'.repeat(MAX_PATH_BYTES - Buffer.byteLength(base) - 1)}` : base;
};

/**
 * Reads one command of the card's fixed template grammar into tokens. Tokens
 * are separated by exactly one space. A token is either bare (no quote
 * character) or one pair of double quotes around its text, followed by a space
 * or the end. There is no escaping and no other quoting: this reads the four
 * templates, it is not a shell parser. Returns `{ tokens, problems }`, where
 * each token is `{ text, quoted }` with the quotes removed.
 */
function readTemplate(command) {
  const tokens = [];
  let at = 0;
  while (at < command.length) {
    if (tokens.length > 0) {
      if (command[at] !== ' ') return { tokens, problems: ['tokens are not separated by a space'] };
      at += 1;
    }
    if (at === command.length || command[at] === ' ') {
      return { tokens, problems: ['empty token (repeated or edge space)'] };
    }
    if (command[at] === '"') {
      const close = command.indexOf('"', at + 1);
      if (close === -1) return { tokens, problems: ['unbalanced double quote'] };
      tokens.push({ text: command.slice(at + 1, close), quoted: true });
      at = close + 1;
      continue;
    }
    const space = command.indexOf(' ', at);
    const end = space === -1 ? command.length : space;
    const text = command.slice(at, end);
    if (text.includes('"')) return { tokens, problems: ['stray double quote in a bare token'] };
    tokens.push({ text, quoted: false });
    at = end;
  }
  return { tokens, problems: tokens.length === 0 ? ['empty command'] : [] };
}

/** The command line with every quoted placeholder's text replaced, quotes kept. */
const renderCommand = (tokens, valueOf) =>
  tokens.map(({ text, quoted }) => (quoted ? `"${valueOf(text)}"` : text)).join(' ');

/**
 * Checks one command line against its expected step. Returns problem strings,
 * empty when the command is exact.
 */
function checkCommand(step, command, pkg) {
  const problems = [];
  const fail = (problem) => problems.push(`${step.id}: ${problem}`);
  const { tokens, problems: syntax } = readTemplate(command);
  if (syntax.length > 0) {
    for (const problem of syntax) fail(problem);
    return problems;
  }
  for (const { text, quoted } of tokens) {
    if (quoted && !PLACEHOLDER.test(text)) fail('quoted text is not a single placeholder');
    if (!quoted && (text.includes('<') || text.includes('>'))) {
      fail('placeholder is not double-quoted');
    } else if (!quoted && !BARE.test(text)) {
      fail('bare token is outside the template grammar');
    }
  }
  const [program, verb, script, separator, ...args] = tokens;
  const bare = (token, value) => token !== undefined && !token.quoted && token.text === value;
  if (!bare(program, 'pnpm') || !bare(verb, 'run')) fail('not a `pnpm run` command');
  if (!bare(script, step.script)) fail('wrong package script');
  if (pkg.scripts?.[step.script] !== `node ${step.file}`) {
    fail('package script does not run the expected file');
  }
  if (!existsSync(join(repoRoot, step.file))) fail('script file does not exist');
  if (!bare(separator, '--')) fail('arguments are not forwarded after `--`');

  for (const { text, quoted } of args) {
    if (!quoted && !OPTION.test(text)) fail('argument is neither option nor quoted placeholder');
  }
  const used = args.filter(({ quoted }) => quoted).map(({ text }) => text);
  if (
    used.length !== step.placeholders.length ||
    [...used].sort().join() !== [...step.placeholders].sort().join()
  ) {
    fail('placeholders differ from the expected set, each exactly once');
  }
  if (problems.length > 0) return problems;

  for (const platform of ['posix', 'win32']) {
    for (const long of [false, true]) {
      const valueOf = (placeholder) => valueFor(placeholder, { long, platform });
      // The decoded placeholder is replaced; the quotes are shell syntax and never reach argv.
      const argv = args.map(({ text, quoted }) => (quoted ? valueOf(text) : text));
      // `pnpm run <script> -- …` forwards the separator itself.
      const parsed = step.parse(['--', ...argv], {
        platform,
        cwd: platform === 'win32' ? 'C:\\card caller' : '/card caller',
      });
      const label = `${platform}${long ? ' with 1024-byte paths' : ''}`;
      if (!parsed.ok) {
        fail(`parser refuses the command (${label}): ${parsed.output.split('\n')[0]}`);
        continue;
      }
      if (parsed.mode !== 'manifest') fail(`not the manifest mode (${label})`);
      const roles = step.roles(parsed);
      for (const placeholder of step.placeholders) {
        if (roles[placeholder] !== valueOf(placeholder)) {
          fail(`${placeholder} is not in its role (${label})`);
        }
      }
      if (long && renderCommand(tokens, valueOf).length >= CMD_EXE_LIMIT) {
        fail('longest command line reaches the cmd.exe limit');
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
    Object.values(CARD_COMMANDS),
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
  assert.match(rules.body, /\*\*Keep the double quotes\*\*/);
  assert.match(rules.body, /keep both\s+quotes, so a path that contains spaces stays one argument/);
  assert.match(rules.body, /The quotes are shell syntax, not part of\s+the path/);
  assert.match(rules.body, /Do not end a quoted path with `\\`/);
  assert.match(rules.body, /Lines\s+_inside_ a manifest are never quoted/);
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

test('card: path placeholders are decoded from their quotes and replaced by absolute paths with spaces, up to 1024 bytes', () => {
  const { commands } = markedCommands(cardSection(runbookText()));
  for (const { id, command } of commands) {
    const step = CARD_STEPS.find((candidate) => candidate.id === id);
    const { tokens, problems } = readTemplate(command);
    assert.deepEqual(problems, [], id);
    const quoted = tokens.filter((token) => token.quoted).map(({ text }) => text);
    assert.deepEqual([...quoted].sort(), [...step.placeholders].sort(), id);
    assert.ok(!tokens.some(({ text }) => text.includes('"')), `${id}: no quote survives decoding`);

    for (const platform of ['posix', 'win32']) {
      const api = platform === 'win32' ? win32 : posix;
      for (const long of [false, true]) {
        const valueOf = (placeholder) => valueFor(placeholder, { long, platform });
        for (const placeholder of step.placeholders) {
          const value = valueOf(placeholder);
          assert.ok(api.isAbsolute(value), `${id} ${placeholder} is absolute (${platform})`);
          assert.ok(value.includes(' '), `${id} ${placeholder} contains a space`);
          assert.ok(!value.includes('"') && !value.endsWith('\\'), `${id} ${placeholder}`);
          if (long) assert.equal(Buffer.byteLength(value), MAX_PATH_BYTES, `${id} ${placeholder}`);
        }
        const line = renderCommand(tokens, valueOf);
        assert.ok(line.length < CMD_EXE_LIMIT, `${id} stays below the cmd.exe limit (${platform})`);
        // Each value appears once, inside its quotes.
        for (const placeholder of step.placeholders) {
          assert.equal(
            line.split(`"${valueOf(placeholder)}"`).length - 1,
            1,
            `${id} ${placeholder}`,
          );
        }
      }
    }
  }
  // One more byte is refused by every parser that bounds a manifest path, so 1024 is the boundary.
  const over = (placeholder) => `${valueFor(placeholder, { long: true, platform: 'win32' })}x`;
  const refuse = [
    parseRecoveryArgs(['--', '--logs-manifest', over('<job-log-manifest>')], { platform: 'win32' }),
    parseAccountingArgs(['--', '--reports-manifest', over('<selected-report-manifest>')], {
      platform: 'win32',
    }),
    parseImageCohortArgs(
      ['--', 'C:\\snapshot.json', '--reports-manifest', over('<selected-report-manifest>')],
      { platform: 'win32' },
    ),
    parseComparisonArgs(
      [
        '--',
        '--artifacts-manifest',
        over('<artifacts-report-manifest>'),
        '--fallback-manifest',
        'C:\\f.list',
      ],
      { platform: 'win32' },
    ),
  ];
  for (const parsed of refuse) {
    assert.equal(parsed.exitCode, 2);
    assert.equal(parsed.output.split('\n')[0], 'path exceeds the path byte limit');
  }
});

test('runbook § 13: the recommended L11–L13 manifest commands quote their path placeholders like the card', () => {
  const text = runbookText();
  const start = text.indexOf('\n## 13. Launch runbook');
  const end = text.indexOf('\n## 14. ', start);
  assert.ok(start >= 0 && end > start, '§ 13 exists');
  const procedure = text.slice(start, end);
  for (const recommended of [
    '`pnpm run recover:aggregation-campaign-logs -- --output-dir "<new-directory>" --logs-manifest "<file>"`',
    '`pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest "<file>" --fallback-manifest "<file>"`',
    '`pnpm run account:aggregation-campaign -- --reports-manifest "<file>"`',
    '`pnpm run review:aggregation-campaign-image-cohort -- "<image-cohort-manifest>" --reports-manifest "<file>"`',
  ]) {
    assert.equal(procedure.split(recommended).length - 1, 1, recommended);
  }
  for (const unquoted of [
    '--output-dir <new-directory> --logs-manifest',
    '--logs-manifest <',
    '--artifacts-manifest <',
    '--fallback-manifest <',
    '--reports-manifest <',
  ]) {
    assert.ok(!procedure.includes(unquoted), unquoted);
  }
  assert.match(procedure, /every path placeholder is written in\s+double quotes/);
});

test('card drift: wrong script, option, order, missing argument, swapped roles or package drift are all caught', () => {
  const text = runbookText();
  const pkg = packageJson();
  const replaceOnce = (source, from, to) => {
    const at = source.indexOf(from);
    assert.ok(at >= 0 && source.indexOf(from, at + 1) === -1, `unique anchor: ${from}`);
    return source.slice(0, at) + to + source.slice(at + from.length);
  };
  const { recover, compare, account, review } = CARD_COMMANDS;

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
        '--reports-manifest "<selected-report-manifest>"',
        '--reports-manifest="<selected-report-manifest>"',
      ),
      /stray double quote/,
    ],
    [
      'recovery without --output-dir',
      recover,
      recover.replace('--output-dir "<new-directory>" ', ''),
      /placeholders differ/,
    ],
    [
      'recovery with an explicit log instead of a manifest',
      recover,
      recover.replace('--logs-manifest "<job-log-manifest>"', '"<job-log-manifest>"'),
      /not the manifest mode/,
    ],
    [
      'comparison missing its fallback manifest',
      compare,
      compare.replace(' --fallback-manifest "<fallback-report-manifest>"', ''),
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
      'pnpm run review:aggregation-campaign-image-cohort -- --reports-manifest "<selected-report-manifest>" "<image-cohort-manifest>"',
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
      'pnpm run account:aggregation-campaign -- "<selected-report-manifest>"',
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
    [
      'swapped recovery roles',
      recover,
      recover
        .replace('<new-directory>', '<TMP>')
        .replace('<job-log-manifest>', '<new-directory>')
        .replace('<TMP>', '<job-log-manifest>'),
      /is not in its role/,
    ],
    [
      'unquoted recovery output directory',
      recover,
      recover.replace('"<new-directory>"', '<new-directory>'),
      /placeholder is not double-quoted/,
    ],
    [
      'unquoted fallback manifest',
      compare,
      compare.replace('"<fallback-report-manifest>"', '<fallback-report-manifest>'),
      /placeholder is not double-quoted/,
    ],
    [
      'unquoted selected report manifest',
      account,
      account.replace('"<selected-report-manifest>"', '<selected-report-manifest>'),
      /placeholder is not double-quoted/,
    ],
    [
      'unquoted image-cohort snapshot',
      review,
      review.replace('"<image-cohort-manifest>"', '<image-cohort-manifest>'),
      /placeholder is not double-quoted/,
    ],
    [
      'single quotes instead of double quotes',
      account,
      account.replace('"<selected-report-manifest>"', "'<selected-report-manifest>'"),
      /placeholder is not double-quoted/,
    ],
    [
      'missing closing quote',
      account,
      account.replace('"<selected-report-manifest>"', '"<selected-report-manifest>'),
      /unbalanced double quote/,
    ],
    [
      'missing opening quote',
      compare,
      compare.replace('"<artifacts-report-manifest>"', '<artifacts-report-manifest>"'),
      /stray double quote/,
    ],
    [
      'quotes spanning an option',
      review,
      review.replace(
        '"<image-cohort-manifest>" --reports-manifest "<selected-report-manifest>"',
        '"<image-cohort-manifest> --reports-manifest" "<selected-report-manifest>"',
      ),
      /quoted text is not a single placeholder/,
    ],
    [
      'quote glued to the next token',
      recover,
      recover.replace('"<new-directory>" --logs-manifest', '"<new-directory>"--logs-manifest'),
      /not separated by a space/,
    ],
    [
      'quoted option',
      recover,
      recover.replace('--logs-manifest', '"--logs-manifest"'),
      /quoted text is not a single placeholder/,
    ],
    [
      'placeholder used twice',
      review,
      review.replace('"<image-cohort-manifest>"', '"<selected-report-manifest>"'),
      /placeholders differ from the expected set, each exactly once/,
    ],
  ];
  for (const [label, from, to, expected] of drifts) {
    const problems = checkCommandCard(replaceOnce(text, from, to), pkg);
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${label}: ${problems.join(' | ')}`,
    );
  }

  // The card as first written, with every placeholder unquoted: all four commands are rejected.
  const section = cardSection(text);
  const unquotedCard = text.replace(section, section.replaceAll('"<', '<').replaceAll('>"', '>'));
  const unquotedProblems = checkCommandCard(unquotedCard, pkg);
  for (const { id } of CARD_STEPS) {
    assert.ok(unquotedProblems.includes(`${id}: placeholder is not double-quoted`), id);
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

// ---------------------------------------------------------------------------
// The Windows shell boundary: the exact quoted commands through cmd.exe and pnpm

/** Every entry under `root`, relative and sorted, so an added or removed entry is seen. */
const listTree = (root) => readdirSync(root, { recursive: true }).map(String).sort();

/** The pnpm version `package.json` declares in `packageManager`. */
const declaredPnpmVersion = (pkg) => /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '')?.[1];

/** The one fixed failure when no usable pnpm exists; it names the prerequisite, never a path. */
const RUNNER_UNAVAILABLE =
  'runner boundary: no usable pnpm - neither `pnpm` resolved by cmd.exe nor the Corepack launcher of the active Node installation reports the pnpm version declared in package.json';

/** Fixed runner-boundary failures of one shell spawn; none of them carries output or a path. */
const RUNNER_FAILURE = Object.freeze({
  spawn: 'runner boundary: cmd.exe could not be started',
  stopped: 'runner boundary: the command timed out or was stopped by a signal',
  noStatus: 'runner boundary: the command ended without a numeric exit status',
  notFound: 'runner boundary: cmd.exe could not resolve pnpm',
  noScript: 'runner boundary: pnpm did not start the package script',
});

/** A launcher path this test will quote into a `.cmd` file: absolute, plain, and `corepack.cmd`. */
const PLAIN_LAUNCHER = /^[A-Za-z]:\\[A-Za-z0-9 _.()~\\-]+\\corepack\.cmd$/;

/**
 * The Corepack launcher installed next to the active Node executable, or
 * `null` when it is absent or its path is not plain enough to quote. Only
 * `process.execPath` is used: no caller supplies a runner path.
 */
const corepackLauncherFor = (execPath, exists) => {
  const launcher = win32.join(win32.dirname(execPath), 'corepack.cmd');
  return PLAIN_LAUNCHER.test(launcher) && exists(launcher) ? launcher : null;
};

/**
 * Chooses the package manager for the boundary run. A directly resolved pnpm
 * is preferred; otherwise the Corepack launcher. Each is usable only when its
 * probe reports exactly the declared version. Probes return trimmed version
 * text or `null`, and are injected so the choice is testable without the host.
 */
function selectPackageManager({ declaredVersion, probeDirect, corepackLauncher, probeCorepack }) {
  if (declaredVersion === undefined) return { ok: false, diagnostic: RUNNER_UNAVAILABLE };
  if (probeDirect() === declaredVersion) return { ok: true, kind: 'direct' };
  if (corepackLauncher !== null && probeCorepack(corepackLauncher) === declaredVersion) {
    return { ok: true, kind: 'corepack', launcher: corepackLauncher };
  }
  return { ok: false, diagnostic: RUNNER_UNAVAILABLE };
}

/**
 * The test-owned `pnpm.cmd`: one line that hands every argument, unchanged, to
 * `"<corepack.cmd>" pnpm`. No block, no `call`, so `%*` is expanded once and
 * the launcher's exit code is the shim's.
 */
const pnpmShimText = (launcher) => {
  assert.ok(PLAIN_LAUNCHER.test(launcher), 'the Corepack launcher path is plain');
  return `@"${launcher}" pnpm %*\r\n`;
};

/** A copy of `env` with `dir` prepended to its one PATH entry; `env` itself is untouched. */
const childEnvWithPathPrefix = (env, dir) => {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: env[key] ? `${dir};${env[key]}` : dir };
};

/**
 * Runs one full command line through the shell Node uses on Windows (`cmd.exe
 * /d /s /c`), from the repository root as the card's `pnpm run` expects, with
 * the given child environment. The output is returned to the caller only; it
 * is never printed, because pnpm echoes the forwarded arguments.
 */
const runThroughCmd = (command, env) =>
  spawnSync(command, { cwd: repoRoot, env, shell: true, encoding: 'utf8', timeout: 120_000 });

/** Trimmed stdout of a successful `--version` run, or `null`. */
const versionOf = (result) =>
  result.error === undefined && result.status === 0 ? result.stdout.trim() : null;

/**
 * Separates a runner failure from the tool's own result: `null` when cmd.exe
 * started, pnpm was found, and pnpm started the step's script file; otherwise
 * one fixed `RUNNER_FAILURE` sentence. stderr is only matched, never returned.
 */
function runnerFailure(result, scriptFile) {
  if (result.error !== undefined && result.error?.code !== 'ETIMEDOUT') return RUNNER_FAILURE.spawn;
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return RUNNER_FAILURE.stopped;
  if (typeof result.status !== 'number') return RUNNER_FAILURE.noStatus;
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (/is not recognized as an internal or external command/.test(stderr)) {
    return RUNNER_FAILURE.notFound;
  }
  // pnpm announces the script it starts on stderr as `$ node <file> <args>`.
  const started = stderr.split(/\r?\n/).some((line) => line.startsWith(`$ node ${scriptFile} `));
  return started ? null : RUNNER_FAILURE.noScript;
}

/**
 * Prepares the package manager, then, and only then, runs the commands `ids` name, in order.
 * `prepare` returns `selectPackageManager`'s result plus the child `env`;
 * `run(id, env)` launches one command. A failed preparation throws the fixed
 * diagnostic before any command is launched.
 */
function runAfterRunnerPreflight({ prepare, run, ids }) {
  const runner = prepare();
  if (!runner.ok) assert.fail(runner.diagnostic);
  return { runner, results: ids.map((id) => run(id, runner.env)) };
}

test('card runner resolution: direct pnpm is preferred, Corepack is the fallback, and an unusable runner fails first with a fixed diagnostic', () => {
  const declaredVersion = declaredPnpmVersion(packageJson());
  assert.equal(declaredVersion, '11.22.0', 'package.json declares the pnpm version');
  const launcher = 'C:\\Program Files\\nodejs\\corepack.cmd';

  const calls = [];
  const probe = (name, answer) => (argument) => {
    calls.push(name);
    if (argument !== undefined) assert.equal(argument, launcher);
    return answer;
  };
  assert.deepEqual(
    selectPackageManager({
      declaredVersion,
      probeDirect: probe('direct', declaredVersion),
      corepackLauncher: launcher,
      probeCorepack: probe('corepack', declaredVersion),
    }),
    { ok: true, kind: 'direct' },
  );
  assert.deepEqual(calls, ['direct'], 'a usable direct pnpm is not second-guessed');

  for (const directAnswer of [null, '10.0.0']) {
    calls.length = 0;
    assert.deepEqual(
      selectPackageManager({
        declaredVersion,
        probeDirect: probe('direct', directAnswer),
        corepackLauncher: launcher,
        probeCorepack: probe('corepack', declaredVersion),
      }),
      { ok: true, kind: 'corepack', launcher },
      `fallback when direct pnpm answers ${directAnswer}`,
    );
    assert.deepEqual(calls, ['direct', 'corepack']);
  }

  for (const [label, options] of [
    ['no launcher', { corepackLauncher: null, probeCorepack: probe('corepack', declaredVersion) }],
    ['launcher fails', { corepackLauncher: launcher, probeCorepack: probe('corepack', null) }],
    ['launcher wrong', { corepackLauncher: launcher, probeCorepack: probe('corepack', '9.9.9') }],
  ]) {
    assert.deepEqual(
      selectPackageManager({ declaredVersion, probeDirect: probe('direct', null), ...options }),
      { ok: false, diagnostic: RUNNER_UNAVAILABLE },
      label,
    );
  }
  assert.deepEqual(
    selectPackageManager({
      declaredVersion: undefined,
      probeDirect: probe('direct', '11.22.0'),
      corepackLauncher: launcher,
      probeCorepack: probe('corepack', '11.22.0'),
    }),
    { ok: false, diagnostic: RUNNER_UNAVAILABLE },
  );

  // The launcher comes only from the Node executable's own directory, and must be plain and present.
  const present = () => true;
  assert.equal(corepackLauncherFor('C:\\Program Files\\nodejs\\node.exe', present), launcher);
  assert.equal(
    corepackLauncherFor('C:\\Program Files\\nodejs\\node.exe', () => false),
    null,
  );
  assert.equal(corepackLauncherFor('C:\\odd%dir\\node.exe', present), null);
  assert.equal(corepackLauncherFor('C:\\odd"dir\\node.exe', present), null);
  assert.equal(corepackLauncherFor('C:\\a&b\\node.exe', present), null);

  // The shim is one quoted line that forwards every argument.
  assert.equal(pnpmShimText(launcher), '@"C:\\Program Files\\nodejs\\corepack.cmd" pnpm %*\r\n');
  assert.throws(() => pnpmShimText('C:\\odd%dir\\corepack.cmd'));

  // The child environment is a copy with only PATH prefixed, under its existing key.
  const env = Object.freeze({ Path: 'C:\\one;C:\\two', OTHER: 'kept' });
  assert.deepEqual(childEnvWithPathPrefix(env, 'C:\\shim dir'), {
    Path: 'C:\\shim dir;C:\\one;C:\\two',
    OTHER: 'kept',
  });
  assert.deepEqual(env, { Path: 'C:\\one;C:\\two', OTHER: 'kept' }, 'the source is untouched');

  // Runner failures are told apart from the tool's result, with fixed sentences only.
  const file = 'scripts/aggregation-campaign-accounting.mjs';
  const secret = 'C:\\Users\\someone\\secret dir\\selected reports.list';
  const started = `$ node ${file} "--" "--reports-manifest" "${secret}"\n`;
  const outcomes = [
    [{ error: new Error(secret), status: null, signal: null }, RUNNER_FAILURE.spawn],
    [
      {
        error: Object.assign(new Error(secret), { code: 'ETIMEDOUT' }),
        status: null,
        signal: 'SIGTERM',
      },
      RUNNER_FAILURE.stopped,
    ],
    [{ status: null, signal: 'SIGKILL', stderr: started }, RUNNER_FAILURE.stopped],
    [{ status: null, signal: null, stderr: started }, RUNNER_FAILURE.noStatus],
    [
      {
        status: 1,
        signal: null,
        stderr: "'pnpm' is not recognized as an internal or external command,\r\n",
      },
      RUNNER_FAILURE.notFound,
    ],
    [{ status: 1, signal: null, stderr: `Usage Error: ${secret}\n` }, RUNNER_FAILURE.noScript],
    [
      {
        status: 1,
        signal: null,
        stderr: '$ node scripts/aggregation-campaign-image-cohort.mjs x\n',
      },
      RUNNER_FAILURE.noScript,
    ],
    [{ status: 2, signal: null, stdout: '', stderr: started }, null],
  ];
  for (const [result, expected] of outcomes) {
    const failure = runnerFailure(result, file);
    assert.equal(failure, expected);
    assert.ok(failure === null || !failure.includes('secret'), 'no supplied text is echoed');
  }

  // An unusable runner stops before any command is launched, with the fixed diagnostic only.
  const launched = [];
  assert.throws(
    () =>
      runAfterRunnerPreflight({
        prepare: () => ({
          ...selectPackageManager({
            declaredVersion,
            probeDirect: () => null,
            corepackLauncher: null,
            probeCorepack: () => null,
          }),
          env: { PATH: secret },
        }),
        run: (id) => launched.push(id),
        ids: CARD_STEPS.map(({ id }) => id),
      }),
    (error) => error instanceof assert.AssertionError && error.message === RUNNER_UNAVAILABLE,
  );
  assert.deepEqual(launched, [], 'no card command was launched');
  assert.ok(!RUNNER_UNAVAILABLE.includes(':\\'), 'the diagnostic names no path');
});

test(
  'card runner resolution (Windows cmd.exe): the test-owned pnpm.cmd shim forwards the exact pnpm run arguments to its launcher',
  { skip: process.platform !== 'win32' && 'the cmd.exe boundary exists only on Windows' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'adr-055 runner shim '));
    try {
      assert.match(root, /^[A-Za-z]:\\[A-Za-z0-9 _.~\\-]+$/, 'the temporary root is plain');
      // A stand-in launcher named corepack.cmd that only reports the arguments it received.
      assert.match(process.execPath, /^[A-Za-z]:\\[A-Za-z0-9 _.()~\\-]+\\node\.exe$/i);
      const launcherDir = join(root, 'launcher');
      const shimDir = join(root, 'shim');
      mkdirSync(launcherDir);
      mkdirSync(shimDir);
      const capture = join(launcherDir, 'capture.mjs');
      writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const launcher = join(launcherDir, 'corepack.cmd');
      writeFileSync(launcher, `@"${process.execPath}" "${capture}" %*\r\n`);
      writeFileSync(join(shimDir, 'pnpm.cmd'), pnpmShimText(launcher));

      const card = CARD_COMMANDS.recover;
      const { tokens } = readTemplate(card);
      const values = {
        '<new-directory>': join(root, 'operator inputs', 'recovered reports'),
        '<job-log-manifest>': join(root, 'operator inputs', 'job logs.list'),
      };
      const command = renderCommand(tokens, (placeholder) => values[placeholder]);
      assert.ok(!/[<>|&^%]/.test(command), 'no cmd.exe metacharacter remains');

      const result = runThroughCmd(command, childEnvWithPathPrefix(process.env, shimDir));
      assert.equal(result.error, undefined, 'cmd.exe started');
      assert.equal(result.status, 0, 'the stand-in launcher ran through the shim');
      assert.deepEqual(
        JSON.parse(result.stdout),
        [
          'pnpm',
          'run',
          'recover:aggregation-campaign-logs',
          '--',
          '--output-dir',
          values['<new-directory>'],
          '--logs-manifest',
          values['<job-log-manifest>'],
        ],
        'the shim forwards every argument unchanged, each path whole and without quotes',
      );
      assert.ok(!existsSync(join(root, 'operator inputs')), 'nothing was created');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'card (Windows cmd.exe boundary): the exact quoted commands keep absolute paths with spaces whole and stop at each manifest contract, exit 2; recovery writes nothing',
  { skip: process.platform !== 'win32' && 'the cmd.exe boundary exists only on Windows' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'adr-055 command card '));
    try {
      // Only characters cmd.exe gives no meaning, so the only quoting in play is the card's.
      assert.match(root, /^[A-Za-z]:\\[A-Za-z0-9 _.~\\-]+$/, 'the temporary root is plain');
      const inputs = join(root, 'operator inputs');
      mkdirSync(inputs);
      // Nothing is created at any of these paths: every manifest is missing on purpose.
      const values = {
        '<new-directory>': join(inputs, 'recovered reports'),
        '<job-log-manifest>': join(inputs, 'job logs.list'),
        '<artifacts-report-manifest>': join(inputs, 'artifact reports.list'),
        '<fallback-report-manifest>': join(inputs, 'fallback reports.list'),
        '<selected-report-manifest>': join(inputs, 'selected reports.list'),
        '<image-cohort-manifest>': join(inputs, 'image cohort.json'),
      };
      const unreadable = PATH_MANIFEST_PROBLEM.unreadable;
      const expectedFirstLine = {
        'L11-recover': `logs manifest: ${unreadable}`,
        'L11-compare': `artifacts manifest: ${unreadable}`,
        'L12-account': `reports manifest: ${unreadable}`,
        'L13-review': `reports manifest: ${unreadable}`,
      };

      // Only a card that passes the static check is run: a bare `<…>` would be cmd.exe redirection.
      const text = runbookText();
      const pkg = packageJson();
      assert.deepEqual(checkCommandCard(text, pkg), [], 'the card passes the static check');
      const { commands } = markedCommands(cardSection(text));
      assert.equal(commands.length, CARD_STEPS.length);
      const rendered = {};
      for (const { id, command } of commands) {
        const { tokens, problems } = readTemplate(command);
        assert.deepEqual(problems, [], id);
        rendered[id] = renderCommand(tokens, (placeholder) => values[placeholder]);
        assert.ok(!/[<>|&^%]/.test(rendered[id]), `${id}: no cmd.exe metacharacter remains`);
        assert.ok(rendered[id].length < CMD_EXE_LIMIT, id);
      }
      const fileOf = (id) => CARD_STEPS.find((step) => step.id === id).file;

      /** The command's result, after proving the runner, not the card, decided nothing. */
      const runCard = (id, env, command = rendered[id]) => {
        const result = runThroughCmd(command, env);
        assert.equal(runnerFailure(result, fileOf(id)), null, `${id}: runner boundary`);
        return { status: result.status, firstLine: result.stdout.split(/\r?\n/)[0] };
      };

      // Package-manager preflight, before any card command.
      const { runner, results } = runAfterRunnerPreflight({
        prepare: () => {
          const declaredVersion = declaredPnpmVersion(pkg);
          const env = { ...process.env };
          const selected = selectPackageManager({
            declaredVersion,
            probeDirect: () => versionOf(runThroughCmd('pnpm --version', env)),
            corepackLauncher: corepackLauncherFor(process.execPath, existsSync),
            probeCorepack: (launcher) =>
              versionOf(runThroughCmd(`"${launcher}" pnpm --version`, env)),
          });
          if (!selected.ok || selected.kind === 'direct') return { ...selected, env };
          const shimDir = join(root, 'pnpm shim');
          mkdirSync(shimDir);
          writeFileSync(join(shimDir, 'pnpm.cmd'), pnpmShimText(selected.launcher));
          const shimmed = childEnvWithPathPrefix(env, shimDir);
          // The shim itself must answer as pnpm through cmd.exe, exactly as the card calls it.
          if (versionOf(runThroughCmd('pnpm --version', shimmed)) !== declaredVersion) {
            return { ok: false, diagnostic: RUNNER_UNAVAILABLE };
          }
          return { ...selected, env: shimmed };
        },
        run: (id, env) => runCard(id, env),
        ids: commands.map(({ id }) => id),
      });
      t.diagnostic(`package manager: ${runner.kind}`);
      const fixtures =
        runner.kind === 'corepack'
          ? ['operator inputs', 'pnpm shim', join('pnpm shim', 'pnpm.cmd')].sort()
          : ['operator inputs'];
      assert.deepEqual(listTree(root), fixtures, 'only the test fixtures exist');

      commands.forEach(({ id }, index) => {
        const { status, firstLine } = results[index];
        // The tool's fixed sentence names no path; anything else is withheld from the message.
        const shown = Object.values(values).some((value) => firstLine.includes(value))
          ? '<withheld>'
          : firstLine;
        assert.equal(shown, expectedFirstLine[id], `${id}: reached its manifest contract`);
        assert.equal(status, 2, `${id}: manifest-contract exit`);
      });
      assert.deepEqual(listTree(root), fixtures, 'the card commands wrote nothing');
      assert.ok(!existsSync(values['<new-directory>']), 'no output directory was created');

      // Controls: the same boundary visibly misreads the command when the card's rule is broken.
      const unquoted = runCard(
        'L12-account',
        runner.env,
        rendered['L12-account'].replaceAll('"', ''),
      );
      assert.notEqual(
        unquoted.firstLine,
        expectedFirstLine['L12-account'],
        'an unquoted path with spaces is split before the tool sees it',
      );
      const trailing = runCard(
        'L13-review',
        runner.env,
        rendered['L13-review'].replace(`"${values['<image-cohort-manifest>']}"`, `"${inputs}\\"`),
      );
      assert.notEqual(
        trailing.firstLine,
        expectedFirstLine['L13-review'],
        'a backslash before the closing quote swallows the rest of the command',
      );
      assert.deepEqual(listTree(root), fixtures, 'the controls wrote nothing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
