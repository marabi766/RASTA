import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { parseLimits, parseSample, summarize } from './ci-pg-connections-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMITS = { maxConnections: 100, reserved: 3 };

/** A sample at `at` ms with the given [database, role, state, sessions, monitor] groups. */
const sample = (at, ...groups) => ({
  at,
  groups: groups.map(([database, role, state, sessions, monitor = 0]) => ({
    at,
    database,
    role,
    state,
    sessions,
    monitor,
  })),
});

test('parses the limits row and refuses anything else', () => {
  assert.deepEqual(parseLimits('100|3\n'), { maxConnections: 100, reserved: 3 });
  assert.equal(parseLimits(''), null);
  assert.equal(parseLimits('100'), null);
  assert.equal(parseLimits('max|3'), null);
});

test('parses a sample, ignoring lines that are not a group', () => {
  const parsed = parseSample(
    '1000|rasta_a|rasta_a|idle|4|0\n1001|postgres|rasta|active|1|1\nnoise\n',
  );
  assert.equal(parsed.at, 1001);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[1], {
    at: 1001,
    database: 'postgres',
    role: 'rasta',
    state: 'active',
    sessions: 1,
    monitor: 1,
  });
  assert.equal(parseSample(''), null);
  assert.equal(parseSample('not a row\n'), null);
});

test('the peak leaves out the monitor and is taken over the whole series', () => {
  const result = summarize(
    [
      sample(1000, ['rasta_a', 'rasta_a', 'idle', 20], ['postgres', 'rasta', 'active', 1, 1]),
      sample(
        2000,
        ['rasta_a', 'rasta_a', 'idle', 30],
        ['rasta_b', 'rasta_b', 'active', 40],
        ['postgres', 'rasta', 'active', 1, 1],
      ),
      sample(3000, ['rasta_a', 'rasta_a', 'idle', 5], ['postgres', 'rasta', 'active', 1, 1]),
    ],
    LIMITS,
    4,
  );
  assert.equal(result.peak, 70);
  assert.equal(result.usable, 97);
  assert.equal(result.margin, 27);
  assert.equal(result.when, '1970-01-01T00:00:02.000Z');
  assert.equal(result.warning, false);
  const text = result.lines.join('\n');
  assert.match(
    text,
    /max_connections=100 superuser_reserved_connections=3 usable_by_ordinary_roles=97 runner_cpus=4/,
  );
  assert.match(text, /PEAK 70 client sessions .* margin 27 of 97 usable slots \(28%\)/);
  assert.match(text, /by database: rasta_b=40 rasta_a=30/);
  assert.match(text, /per-database peak over the run: rasta_b=40 rasta_a=30/);
});

test('warns below a fifth of the usable slots, and not at exactly a fifth', () => {
  const at = (sessions) => summarize([sample(1, ['d', 'r', 'idle', sessions])], LIMITS, 4);
  assert.equal(at(77).warning, false); // margin 20 of 97: ceil(19.4) = 20
  assert.equal(at(78).warning, true);
  assert.equal(at(97).margin, 0);
  assert.equal(at(97).warning, true);
  assert.equal(at(120).margin, -23); // over the ceiling is shown, not clamped
});

test('says so, and warns, when there is nothing to measure', () => {
  const noLimits = summarize([sample(1, ['d', 'r', 'idle', 1])], null, 4);
  assert.equal(noLimits.warning, true);
  assert.match(noLimits.lines.join('\n'), /no readable max_connections/);
  const none = summarize([], LIMITS, 4);
  assert.equal(none.warning, true);
  assert.match(none.lines.join('\n'), /no sample was taken/);
});

test('the report never prints a role password or query: only names and counts', () => {
  const text = summarize([sample(1, ['rasta_a', 'rasta_a', 'idle', 3])], LIMITS, 2).lines.join(
    '\n',
  );
  assert.doesNotMatch(text, /postgres(ql)?:\/\/|password|SELECT/i);
});

/** A psql that answers the limits query and the sample query with fixed rows. */
function fakePsql(dir, sampleRows) {
  const bin = join(dir, 'psql');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *max_connections*) echo "100|3" ;;',
      `  *pg_stat_activity*) printf '%s\\n' ${sampleRows.map((r) => `'${r}'`).join(' ')} ;;`,
      '  *) exit 3 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

