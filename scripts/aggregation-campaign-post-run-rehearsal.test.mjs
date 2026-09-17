/**
 * Synthetic end-to-end rehearsal of the ADR-055 post-run fallback path
 * (launch-readiness runbook § 13, L11 → L13), run over the real package
 * commands in their documented order:
 *
 *   1. `recover:aggregation-campaign-logs -- --output-dir <new-directory> --logs-manifest <file>`
 *   2. `compare:aggregation-campaign-retrievals -- --artifacts-manifest <file> --fallback-manifest <file>`
 *   3. `account:aggregation-campaign -- --reports-manifest <file>`
 *   4. `review:aggregation-campaign-image-cohort -- <review-manifest> --reports-manifest <file>`
 *
 * Step 1 runs through `pnpm run` itself, so on Windows its arguments pass
 * through `cmd.exe`; the 59 long job-log paths reach it only via the manifest.
 * Steps 2–4 spawn `node` with the script path read from `package.json`.
 *
 * It proves only that the committed tools compose: each step's output is the
 * next step's input, the handoffs carry exactly the intended 59 files, and the
 * chain stops at the first failed prerequisite. Everything is **synthetic**:
 * reports are rendered by the real harness code from invented summaries, the
 * job logs are invented framing, and the review manifest's release names,
 * dates and commit are invented test values. Nothing here is campaign
 * evidence, and nothing establishes authorization, billing, concurrency,
 * queueing, retrievability, provenance, freshness or attempt number.
 *
 * Manual and outside every gate: run it directly with `node --test`. Nothing
 * needs Docker, PostgreSQL, GitHub or the network; every file lives under one
 * temporary root created here and removed in `finally`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT, parseSlotReport } from './aggregation-campaign-accounting-lib.mjs';
import { COHORT_MANIFEST_SCHEMA } from './aggregation-campaign-image-cohort-lib.mjs';
import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import {
  REPORT_MANIFEST_PROBLEM,
  parsePathManifest,
  parseReportManifest,
} from './aggregation-campaign-report-manifest-lib.mjs';
import {
  LAUNCHER,
  PROCESS_OUTCOME,
  calibrationProbeId,
  calibrationStressId,
  formatCalibrationReport,
  sealProbeOutcome,
  summarizeCalibration,
  summarizeJestRun,
} from './aggregation-evidence-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const CMD_EXE_LIMIT = 8191;
const TEMP_PREFIX = 'adr-055-post-run-rehearsal-';

/** The four operational package scripts, in rehearsal order, with their exact commands. */
const OPERATIONAL_SCRIPTS = Object.freeze({
  recover: [
    'recover:aggregation-campaign-logs',
    'node scripts/aggregation-campaign-log-recovery.mjs',
  ],
  compare: [
    'compare:aggregation-campaign-retrievals',
    'node scripts/aggregation-campaign-retrieval-comparison.mjs',
  ],
  account: ['account:aggregation-campaign', 'node scripts/aggregation-campaign-accounting.mjs'],
  review: [
    'review:aggregation-campaign-image-cohort',
    'node scripts/aggregation-campaign-image-cohort.mjs',
  ],
});

/** The script file a package command runs, read from `package.json` itself. */
const scriptOf = (step) => {
  const [name] = OPERATIONAL_SCRIPTS[step];
  const [program, script, ...rest] = pkg.scripts[name].split(' ');
  assert.equal(program, 'node', name);
  assert.deepEqual(rest, [], name);
  return join(repoRoot, script);
};

/**
 * `pnpm --silent run <package script> -- <args>`, spawned from `cwd`. `--dir`
 * names the repository, so the script itself runs there, where neither the
 * caller's nor the repository's directory resolves a manifest line.
 */
const spawnPackageScript = (step, args, cwd) => {
  const [name] = OPERATIONAL_SCRIPTS[step];
  const argv = ['--dir', repoRoot, '--silent', 'run', name, '--', ...args];
  const options = { cwd, encoding: 'utf8', timeout: 120_000 };
  if (process.platform !== 'win32') return spawnSync('pnpm', argv, options);
  // pnpm is a .cmd shim on Windows and runs through cmd.exe: only arguments that need no quoting
  // are passed, and the whole command line stays far below the limit.
  for (const arg of argv) assert.match(arg, /^[\w:\\/.~-]+$/, 'argument needs no cmd.exe quoting');
  const command = ['pnpm', ...argv].join(' ');
  assert.ok(command.length < 1024, 'the pnpm command line is short');
  return spawnSync(command, { ...options, shell: true });
};

