// Every variable scripts/prisma.mjs reads reaches it through turbo.
//
// Turbo 2 runs a task in a strict environment: a variable the task does not
// declare is withheld from the child, silently (D-005). `pnpm db:migrate` is
// `turbo run db:migrate`, so a variable prisma.mjs reads but turbo.json does
// not name works through `pnpm --dir services/<svc> db:migrate` and is dropped
// through the root entry point — RASTA_MIGRATION_STATEMENT_TIMEOUT was, and
// `RASTA_MIGRATION_STATEMENT_TIMEOUT=15min pnpm db:migrate` ran the migration
// with its 30s default (Codex review of #242).
//
// Two checks: every turbo task that runs prisma.mjs declares every variable
// prisma.mjs reads (static, all services), and the real root command hands
// the variable to prisma.mjs (one service, no database reached either way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_REFUSALS } from './prisma-lib.mjs';
import { ROOT, allows, taskPatterns, turbo, workspacePackages } from './turbo-env-lib.mjs';

const PRISMA_SCRIPT = 'scripts/prisma.mjs';
const TIMEOUT_VARIABLE = 'RASTA_MIGRATION_STATEMENT_TIMEOUT';

/** `process.env.NAME` reads in prisma.mjs, by name. */
function literalReads() {
  const source = readFileSync(join(ROOT, PRISMA_SCRIPT), 'utf8');
  return [...new Set([...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
}

/** The two keyed reads, derived from the package name exactly as prisma.mjs derives them. */
function keyedReads(packageName) {
  const suffix = /^@rasta\/(.+)-service$/.exec(packageName)[1].replaceAll('-', '_').toUpperCase();
  return [`DATABASE_URL_${suffix}`, `DATABASE_URL_${suffix}_MIGRATOR`];
}

/** [{ package, dir, task }] for every workspace script that runs prisma.mjs and is a turbo task. */
function turboTasksRunningPrisma() {
  const runs = [];
  for (const { dir, manifest } of workspacePackages()) {
    for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
      if (command.includes(PRISMA_SCRIPT) && turbo.tasks[script]) {
        runs.push({ package: manifest.name, dir, task: script });
      }
    }
  }
  return runs;
}

test('the matcher reads turbo patterns as turbo does', () => {
  assert.ok(allows(['DATABASE_URL_*'], 'DATABASE_URL_DOCUMENT_MIGRATOR'));
  assert.ok(!allows(['DATABASE_URL_*'], 'DATABASE_URL'));
  assert.ok(!allows(['DATABASE_URL_*', '!DATABASE_URL_X'], 'DATABASE_URL_X'));
  assert.ok(allows([TIMEOUT_VARIABLE], TIMEOUT_VARIABLE));
  assert.ok(!allows(['RASTA_MIGRATION'], TIMEOUT_VARIABLE));
});

test('every turbo task that runs prisma.mjs declares every variable prisma.mjs reads', () => {
  const literal = literalReads();
  // The parse must keep finding the variable this test exists for.
  assert.ok(
    literal.includes(TIMEOUT_VARIABLE),
    `${PRISMA_SCRIPT} no longer reads ${TIMEOUT_VARIABLE}`,
  );
  assert.ok(literal.includes('DATABASE_URL'));

  const runs = turboTasksRunningPrisma();
  assert.ok(
    runs.some((run) => run.task === 'db:migrate'),
    'no workspace db:migrate runs prisma.mjs — the check would pass on nothing',
  );

  const problems = [];
  for (const run of runs) {
    // A package turbo.json could redefine the task's env; none does today,
    // and then turbo.json at the root is the only place to look.
    if (existsSync(join(run.dir, 'turbo.json'))) {
      problems.push(`${run.package} has its own turbo.json; extend this test to read it`);
    }
    const patterns = taskPatterns(run.task);
    for (const name of [...literal, ...keyedReads(run.package)]) {
      if (!allows(patterns, name)) {
        problems.push(`turbo.json "${run.task}" withholds ${name} from ${run.package}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test(
  'the root `pnpm db:migrate` hands RASTA_MIGRATION_STATEMENT_TIMEOUT to prisma.mjs',
  { timeout: 120_000 },
  () => {
    // A value prisma.mjs refuses before it starts Prisma: the refusal is the
    // proof it arrived. Withheld, prisma.mjs would run `migrate deploy`
    // instead — against port 1, so no database is reached either way.
    const unreachable = 'postgresql://nobody:nothing@127.0.0.1:1/nothing';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith('DATABASE_URL') && name !== TIMEOUT_VARIABLE,
      ),
    );
    Object.assign(env, {
      DATABASE_URL_DOCUMENT: unreachable,
      DATABASE_URL_DOCUMENT_MIGRATOR: unreachable,
      [TIMEOUT_VARIABLE]: 'not-a-duration',
    });

    const run = spawnSync('pnpm', ['run', 'db:migrate', '--filter=@rasta/document-service'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.error, undefined, `pnpm did not start: ${run.error}`);
    assert.ok(
      output.includes(MIGRATION_REFUSALS.statementTimeout),
      `prisma.mjs never saw ${TIMEOUT_VARIABLE}:\n${output}`,
    );
    // Refused as a fixed text: the value is not repeated (#385 r4).
    assert.doesNotMatch(output, /not-a-duration/);
    assert.doesNotMatch(output, /P1001/, 'prisma.mjs went on to run Prisma');
    assert.notEqual(run.status, 0);
  },
);
