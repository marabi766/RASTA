// -----------------------------------------------------------------------------
// ADR-051 B2 under D-045 — who vacuums the outbox, against real PostgreSQL
// (Codex on #180).
//
// The backfill runs as a service's runtime role, which owns no table; for it
// PostgreSQL skips `VACUUM` with a warning and reports success. So the backfill
// never vacuums and reports `vacuum: required`, and `outbox-b2-vacuum.mjs` runs
// `VACUUM (ANALYZE)` as the table's owner and proves it from
// `pg_stat_user_tables`. Every case here runs the real CLIs as processes, in a
// throwaway schema on document's database, and reads the table's own counters.
//
//   pnpm test:outbox-b2-vacuum-pg   (needs DATABASE_URL_DOCUMENT and its _MIGRATOR)
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { vacuumFactsSql } from './outbox-b2-lib.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';
import {
  createOutboxSchema,
  deployOutboxSchema,
  dropOutboxSchema,
  insertRowsSql,
  urlWithSchema,
} from './outbox-b2-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKFILL = path.join(REPO_ROOT, 'scripts', 'outbox-b2-backfill.mjs');
const VACUUM = path.join(REPO_ROOT, 'scripts', 'outbox-b2-vacuum.mjs');

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set (see .env.example and .env.migrator.example).`);
  return value;
}
const RUNTIME_URL = required('DATABASE_URL_DOCUMENT');
const OWNER_URL = required('DATABASE_URL_DOCUMENT_MIGRATOR');

let admin;
before(() => {
  admin = prismaPort('document', OWNER_URL);
});
after(async () => {
  await admin.close();
});

let counter = 0;

/** A throwaway outbox schema owned by document's migrator, with the runtime role's DML grants. */
async function withOutbox(fn) {
  const schema = `b2_vacuum_${process.pid}_${(counter += 1)}`;
  await createOutboxSchema(admin, schema);
  const owner = prismaPort('document', urlWithSchema(OWNER_URL, schema));
  const runtime = prismaPort('document', urlWithSchema(RUNTIME_URL, schema));
  try {
    await deployOutboxSchema(owner);
    const role = decodeURIComponent(new URL(RUNTIME_URL).username);
    await admin.execute(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.execute(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
    await admin.execute(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    await owner.execute(insertRowsSql({ prefix: 'V', topic: 't.v', partitionKey: 'K1', count: 7 }));
    return await fn({ schema, owner, runtime });
  } finally {
    await runtime.close();
    await owner.close();
    await dropOutboxSchema(admin, schema);
  }
}

/** The outbox table's manual vacuum and analyze counts, read as its owner. */
async function counts(owner) {
  const [row] = await owner.query(vacuumFactsSql());
  return { vacuum: Number(row.vacuum_count), analyze: Number(row.analyze_count) };
}

/** Run a CLI as a process; the environment is exactly what it is given plus PATH. */
function run(cli, argv, env) {
  const result = spawnSync(process.execPath, [cli, ...argv], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env },
  });
  const events = result.stdout.trim()
    ? result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, events };
}

const secretOf = (url) => decodeURIComponent(new URL(url).password);

test('the premise: the runtime role’s VACUUM is skipped, not refused', async () => {
  await withOutbox(async ({ owner, runtime }) => {
    const before = await counts(owner);
    // No error — that is the trap the backfill used to fall into.
    await runtime.execute('VACUUM (ANALYZE) "outbox_message"');
    assert.deepEqual(await counts(owner), before);
  });
});

test('the backfill, as the runtime role, reports vacuum: required and vacuums nothing', async () => {
  await withOutbox(async ({ schema, owner }) => {
    const before = await counts(owner);

    const backfill = run(BACKFILL, ['--service', 'document', '--apply'], {
      DATABASE_URL_DOCUMENT: urlWithSchema(RUNTIME_URL, schema),
    });

    assert.equal(backfill.status, 0, `${backfill.stdout}${backfill.stderr}`);
    const vacuum = backfill.events.filter((event) => event.type === 'vacuum');
    assert.equal(vacuum.length, 1, backfill.stdout);
    assert.equal(vacuum[0].status, 'required');
    assert.equal(vacuum[0].table, 'outbox_message');
    assert.equal(vacuum[0].ok, undefined, 'a vacuum that did not happen was reported');
    assert.equal(backfill.events.find((event) => event.type === 'done').vacuum, 'required');
    assert.deepEqual(await counts(owner), before, 'the backfill vacuumed after all');
  });
});

test('the maintenance command vacuums as the owner and proves it from the counters', async () => {
  await withOutbox(async ({ schema, owner }) => {
    const before = await counts(owner);
    const ownerUrl = urlWithSchema(OWNER_URL, schema);

    const vacuum = run(VACUUM, ['--service', 'document'], {
      DATABASE_URL_DOCUMENT_MIGRATOR: ownerUrl,
    });

    assert.equal(vacuum.status, 0, `${vacuum.stdout}${vacuum.stderr}`);
    const [event] = vacuum.events.filter((e) => e.type === 'vacuum');
    assert.equal(event.status, 'verified');
    assert.equal(event.service, 'document');
    assert.equal(event.table, `${schema}.outbox_message`);
    assert.equal(event.role, decodeURIComponent(new URL(OWNER_URL).username));
    assert.deepEqual(event.vacuumCount, { before: before.vacuum, after: before.vacuum + 1 });
    assert.deepEqual(event.analyzeCount, { before: before.analyze, after: before.analyze + 1 });
    const summary = vacuum.events.at(-1);
    assert.deepEqual([summary.type, summary.verified, summary.refused], ['summary', 1, 0]);
    // What it reported is what the table says.
    assert.deepEqual(await counts(owner), {
      vacuum: before.vacuum + 1,
      analyze: before.analyze + 1,
    });
    assert.ok(!vacuum.stdout.includes(ownerUrl), 'the URL was printed');
    assert.ok(!vacuum.stdout.includes(secretOf(OWNER_URL)), 'the password was printed');
  });
});

test('the maintenance command refuses a role that does not own the table, and vacuums nothing', async () => {
  await withOutbox(async ({ schema, owner }) => {
    const before = await counts(owner);
    const runtimeUrl = urlWithSchema(RUNTIME_URL, schema);

    const vacuum = run(VACUUM, ['--service', 'document'], {
      DATABASE_URL_DOCUMENT_MIGRATOR: runtimeUrl,
    });

    assert.equal(vacuum.status, 1, `${vacuum.stdout}${vacuum.stderr}`);
    const [refusal] = vacuum.events.filter((e) => e.type === 'refused');
    assert.match(
      refusal.reason,
      new RegExp(`${new URL(RUNTIME_URL).username} does not own ${schema}\\.outbox_message`),
    );
    assert.deepEqual(
      vacuum.events.filter((e) => e.type === 'vacuum'),
      [],
    );
    assert.deepEqual(await counts(owner), before);
    assert.ok(!vacuum.stdout.includes(secretOf(RUNTIME_URL)), 'the password was printed');
  });
});

test('the maintenance command takes its credential from the environment only', () => {
  // No URL option exists; one on the command line is refused, never used.
  // A placeholder with no credential in it: this test proves the option is
  // refused, and must not itself put a password on a command line.
  const placeholder = 'postgresql://placeholder@127.0.0.1:1/none';
  const viaArgv = run(VACUUM, ['--service', 'document', '--url', placeholder], {});
  assert.equal(viaArgv.status, 1);
  assert.match(viaArgv.events[0].reason, /Unknown option "--url"/);
  assert.ok(!viaArgv.stdout.includes(placeholder), 'the argument was echoed');

  const unset = run(VACUUM, ['--service', 'document'], {});
  assert.equal(unset.status, 1);
  assert.match(
    unset.events.find((e) => e.type === 'refused').reason,
    /DATABASE_URL_DOCUMENT_MIGRATOR is not set/,
  );
});