// ---------------------------------------------------------------------------
// Synthetic reports, rendered by the real harness code

const COMMIT = 'c'.repeat(40);
const OTHER_COMMIT = 'e'.repeat(40);
const TOPOLOGY = Object.freeze({
  runner_os: '"Ubuntu 24.04.5 LTS"',
  runner_image: 'ubuntu24/20260907.300.1',
  kernel: '6.17.0-1022-azure',
  cpus: 4,
  memory_gib: '15.6',
  docker_storage_driver: 'overlay2',
  postgres_image: 'postgis/postgis:16-3.4',
  server_version: '16.4 (Debian 16.4-1.pgdg110+2)',
  fsync: 'on',
  synchronous_commit: 'on',
  wal_level: 'replica',
  wal_sync_method: 'fdatasync',
  full_page_writes: 'on',
  shared_buffers: '128MB',
  max_connections: '100',
  max_wal_size: '1GB',
  checkpoint_timeout: '5min',
});
const DRIFTED_IMAGE = 'ubuntu24/20260914.310.1';

const jestReport = (messages) => {
  const failed = messages.length;
  return {
    numTotalTests: 22,
    numPassedTests: 22 - failed,
    numFailedTests: failed,
    numTotalTestSuites: 1,
    numPassedTestSuites: failed === 0 ? 1 : 0,
    numFailedTestSuites: failed === 0 ? 0 : 1,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    success: failed === 0,
    testResults: [
      {
        status: failed === 0 ? 'passed' : 'failed',
        assertionResults: [
          ...messages.map((message) => ({ status: 'failed', failureMessages: [message] })),
          ...Array.from({ length: 22 - failed }, () => ({ status: 'passed' })),
        ],
      },
    ],
  };
};

const WAL = { walSync: 100, walRecords: 200, walWrite: 100, walBytes: 1000 };
const summaryFor = (messages) => {
  const control = sealProbeOutcome({ problems: [], diagnostics: [] });
  const probe = sealProbeOutcome({
    transactions: 12000,
    failed: 0,
    tps: 200,
    latencyAverageMs: 5,
    walSyncDelta: 12000,
    walSyncPerSecond: 200,
    walSyncPerTransaction: 1.0,
    walRecordsPerTransaction: 2.0,
    minIntervalTps: 30,
    zeroCommitIntervals: 0,
    longestZeroCommitSeconds: 0,
    problems: [],
    diagnostics: [],
  });
  const stress = summarizeJestRun({
    step: { id: calibrationStressId(1), kind: 'jest-full' },
    result: {
      launcher: LAUNCHER.pnpm,
      outcome: PROCESS_OUTCOME.completed,
      exitCode: messages.length === 0 ? 0 : 1,
      startedAt: new Date('2026-09-16T00:00:00.000Z'),
      endedAt: new Date('2026-09-16T00:02:15.000Z'),
    },
    report: jestReport(messages),
    walBefore: WAL,
    walAfter: { ...WAL, walSync: 700 },
    samples: null,
  });
  return summarizeCalibration({
    pairs: 1,
    results: [
      { id: 'control', passed: control.valid, probe: control, diagnostics: control.diagnostics },
      { id: calibrationProbeId(1), passed: probe.valid, probe, diagnostics: probe.diagnostics },
      stress,
    ],
  });
};

const MESSAGES = Object.freeze({
  pass: [],
  event: ['error: canceling statement due to statement timeout'],
  product: ['    > 212 |       expect(rows).toHaveLength(1);'],
});

const reportText = (slot, { kind = 'pass', topology = TOPOLOGY } = {}) =>
  formatCalibrationReport({
    meta: {
      commit: COMMIT,
      generatedAt: `2026-09-16T01:00:${String(slot % 60).padStart(2, '0')}.000Z`,
      campaignSlot: slot,
    },
    topology,
    summary: summaryFor(MESSAGES[kind]),
  });

/** One synthetic environment-only event, so the chain carries a red job, not only passes. */
const EVENT_SLOT = 11;
const campaignTexts = (overrides = {}) =>
  Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, index) => {
    const slot = index + 1;
    return reportText(slot, overrides[slot] ?? (slot === EVENT_SLOT ? { kind: 'event' } : {}));
  });

// ---------------------------------------------------------------------------
// Synthetic job-log framing (the accepted plain-LF and timestamp-prefixed CRLF forms)

