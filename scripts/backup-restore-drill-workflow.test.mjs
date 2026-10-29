// Guards .github/workflows/backup-drill-monthly.yml: the scheduled full drill runs on a public
// repository with no secret, so what it may do is held here, not left to review. The last tests
// run the workflow's own `run:` scripts against a stand-in drill CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), 'utf8');
const WORKFLOW = '.github/workflows/backup-drill-monthly.yml';
const text = read(WORKFLOW);
const workflow = YAML.parse(text);
const ci = YAML.parse(read('.github/workflows/ci.yml'));
const job = workflow.jobs.drill;
const step = (name) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `step ${name}`);
  return found;
};
const DRILL = 'Run the full drill';
const SUMMARY = 'Summary (allowlisted fields only)';
const CLEANUP = 'Remove anything the drill left';

test('triggers: one monthly off-the-hour schedule, manual dispatch, and the path-limited pull request', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'pull_request',
    'schedule',
    'workflow_dispatch',
  ]);
  assert.equal(workflow.on.schedule.length, 1);
  const [minute, hour, day, month, weekday] = workflow.on.schedule[0].cron.split(/\s+/);
  assert.match(minute, /^(?!0$)\d{1,2}$/, 'off the hour');
  assert.match(hour, /^\d{1,2}$/);
  assert.match(day, /^\d{1,2}$/, 'one day of the month');
  assert.equal(month, '*');
  assert.equal(weekday, '*');
  assert.deepEqual(workflow.on.pull_request.paths, [
    '.github/workflows/backup-drill-monthly.yml',
    'scripts/backup-restore-drill*',
  ]);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  // pull_request_target and workflow_run run with more than the pull request's own token.
  assert.doesNotMatch(text, /pull_request_target|workflow_run/);
});

test('least privilege: contents read only, no secret anywhere, no outbound alert or upload', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.permissions, undefined);
  assert.equal(job.environment, undefined);
  assert.equal(job.services, undefined, 'the CLI owns its source and restore servers');
  // Strip comments first: they may name what the file refuses.
  const code = text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');
  assert.doesNotMatch(code, /secrets\b|\bsecrets:|inherit|GITHUB_TOKEN|github\.token|vars\./);
  assert.doesNotMatch(code, /upload-artifact|actions\/cache|download-artifact/);
  assert.doesNotMatch(code, /curl|wget|webhook|telegram|api\.github\.com|gh (api|issue|pr)/i);
  assert.doesNotMatch(code, /continue-on-error/);
  for (const candidate of job.steps) {
    if (candidate.uses?.startsWith('actions/checkout'))
      assert.equal(candidate.with['persist-credentials'], false);
  }
});

test('actions are pinned by commit and are the ones ci.yml already uses', () => {
  const used = (workflowDocument) =>
    Object.values(workflowDocument.jobs)
      .flatMap((candidate) => candidate.steps ?? [])
      .map((candidate) => candidate.uses)
      .filter((reference) => reference && !reference.startsWith('./'));
  const inCi = new Set(used(ci));
  const mine = used(workflow);
  assert.ok(mine.length >= 3);
  for (const reference of mine) {
    assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, reference);
    assert.ok(inCi.has(reference), `${reference} is not pinned the way ci.yml pins it`);
  }
});

test('versions and image: Node and pnpm as in ci.yml and package.json, the compose-pinned PostgreSQL', () => {
  assert.equal(workflow.env.NODE_VERSION, ci.env.NODE_VERSION);
  assert.equal(workflow.env.PNPM_VERSION, ci.env.PNPM_VERSION);
  assert.equal(
    `pnpm@${workflow.env.PNPM_VERSION}`,
    JSON.parse(read('package.json')).packageManager,
  );
  // The CLI reads this image from docker-compose.yml for both servers it starts.
  const compose = YAML.parse(read('docker-compose.yml')).services.postgres.image;
  assert.equal(ci.jobs['integration-backup-drill'].services.postgres.image, compose);
  assert.match(compose, /@sha256:[0-9a-f]{64}$/);
});