test('watcher and report, end to end against a stub psql', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  fakePsql(dir, [
    '1700000000000|rasta_a|rasta_a|idle|12|0',
    '1700000000000|postgres|rasta|active|1|1',
  ]);
  const samples = join(dir, 'samples.jsonl');
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    PG_CONNECTIONS_SAMPLES: samples,
  };
  const watcher = spawn(process.execPath, [join(ROOT, 'scripts/ci-pg-connections-watch.mjs')], {
    env,
    stdio: 'ignore',
  });
  await new Promise((done) => setTimeout(done, 2500));
  watcher.kill('SIGTERM');
  const report = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-pg-connections-report.mjs')], {
    env,
    encoding: 'utf8',
  });
  assert.equal(report.status, 0);
  assert.match(report.stdout, /max_connections=100 superuser_reserved_connections=3/);
  assert.match(report.stdout, /PEAK 12 client sessions .* margin 85 of 97/);
  assert.doesNotMatch(report.stdout, /::warning/);
  assert.ok(readFileSync(samples, 'utf8').trim().split('\n').length >= 2);
});

test('the report exits 0 and warns when the watcher never wrote anything', () => {
  const env = {
    ...process.env,
    PG_CONNECTIONS_SAMPLES: join(mkdtempSync(join(tmpdir(), 'ci-pg-')), 'absent'),
  };
  const report = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-pg-connections-report.mjs')], {
    env,
    encoding: 'utf8',
  });
  assert.equal(report.status, 0);
  assert.match(report.stdout, /no readable max_connections/);
  assert.match(report.stdout, /::warning title=PostgreSQL connection margin::/);
});

// --- the workflow wires it the same way in every job that runs suites in parallel ---------------

const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
/** The jobs whose suites run through turbo's default concurrency against one service PostgreSQL. */
const PARALLEL_JOBS = {
  'integration-suites': 'Integration tests',
  'integration-security': 'Test independence (F-25)',
};

for (const [id, firstTest] of Object.entries(PARALLEL_JOBS)) {
  test(`${id}: a raised ceiling, proven by SHOW, watched, and reported even after a failure`, () => {
    const job = workflow.jobs[id];
    const ceilingFlag = /^postgres -c max_connections=(\d+)$/.exec(
      job.services.postgres.command ?? '',
    );
    assert.ok(ceilingFlag, 'the postgres service sets max_connections through its command');
    const ceiling = Number(ceilingFlag[1]);
    assert.ok(ceiling > 100, 'above the image default of 100');
    const names = job.steps.map((step) => step.name);
    const at = (name) => {
      assert.ok(names.includes(name), `${id} has "${name}"`);
      return names.indexOf(name);
    };
    const step = (name) => job.steps[at(name)];
    assert.match(
      step('PostgreSQL connection ceiling').run,
      new RegExp(`SHOW max_connections[\\s\\S]*test "\\$\\{ceiling\\}" = ${ceiling}\\b`),
    );
    assert.ok(at('Apply migrations') < at('PostgreSQL connection ceiling'));
    assert.ok(at('PostgreSQL connection ceiling') < at('Watch PostgreSQL connections'));
    assert.ok(at('Watch PostgreSQL connections') < at(firstTest));
    assert.ok(at(firstTest) < at('PostgreSQL connection peak'));
    const report = step('PostgreSQL connection peak');
    assert.equal(report.if, 'always()');
    assert.match(report.run, /ci-pg-connections-report\.mjs/);
    assert.match(step('Watch PostgreSQL connections').run, /ci-pg-connections-watch\.mjs/);
    assert.equal(
      report.env.PG_CONNECTIONS_SAMPLES,
      step('Watch PostgreSQL connections').env.PG_CONNECTIONS_SAMPLES,
    );
    // The suites themselves keep their pools: nothing here sets a pool parameter.
    assert.doesNotMatch(JSON.stringify(job), /connection_limit|DATABASE_POOL_SIZE/);
  });
}