const stamp = (index) =>
  `2026-09-16T02:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(
    index % 60,
  ).padStart(2, '0')}.${String(1234567 + index).slice(-7)}Z `;

function jobLog(text, { slot, prefixed, crlf, red }) {
  const lines = [
    '##[group]Run pnpm run calibrate:aggregation-stress -- --pairs 1 --slot "$SLOT"',
    `${ESC}[36;1mpnpm run calibrate:aggregation-stress${ESC}[0m`,
    '##[endgroup]',
    `[evidence] calibration: 1 pair(s); slot ${slot}; No threshold is applied.`,
    '',
    ...text.slice(0, -1).split('\n'),
    `campaign_exit=${red ? 1 : 0}`,
    ...(red ? ['##[error]Process completed with exit code 1.'] : []),
    'Post job cleanup.',
  ];
  const eol = crlf ? `${CR}\n` : '\n';
  return lines.map((line, index) => (prefixed ? stamp(index) : '') + line + eol).join('');
}

/** Deterministic permutation, so every "shuffled" order is reproducible. */
const shuffled = (items, seed) => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** A name number that is never the slot inside: slot s is filed under (s + 17) mod 59 + 1. */
const misleading = (slot) => String(((slot + 17) % CAMPAIGN_SLOT_COUNT) + 1).padStart(2, '0');
const long = (label) => `${label}-${'long-directory-segment-'.repeat(6)}`.slice(0, 110);
const manifestOf = (lines) => lines.map((line) => `${line}\n`).join('');

// ---------------------------------------------------------------------------
// The temporary campaign: logs, an independently created artifact cohort, manifests

/**
 * Creates the whole synthetic post-run state under one new temporary root.
 * `texts` are the reports the jobs "printed"; `artifactBytes` may alter the
 * independently written artifact copy of one slot; `mutateManifests` may
 * replace a manifest's bytes; `reviewCommit` is the review manifest's commit.
 */