test('bounded and never cancelled while running: one group per ref, step limit under the job limit', () => {
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /\$\{\{ github\.ref \}\}/);
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 60);
  const drill = step(DRILL);
  // Apart from the 5-minute PostgreSQL tests of ci.yml, and inside the job's limit.
  assert.ok(drill['timeout-minutes'] > 5 && drill['timeout-minutes'] < job['timeout-minutes']);
  assert.equal(workflow.defaults.run.shell, 'bash');
});

test('the drill step runs the existing CLI, keeps its status and sends its output to private files', () => {
  const names = job.steps.map((candidate) => candidate.name).filter(Boolean);
  assert.ok(names.indexOf(DRILL) < names.indexOf(SUMMARY));
  assert.ok(names.indexOf(SUMMARY) < names.indexOf(CLEANUP));
  const run = step(DRILL).run;
  // Created private (0700) and exclusively: an existing directory fails the step.
  assert.match(run, /mkdir -m 700 -- "\$\{dir\}"/);
  assert.match(
    run,
    /scripts\/backup-restore-drill --report "\$\{dir\}\/report\.json" \\\n\s+>"\$\{dir\}\/stdout\.json" 2>"\$\{dir\}\/stderr\.log" \|\| status=\$\?/,
  );
  assert.match(run, /exit "\$\{status\}"\s*$/);
  // The only things echoed are the mask command and the status number.
  const echoes = run.split('\n').filter((line) => /^\s*echo /.test(line));
  assert.equal(echoes.length, 3);
  assert.ok(
    echoes.every((line) => !/stdout\.json|stderr\.log|report\.json/.test(line.split('>')[0])),
  );
});