function createCampaign({
  texts = campaignTexts(),
  artifactBytes = (slot, bytes) => bytes,
  reviewCommit = COMMIT,
  manifestOverrides = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const dirs = {
    // Long enough that 59 job-log paths passed one by one would overflow cmd.exe.
    logs: join(root, long('private-job-logs')),
    artifacts: join(root, long('private-downloaded-artifacts')),
    manifests: join(root, 'private-manifests'),
    selection: join(root, 'private-selection'),
    // One level deeper than the manifests, so resolving a relative line against the caller's
    // working directory instead of the manifest's own directory would name different files.
    caller: join(root, 'private-caller', 'nested'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const recoveredName = long('private-recovered-fallback');
  const recovered = join(root, recoveredName);

  const logPaths = [];
  const artifactPaths = [];
  const recoveredPaths = [];
  texts.forEach((text, index) => {
    const slot = index + 1;
    const log = join(dirs.logs, `job-${misleading(slot)}.log`);
    writeFileSync(
      log,
      jobLog(text, {
        slot,
        prefixed: slot % 2 === 0,
        crlf: slot % 3 === 0,
        red: slot === EVENT_SLOT,
      }),
    );
    logPaths.push(log);
    const artifact = join(dirs.artifacts, `slot-${misleading(slot)}-private-artifact.txt`);
    writeFileSync(artifact, artifactBytes(slot, Buffer.from(text, 'utf8')));
    artifactPaths.push(artifact);
    recoveredPaths.push(join(recovered, `slot-${String(slot).padStart(2, '0')}.txt`));
  });

  // Four manifests, four orders, absolute and relative lines. The job logs are listed for recovery;
  // the selected cohort (accounting and review) is the recovered one, listed again from another
  // directory.
  const manifests = {
    logs: join(dirs.manifests, 'logs-private.list'),
    artifacts: join(dirs.manifests, 'artifacts-private.list'),
    fallback: join(dirs.manifests, 'fallback-private.list'),
    selected: join(dirs.selection, 'selected-private.list'),
  };
  const bodies = {
    logs: manifestOf(
      shuffled(logPaths, 5).map((path) => relative(dirs.manifests, path).split(sep).join('/')),
    ),
    artifacts: manifestOf(
      shuffled(artifactPaths, 17).map((path) =>
        relative(dirs.manifests, path).split(sep).join('/'),
      ),
    ),
    fallback: manifestOf(shuffled(recoveredPaths, 29)),
    selected: manifestOf(
      shuffled(recoveredPaths, 43).map((path) =>
        relative(dirs.selection, path).split(sep).join('/'),
      ),
    ),
  };
  for (const [name, path] of Object.entries(manifests)) {
    writeFileSync(path, manifestOverrides[name]?.(bodies[name]) ?? bodies[name]);
  }

  // A spawned command reads the real clock, so the synthetic snapshot is safely in the past.
  const review = join(dirs.manifests, 'review-private.json');
  writeFileSync(
    review,
    `${JSON.stringify(
      {
        schema: COHORT_MANIFEST_SCHEMA,
        observed_at: '2026-01-15T00:00:00Z',
        runner_label: 'ubuntu-24.04',
        current_image_release: 'ubuntu24/20260112.100',
        current_image_published_at: '2026-01-13T00:00:00Z',
        previous_image_release: 'ubuntu24/20260105.90',
        previous_image_published_at: '2026-01-06T00:00:00Z',
        branch_c_on_topology_mismatch_acknowledged: true,
        campaign_commit: reviewCommit,
      },
      null,
      2,
    )}\n`,
  );

  return {
    root,
    dirs,
    recovered,
    recoveredName,
    logPaths,
    artifactPaths,
    recoveredPaths,
    manifests,
    review,
  };
}

/** Removes only a root this file created: a direct child of the temp directory with our prefix. */
function removeCampaign(campaign) {
  if (!campaign) return;
  const { root } = campaign;
  assert.equal(dirname(root), resolve(tmpdir()), 'only a direct child of the temp directory');
  assert.ok(basename(root).startsWith(TEMP_PREFIX), 'only a root this rehearsal created');
  assert.ok(!resolve(root).startsWith(repoRoot), 'never inside the repository');
  rmSync(root, { recursive: true, force: true });
}

const withCampaign = (options, body) => {
  let campaign;
  try {
    campaign = createCampaign(options);
    return body(campaign);
  } finally {
    removeCampaign(campaign);
  }
};

// ---------------------------------------------------------------------------
// Snapshots: relative name, entry type, byte length, mtime and SHA-256

function snapshotTree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const stats = lstatSync(full);
      if (stats.isDirectory()) {
        entries.set(rel, { type: 'dir', mtimeMs: stats.mtimeMs });
        walk(full);
      } else if (stats.isFile()) {
        const bytes = readFileSync(full);
        entries.set(rel, {
          type: 'file',
          size: bytes.length,
          mtimeMs: stats.mtimeMs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else {
        entries.set(rel, { type: 'other' });
      }
    }
  };
  walk(root);
  return entries;
}

/** Every added, removed or changed relative name between two snapshots. */
function diffTrees(before, after) {
  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const changed = [...after.keys()]
    .filter(
      (name) =>
        before.has(name) && JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
    )
    .sort();
  return { added, removed, changed };
}

const NO_CHANGE = Object.freeze({ added: [], removed: [], changed: [] });

// ---------------------------------------------------------------------------
// The rehearsal: the documented order, stopping at the first failed prerequisite

/** Each step's success condition is exactly the runbook's; anything else stops the chain. */
function rehearsalPlan(campaign) {
  return [
    {
      step: 'recover',
      viaPnpm: true,
      args: ['--output-dir', campaign.recovered, '--logs-manifest', campaign.manifests.logs],
      passed: (r) => r.status === 0 && /\nRESULT: PASS\n$/.test(r.stdout),
    },
    {
      step: 'compare',
      args: [
        '--',
        '--artifacts-manifest',
        campaign.manifests.artifacts,
        '--fallback-manifest',
        campaign.manifests.fallback,
      ],
      passed: (r) => r.status === 0 && /^COMPARISON: MATCH$/m.test(r.stdout),
    },
    {
      step: 'account',
      args: ['--', '--reports-manifest', campaign.manifests.selected],
      passed: (r) => r.status === 0 && /^accounting: COMPLETE - /m.test(r.stdout),
    },
    {
      step: 'review',
      args: ['--', campaign.review, '--reports-manifest', campaign.manifests.selected],
      passed: (r) => r.status === 0 && /^COHORT: CONSISTENT$/m.test(r.stdout),
    },
  ];
}

/** Runs the plan through spawned package-script commands; stops after the first failed step. */
function rehearse(campaign) {
  const initial = snapshotTree(campaign.root);
  let before = initial;
  const steps = [];
  for (const { step, viaPnpm, args, passed } of rehearsalPlan(campaign)) {
    const result = viaPnpm
      ? spawnPackageScript(step, args, campaign.dirs.caller)
      : spawnSync(process.execPath, [scriptOf(step), ...args], {
          cwd: campaign.dirs.caller,
          encoding: 'utf8',
          timeout: 120_000,
        });
    const after = snapshotTree(campaign.root);
    const record = {
      step,
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      changes: diffTrees(before, after),
      passed: passed(result),
    };
    steps.push(record);
    before = after;
    if (!record.passed) break;
  }
  return { initial, final: before, steps, names: steps.map((record) => record.step) };
}

/** No step prints a path, marker, report content, log framing or OS error. */
function assertNoLeak(campaign, record) {
  assert.equal(record.stderr, '', `${record.step}: nothing on stderr`);
  const forbidden = [
    campaign.root,
    basename(campaign.root),
    'private',
    'long-directory-segment',
    '.list',
    '.json',
    '.log',
    'artifact.txt',
    // Report content and log framing.
    '2026-09-16T01:00:',
    '2026-09-16T02:',
    'campaign_slot=',
    'topology: ',
    'generated=',
    TOPOLOGY.kernel,
    TOPOLOGY.runner_image,
    DRIFTED_IMAGE,
    'ubuntu24/',
    'canceling statement',
    'toHaveLength',
    '##[',
    ESC,
    CR,
    // Operating-system error detail.
    'ENOENT',
    'EACCES',
    'EPERM',
    'EEXIST',
    'Error:',
    '    at ',
  ];
  for (const value of forbidden) {
    assert.ok(
      !record.stdout.includes(value),
      `${record.step}: output leaks ${JSON.stringify(value)}`,
    );
  }
}

const quotedLength = (paths) => paths.reduce((total, path) => total + path.length + 3, 0);
const slotOfFile = (path) => {
  const parsed = parseSlotReport(readFileSync(path, 'utf8'));
  assert.equal(parsed.ok, true, 'every handed-off file is a parseable report');
  return parsed.report.slot;
};
const firstLine = (text) => text.split('\n')[0];

// ---------------------------------------------------------------------------
// The complete chain

test('rehearsal: the fallback path composes end to end through manifests; outcomes, handoffs, writes and output are exact', () => {
  withCampaign({}, (campaign) => {
    // The framing covers both accepted log forms, and 59 explicit report paths per cohort would
    // exceed the cmd.exe limit, so comparator, accounting and review are reached only by manifest.
    const logs = campaign.logPaths.map((path) => readFileSync(path, 'utf8'));
    assert.ok(logs.some((text) => !text.includes(CR) && !text.startsWith('2026-')));
    assert.ok(logs.some((text) => text.includes(`${CR}\n`) && text.startsWith('2026-09-16T02:')));
    // Recovery, spawned through `pnpm run`, receives its 59 long job logs only by manifest too.
    assert.ok(quotedLength(campaign.logPaths) > CMD_EXE_LIMIT);
    assert.ok(quotedLength(campaign.artifactPaths) > CMD_EXE_LIMIT);
    assert.ok(quotedLength(campaign.recoveredPaths) > CMD_EXE_LIMIT);
    for (const path of [
      ...campaign.logPaths,
      ...campaign.artifactPaths,
      ...campaign.recoveredPaths,
    ]) {
      assert.ok(path.length < 250, 'each path stays under classic MAX_PATH');
      assert.ok(Buffer.byteLength(path) <= 1024, 'each path is within the manifest entry bound');
    }
    assert.equal(
      pkg.scripts['recover:aggregation-campaign-logs'],
      'node scripts/aggregation-campaign-log-recovery.mjs',
      'recovery runs the unchanged operational package script',
    );

    const run = rehearse(campaign);
    assert.deepEqual(run.names, ['recover', 'compare', 'account', 'review']);
    assert.ok(run.steps.every((record) => record.passed));
    const [recover, compare, account, review] = run.steps;
    for (const record of run.steps) assertNoLeak(campaign, record);

    // 1. Recovery: exit 0, PASS, and exactly one new directory holding exactly 59 reports.
    assert.equal(recover.status, 0);
    assert.match(
      recover.stdout,
      /^recovery: logs=59 readable_logs=59 recovered_reports=59 rejections=0$/m,
    );
    assert.match(recover.stdout, /^totals: non-events=58 events=1 blockers=0 missing=0$/m);
    assert.match(
      recover.stdout,
      /\nmaterialization: WRITTEN - 59 report files slot-01\.txt\.\.slot-59\.txt in a newly created output directory\nRESULT: PASS\n$/,
    );
    const slotNames = Array.from(
      { length: CAMPAIGN_SLOT_COUNT },
      (_, i) => `slot-${String(i + 1).padStart(2, '0')}.txt`,
    );
    assert.deepEqual(recover.changes.removed, []);
    assert.deepEqual(recover.changes.changed, []);
    assert.deepEqual(
      recover.changes.added,
      [
        campaign.recoveredName,
        ...slotNames.map((name) => `${campaign.recoveredName}/${name}`),
      ].sort(),
    );
    assert.equal(run.final.get(campaign.recoveredName).type, 'dir');
    assert.deepEqual(readdirSync(campaign.recovered).sort(), slotNames);
    assert.ok(
      ![...run.final.keys()].some((name) => name.includes('staging')),
      'no staging directory remains',
    );

    // 2. Comparison: MATCH over both manifests, writing nothing.
    assert.equal(compare.status, 0);
    assert.match(
      compare.stdout,
      /^artifacts cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE$/m,
    );
    assert.match(
      compare.stdout,
      /^fallback cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE$/m,
    );
    assert.match(
      compare.stdout,
      /^comparison: slots_compared=59 identical=59 different=0\nCOMPARISON: MATCH$/m,
    );

    // 3. Accounting of the selected cohort equals the accounting recovery computed in memory.
    assert.equal(account.status, 0);
    assert.match(account.stdout, /^totals: non-events=58 events=1 blockers=0 missing=0$/m);
    assert.ok(recover.stdout.includes(account.stdout), 'files account exactly as recovered text');

    // 4. Review of the same selected cohort: consistent, one commit, the same one topology.
    assert.equal(review.status, 0);
    assert.match(
      review.stdout,
      /^post-run cohort: reports=59 accounting=COMPLETE resolved_slots=59 blockers=0 missing=0 rejected_inputs=0$/m,
    );
    assert.match(review.stdout, /^ {2}commits=1 manifest_commit_match=yes$/m);
    const accountDigest = /measured_topologies=1 \(sha256:([0-9a-f]{16})\)/.exec(account.stdout)[1];
    const reviewDigest = /measured_topologies=1 \(sha256:([0-9a-f]{16})\)/.exec(review.stdout)[1];
    assert.equal(reviewDigest, accountDigest, 'review and accounting saw the same topology');
    assert.match(review.stdout, /^COHORT: CONSISTENT$/m);

    // Comparator, accounting and review create or change nothing.
    for (const record of [compare, account, review]) {
      assert.deepEqual(record.changes, NO_CHANGE, `${record.step} wrote nothing`);
    }

    // Recovery got one manifest path and no log path; the manifest lists exactly the 59 logs,
    // shuffled, as lines relative to its own directory.
    assert.deepEqual(recover.args, [
      '--output-dir',
      campaign.recovered,
      '--logs-manifest',
      campaign.manifests.logs,
    ]);
    const logLines = readFileSync(campaign.manifests.logs, 'utf8').slice(0, -1).split('\n');
    assert.ok(logLines.every((line) => line.startsWith('../') && !line.includes(campaign.root)));
    const logsListed = parsePathManifest(readFileSync(campaign.manifests.logs), {
      manifestDir: dirname(campaign.manifests.logs),
      platform: process.platform,
      minEntries: 1,
      maxEntries: LOG_RECOVERY_LIMITS.maxLogs,
      countProblem: 'count',
    });
    assert.equal(logsListed.ok, true);
    assert.deepEqual([...logsListed.paths].sort(), [...campaign.logPaths].sort());
    assert.notDeepEqual(logsListed.paths, campaign.logPaths);
    assert.notDeepEqual(logsListed.paths, [...logsListed.paths].sort());

    // Handoffs: every manifest lists exactly the intended 59 files, in a shuffled order.
    const listed = (name) =>
      parseReportManifest(readFileSync(campaign.manifests[name]), {
        manifestDir: dirname(campaign.manifests[name]),
        platform: process.platform,
      });
    const artifacts = listed('artifacts');
    const fallback = listed('fallback');
    const selected = listed('selected');
    for (const result of [artifacts, fallback, selected]) assert.equal(result.ok, true);
    assert.deepEqual([...artifacts.paths].sort(), [...campaign.artifactPaths].sort());
    assert.deepEqual([...fallback.paths].sort(), [...campaign.recoveredPaths].sort());
    assert.deepEqual([...selected.paths].sort(), [...campaign.recoveredPaths].sort());
    assert.notDeepEqual(fallback.paths, [...fallback.paths].sort());
    assert.notDeepEqual(selected.paths, fallback.paths);
    assert.deepEqual(
      readdirSync(campaign.dirs.artifacts)
        .map((name) => join(campaign.dirs.artifacts, name))
        .sort(),
      [...campaign.artifactPaths].sort(),
    );
    // Accounting and review consumed the one selected cohort manifest.
    assert.equal(account.args.at(-1), campaign.manifests.selected);
    assert.equal(review.args.at(-1), campaign.manifests.selected);

    // Recovered bytes equal the independently written artifacts slot for slot, where slots come
    // from content: no artifact file name carries its slot.
    const artifactBySlot = new Map(artifacts.paths.map((path) => [slotOfFile(path), path]));
    const recoveredBySlot = new Map(selected.paths.map((path) => [slotOfFile(path), path]));
    assert.equal(artifactBySlot.size, CAMPAIGN_SLOT_COUNT);
    assert.equal(recoveredBySlot.size, CAMPAIGN_SLOT_COUNT);
    for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
      const artifactPath = artifactBySlot.get(slot);
      assert.ok(
        readFileSync(recoveredBySlot.get(slot)).equals(readFileSync(artifactPath)),
        `slot ${slot} bytes match`,
      );
      assert.ok(
        !basename(artifactPath).startsWith(`slot-${String(slot).padStart(2, '0')}-`),
        `slot ${slot} is not named by its artifact file`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed chains: the first failed prerequisite stops everything after it

test('rehearsal: a one-byte artifact difference is DIFFERENT and stops before accounting and review', () => {
  const changedSlot = 23;
  const flip = (slot, bytes) => {
    if (slot !== changedSlot) return bytes;
    const copy = Buffer.from(bytes);
    const at = copy.indexOf('.000Z') - 1;
    copy[at] += copy[at] === 0x39 ? -1 : 1;
    return copy;
  };
  withCampaign({ artifactBytes: flip }, (campaign) => {
    const run = rehearse(campaign);
    assert.deepEqual(run.names, ['recover', 'compare'], 'nothing runs after a failed comparison');
    const [recover, compare] = run.steps;
    assert.equal(recover.passed, true);
    assert.equal(compare.status, 1);
    assert.match(
      compare.stdout,
      /^comparison: slots_compared=59 identical=58 different=1\nCOMPARISON: DIFFERENT$/m,
    );
    assert.deepEqual(compare.changes, NO_CHANGE);
    for (const record of run.steps) assertNoLeak(campaign, record);
  });
});

test('rehearsal: a malformed job-log or report-path manifest exits 2 at the step that reads it, changes nothing and stops the chain', () => {
  // The job-log manifest names one log twice (once more after `./`): recovery, run through pnpm,
  // refuses it before reading any log, creates nothing, and nothing after it runs.
  withCampaign(
    {
      manifestOverrides: {
        logs: (body) => {
          const [first, ...rest] = body.slice(0, -1).split('\n');
          return manifestOf([first, ...rest, `./${first}`]);
        },
      },
    },
    (campaign) => {
      const run = rehearse(campaign);
      assert.deepEqual(run.names, ['recover']);
      const [recover] = run.steps;
      assert.equal(recover.status, 2);
      assert.equal(firstLine(recover.stdout), 'the same job-log path is listed twice');
      assert.deepEqual(recover.changes, NO_CHANGE, 'no output directory and no staging residue');
      assertNoLeak(campaign, recover);
    },
  );

  // A CRLF artifact manifest: the comparator refuses it before reading any report.
  withCampaign(
    { manifestOverrides: { artifacts: (body) => body.replaceAll('\n', `${CR}\n`) } },
    (campaign) => {
      const run = rehearse(campaign);
      assert.deepEqual(run.names, ['recover', 'compare']);
      const compare = run.steps[1];
      assert.equal(compare.status, 2);
      assert.equal(
        firstLine(compare.stdout),
        `artifacts manifest: ${REPORT_MANIFEST_PROBLEM.carriageReturn}`,
      );
      assert.deepEqual(compare.changes, NO_CHANGE);
      for (const record of run.steps) assertNoLeak(campaign, record);
    },
  );

  // The selected manifest names one report twice (once more after `./`): accounting refuses it
  // after a successful comparison, and review never runs.
  withCampaign(
    {
      manifestOverrides: {
        selected: (body) => {
          const lines = body.slice(0, -1).split('\n');
          const [first, ...rest] = lines;
          const slash = first.lastIndexOf('/');
          return manifestOf([
            `${first.slice(0, slash)}/./${first.slice(slash + 1)}`,
            ...rest.slice(0, -1),
            first,
          ]);
        },
      },
    },
    (campaign) => {
      const run = rehearse(campaign);
      assert.deepEqual(run.names, ['recover', 'compare', 'account']);
      const account = run.steps[2];
      assert.equal(account.status, 2);
      assert.equal(firstLine(account.stdout), 'the same report path is listed twice');
      assert.deepEqual(account.changes, NO_CHANGE);
      for (const record of run.steps) assertNoLeak(campaign, record);
    },
  );
});

test('rehearsal: legitimate domain failures are exit 1 at the first step that evaluates them, never transport errors', () => {
  // A product-assertion failure is a blocker: recovery accounts it, writes nothing and stops.
  withCampaign({ texts: campaignTexts({ 37: { kind: 'product' } }) }, (campaign) => {
    const run = rehearse(campaign);
    assert.deepEqual(run.names, ['recover']);
    const [recover] = run.steps;
    assert.equal(recover.status, 1);
    assert.match(recover.stdout, /^totals: non-events=57 events=1 blockers=1 missing=0$/m);
    assert.match(recover.stdout, /\nmaterialization: NOT WRITTEN - .*\nRESULT: FAIL\n$/);
    assert.deepEqual(recover.changes, NO_CHANGE, 'no output directory and no staging residue');
    assertNoLeak(campaign, recover);
  });

  // One job on a rolled-forward runner image: topology provenance differs, recovery stops.
  withCampaign(
    { texts: campaignTexts({ 5: { topology: { ...TOPOLOGY, runner_image: DRIFTED_IMAGE } } }) },
    (campaign) => {
      const run = rehearse(campaign);
      assert.deepEqual(run.names, ['recover']);
      const [recover] = run.steps;
      assert.equal(recover.status, 1);
      assert.match(recover.stdout, /topology differs across reports \(2 values\)/);
      assert.match(recover.stdout, /\nmaterialization: NOT WRITTEN - .*\nRESULT: FAIL\n$/);
      assert.deepEqual(recover.changes, NO_CHANGE);
      assertNoLeak(campaign, recover);
    },
  );

  // A review manifest for another commit: every transport step passes and the review is Branch C.
  withCampaign({ reviewCommit: OTHER_COMMIT }, (campaign) => {
    const run = rehearse(campaign);
    assert.deepEqual(run.names, ['recover', 'compare', 'account', 'review']);
    const review = run.steps[3];
    assert.equal(review.status, 1);
    assert.match(review.stdout, /^pre-launch snapshot: ACCEPTED$/m);
    assert.match(review.stdout, /^ {2}commits=1 manifest_commit_match=no$/m);
    assert.match(review.stdout, /^COHORT: BRANCH C$/m);
    assert.ok(!review.stdout.includes(OTHER_COMMIT));
    assert.deepEqual(review.changes, NO_CHANGE);
    for (const record of run.steps) assertNoLeak(campaign, record);
  });
});

// ---------------------------------------------------------------------------
// Placement

test('the rehearsal stays manual: outside pnpm verify, the test phases and ordinary CI; operational scripts unchanged', () => {
  for (const [name, command] of Object.values(OPERATIONAL_SCRIPTS)) {
    assert.equal(pkg.scripts[name], command, name);
  }
  // `--logs-manifest` is an argument to the existing recovery script, not a new package script.
  assert.equal(
    pkg.scripts['recover:aggregation-campaign-logs'],
    'node scripts/aggregation-campaign-log-recovery.mjs',
  );
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((name) => name.includes('aggregation-campaign')),
    [
      'account:aggregation-campaign',
      'check:aggregation-campaign-workflow',
      'recover:aggregation-campaign-logs',
      'review:aggregation-campaign-image-cohort',
      'check:aggregation-campaign-preflight',
      'compare:aggregation-campaign-retrievals',
    ],
  );
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.ok(!command.includes('post-run-rehearsal'), name);
  }
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/run-test-phases.mjs',
    'scripts/test-phases-lib.mjs',
    'scripts/check-test-phases.mjs',
  ]) {
    assert.ok(!readFileSync(join(repoRoot, file), 'utf8').includes('post-run-rehearsal'), file);
  }
  assert.deepEqual(readdirSync(join(repoRoot, '.github', 'workflows')), ['ci.yml']);
});