test('the private path is never exported or put in a step header, and is masked before first use', () => {
  const code = text.replace(/^\s*#.*$/gm, '');
  // GITHUB_ENV, GITHUB_OUTPUT and GITHUB_PATH would print or carry it into every later step.
  assert.doesNotMatch(code, /GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_STATE|BACKUP_DRILL_DIR/);
  assert.equal(workflow.env.BACKUP_DRILL_DIR, undefined);
  for (const candidate of job.steps) {
    assert.doesNotMatch(JSON.stringify(candidate.env ?? {}), /backup-drill|RUNNER_TEMP|\/tmp/);
    if (!candidate.run?.includes('${dir}')) continue;
    const script = candidate.run;
    assert.match(script, /^\s*dir="\$\{RUNNER_TEMP\}\/backup-drill"$/m, candidate.name);
    assert.ok(
      script.indexOf('echo "::add-mask::${dir}"') > -1 &&
        script.indexOf('echo "::add-mask::${dir}"') < script.indexOf('"${dir}/'),
      `${candidate.name}: masked before first use`,
    );
  }
});

test('summary and cleanup always run, read only what they may, and delete the directory only after a clean cleanup', () => {
  for (const name of [SUMMARY, CLEANUP]) {
    assert.match(step(name).if, /always\(\)/);
    assert.match(step(name).if, /steps\.drill\.conclusion != 'skipped'/);
  }
  const summary = step(SUMMARY).run;
  const cleanup = step(CLEANUP).run;
  assert.match(summary, /node scripts\/backup-restore-drill-summary\.mjs/);
  assert.match(summary, /--exit-code "\$\{status\}"/);
  assert.match(summary, /tee -a "\$\{GITHUB_STEP_SUMMARY\}"\s*$/);
  for (const script of [summary, cleanup]) {
    const files = [...script.matchAll(/\$\{dir\}\/([\w.-]+)/g)].map((m) => m[1]);
    for (const file of files)
      assert.ok(['exit-code', 'report.json', 'stderr.log'].includes(file), file);
    // Nothing reads a file to the log; the one cat is of the status number.
    for (const line of script.split('\n').filter((l) => /\b(cat|head|tail|jq|less|grep)\b/.test(l)))
      assert.match(line, /cat "\$\{dir\}\/exit-code"/);
  }
  // Recovery is not conditional on the report existing: a missing record is the CLI's refusal.
  assert.match(cleanup, /scripts\/backup-restore-drill --cleanup-from "\$\{dir\}\/report\.json"/);
  assert.doesNotMatch(cleanup, /\[ -[a-z] /);
  assert.match(
    cleanup,
    /if \[ "\$\{status\}" -eq 0 \]; then\n\s+rm -rf -- "\$\{dir:\?\}"\nelse|if \[ "\$\{status\}" -eq 0 \]; then\n\s+rm -rf -- "\$\{dir:\?\}"\n\s*else/,
  );
  assert.match(cleanup, /exit "\$\{status\}"\s*$/);
});

// --- the workflow's own scripts, against a stand-in drill -------------------------------------
const LEAK = 'LEAK_SENTINEL_amount_9007199254740993_postgresql://u:p@h/db';

function extract(name) {
  return step(name).run;
}

function sandbox(drillBody) {
  const directory = mkdtempSync(join(tmpdir(), 'drill-workflow-'));
  const cwd = join(directory, 'repo');
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  for (const file of [
    'backup-restore-drill-summary.mjs',
    'backup-restore-drill-lib.mjs',
    'infra-preflight-lib.mjs',
    'check-kafka-credential-scope-lib.mjs',
    'database-services.mjs',
  ])
    cpSync(join(root, 'scripts', file), join(cwd, 'scripts', file));
  // The summary reads the service registry, as it does in the checkout.
  const role = 'infrastructure/docker/postgres/lib/role-passwords.bash';
  mkdirSync(join(cwd, role, '..'), { recursive: true });
  cpSync(join(root, role), join(cwd, role));
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  writeFileSync(join(cwd, 'scripts/backup-restore-drill'), drillBody);
  chmodSync(join(cwd, 'scripts/backup-restore-drill'), 0o755);
  const temp = join(directory, 'runner-temp');
  mkdirSync(temp);
  const env = {
    PATH: process.env.PATH,
    RUNNER_TEMP: temp,
    GITHUB_ENV: join(directory, 'github-env'),
    GITHUB_STEP_SUMMARY: join(directory, 'step-summary.md'),
    TMPDIR: directory,
  };
  writeFileSync(env.GITHUB_ENV, '');
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  // What the runner would write to the job log for each step: the environment header (workflow,
  // job, step `env:` and everything added through GITHUB_ENV), then the step's output with the
  // `::add-mask::` commands applied (the command line itself is not printed).
  const masks = new Set();
  const log = [];
  const run = (name) => {
    const declared = { ...workflow.env, ...job.env, ...step(name).env };
    const exported = Object.fromEntries(
      readFileSync(env.GITHUB_ENV, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', extract(name)],
      {
        cwd,
        env: { ...env, ...declared, ...exported },
        encoding: 'utf8',
      },
    );
    const header = Object.entries({ ...declared, ...exported })
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    const output = [];
    for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
      const mask = /^::add-mask::(.*)$/.exec(line);
      if (mask) masks.add(mask[1]);
      else output.push(line);
    }
    let printed = `${header}\n${output.join('\n')}`;
    for (const mask of masks) printed = printed.split(mask).join('***');
    log.push(printed);
    return result;
  };
  return { directory, cwd, temp, env, run, log, dir: join(temp, 'backup-drill') };
}

// A stand-in for scripts/backup-restore-drill: `--report` writes a failing report, spews
// synthetic values on both streams and exits 1; `--cleanup-from` records the call.
const STAND_IN = `#!/usr/bin/env bash
set -u
if [ "$1" = "--cleanup-from" ]; then
  echo "cleanup-from $2" >> "$(dirname "$2")/../../cleanup-calls"
  exit 0
fi
echo "${LEAK} stdout"
echo "${LEAK} stderr" >&2
echo "[backup-restore-drill] dump rasta_audit" >&2
printf '%s' '{"passed":false,"startedAt":"2026-11-01T03:17:00.000Z","databases":[],"error":{"stage":"dump rasta_audit","message":"${LEAK}"}}' > "$2"
exit 1
`;

test('workflow scripts: a failing drill fails the step with its status and leaks nothing to the log', () => {
  const box = sandbox(STAND_IN);
  try {
    const drill = box.run(DRILL);
    assert.equal(drill.status, 1);
    assert.match(drill.stdout, /exited with status 1/);
    assert.ok(!`${drill.stdout}${drill.stderr}`.includes('LEAK_SENTINEL'));
    const summary = box.run(SUMMARY);
    assert.equal(summary.status, 1);
    assert.match(summary.stdout, /Monthly backup\/restore drill: FAILED/);
    assert.match(summary.stdout, /CLI exit code: 1/);
    assert.match(summary.stdout, /Failed stage: dump rasta_audit/);
    assert.match(summary.stdout, /Last stage started: dump rasta_audit/);
    const published = `${summary.stdout}${summary.stderr}${readFileSync(box.env.GITHUB_STEP_SUMMARY, 'utf8')}`;
    assert.ok(!published.includes('LEAK_SENTINEL') && !published.includes('9007199254740993'));
    assert.equal(
      readFileSync(box.env.GITHUB_STEP_SUMMARY, 'utf8').includes('FAILED'),
      true,
      'the job summary is written on failure too',
    );
    const cleanup = box.run(CLEANUP);
    assert.equal(cleanup.status, 0);
    assert.equal(
      readdirSync(box.temp).length,
      0,
      'private directory removed after a clean cleanup',
    );
    assert.match(
      readFileSync(join(box.directory, 'cleanup-calls'), 'utf8'),
      /^cleanup-from .*report\.json\n$/,
    );
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});

test('runner log: the private path appears in no step header and no output, even when a command fails on it', () => {
  const box = sandbox(STAND_IN);
  try {
    box.run(DRILL);
    box.run(SUMMARY);
    // A second drill step in the same job: mkdir fails on the existing directory and its own
    // error message quotes the path. The runner masks it, so the log must not.
    const again = box.run(DRILL);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /File exists/);
    assert.ok(again.stderr.includes(box.dir), 'the raw command output does quote the path');
    box.run(CLEANUP);
    assert.ok(box.log.length >= 4);
    for (const entry of box.log) {
      assert.ok(!entry.includes(box.dir), 'the private path reached the runner log');
      assert.ok(!entry.includes(box.temp), 'the runner temp path reached the runner log');
    }
    assert.ok(
      box.log.some((entry) => entry.includes('***')),
      'it was masked, not just absent',
    );
    assert.equal(readFileSync(box.env.GITHUB_ENV, 'utf8'), '', 'nothing exported to later steps');
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});

test('workflow scripts: a status of 0 with a report that is not a full pass still fails the job', () => {
  const box = sandbox(STAND_IN);
  try {
    box.run(DRILL);
    // As if the CLI had said 0 while its report is the failing one: the summary's own
    // recomputation from the evidence refuses.
    writeFileSync(join(box.dir, 'exit-code'), '0\n');
    const summary = box.run(SUMMARY);
    assert.equal(summary.status, 1);
    assert.match(summary.stdout, /FAILED/);
    assert.match(summary.stdout, /Failing gates: .*acceptance/);
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});

test('workflow scripts: a drill with no status file (timeout or cancel) is reported, and the missing record is refused, not skipped', () => {
  // The stand-in refuses a report that is not there, as the real CLI does (exit 2).
  const box = sandbox(
    '#!/usr/bin/env bash\n[ "$1" = "--cleanup-from" ] && { [ -f "$2" ] || exit 2; echo called >> "$(dirname "$2")/../../cleanup-calls"; exit 0; }\nexit 0\n',
  );
  try {
    // The directory exists (the drill step started) but it never wrote a status or a report.
    mkdirSync(box.dir, { mode: 0o700 });
    const summary = box.run(SUMMARY);
    assert.equal(summary.status, 1);
    assert.match(summary.stdout, /CLI exit code: n\/a/);
    assert.match(summary.stdout, /left no readable report/);
    const cleanup = box.run(CLEANUP);
    assert.equal(cleanup.status, 2, 'a missing record fails the job; it is never "nothing to do"');
    assert.equal(existsSync(box.dir), true, 'the directory is kept when cleanup did not succeed');
    assert.match(cleanup.stdout, /Cleanup did not complete \(status 2\)/);
    assert.ok(!box.log.at(-1).includes(box.dir), 'as the runner would print it');
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});

test('workflow scripts: a cleanup that cannot remove the project fails the job and keeps the recovery record', () => {
  const box = sandbox(STAND_IN);
  try {
    box.run(DRILL);
    writeFileSync(join(box.cwd, 'scripts/backup-restore-drill'), '#!/usr/bin/env bash\nexit 1\n');
    const cleanup = box.run(CLEANUP);
    assert.equal(cleanup.status, 1);
    assert.equal(existsSync(join(box.dir, 'report.json')), true, 'the record survives for a retry');
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});
