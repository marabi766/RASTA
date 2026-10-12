import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { libpqInvocation } = require('../../../scripts/verify-migration-reversible-lib.mjs') as {
  libpqInvocation: (url: string) => { target: string; env: Record<string, string> };
};
import { PrismaService } from '../src/prisma/prisma.service';
import { ScanRepository } from '../src/scanning/scan.repository';
import { newPrisma, ownerDatabaseUrl } from './helpers';

/**
 * `20261012120000_document_instants_timestamptz` (D-048) against rows.
 *
 * The reversibility verifier proves the schema round-trips on an empty
 * database. This proves the **values** do: rows written by the service as it
 * was — UTC wall times in `timestamp(3)`, some from the database's own clock —
 * are the same instants after the conversion, after its rollback and after it
 * again, read through SQL and through Prisma.
 *
 * And it shows what the conversion is for. A session in another zone
 * (Asia/Tehran, the platform's own) writing `now()` through raw SQL — the scan
 * claim's lease, a column default — stored that zone's wall time in
 * `timestamp(3)`, which every reader then took for UTC. In `timestamptz(3)` it
 * stores the instant, whatever the session's zone.
 *
 * Everything runs in a throwaway schema built by applying the real migrations
 * through `psql --file`, as the database's owner, and is dropped at the end.
 */

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const CONVERSION = '20261012120000_document_instants_timestamptz';
const CHAIN = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();
const BEFORE_CONVERSION = CHAIN.slice(0, CHAIN.indexOf(CONVERSION));

/** The seventeen instant columns, by table. */
const INSTANTS: Record<string, readonly string[]> = {
  upload_intent: ['expires_at', 'consumed_at', 'created_at'],
  document: [
    'scanned_at',
    'scan_queued_at',
    'scan_next_attempt_at',
    'scan_lease_expires_at',
    'quarantined_at',
    'deleted_at',
    'created_at',
    'updated_at',
  ],
  access_grant: ['granted_at', 'revoked_at'],
  outbox_message: ['created_at', 'published_at', 'claim_expires_at', 'next_attempt_at'],
};

const TEHRAN = 'Asia/Tehran';

/** Rows as the service before the conversion wrote them: UTC wall times, plus the database clock. */
const SEED = `
INSERT INTO upload_intent (id, organization_id, object_key, document_class, declared_content_type,
                           declared_size_bytes, declared_filename, state, expires_at, consumed_at,
                           consumed_document_id, created_at, created_by)
VALUES ('UPI_A', 'ORG_TZ', 'ORG_TZ/CONTRACT/A', 'CONTRACT', 'application/pdf', 10, 'a.pdf', 'CONSUMED',
        '2026-03-20 20:30:00.123', '2026-03-20 20:10:00.456', 'DOC_A', '2026-03-20 20:00:00.789', 'USR_TZ'),
       ('UPI_B', 'ORG_TZ', 'ORG_TZ/CONTRACT/B', 'CONTRACT', 'application/pdf', 10, 'b.pdf', 'ISSUED',
        now() + interval '1 hour', NULL, NULL, DEFAULT, 'USR_TZ'),
       ('UPI_C', 'ORG_TZ', 'ORG_TZ/CONTRACT/C', 'CONTRACT', 'application/pdf', 10, 'c.pdf', 'ISSUED',
        now() + interval '1 hour', NULL, NULL, DEFAULT, 'USR_TZ');

-- Infected, quarantined and then deleted: every terminal instant set.
INSERT INTO document (id, organization_id, object_key, document_class, status, content_type, size_bytes,
                      filename, scan_state, scan_engine, scan_version, scan_signature, scanned_at,
                      scan_queued_at, scan_attempts, quarantined_at, quarantine_reason, deleted_at,
                      deleted_by, deletion_reason, upload_intent_id, created_at, created_by, updated_at)
VALUES ('DOC_A', 'ORG_TZ', 'ORG_TZ/CONTRACT/A', 'CONTRACT', 'DELETED', 'application/pdf', 10, 'a.pdf',
        'INFECTED', 'clamav', '1.4.2', 'Eicar-Test-Signature', '2026-03-20 20:11:00.001',
        '2026-03-20 20:10:30.003', 1, '2026-03-20 20:11:00.001', 'probe', '2026-03-21 08:00:00.002',
        'USR_TZ', 'probe', 'UPI_A', '2026-03-20 20:10:00.456', 'USR_TZ', '2026-03-21 08:00:00.002');

-- Pending under a live lease with a retry scheduled: every queue instant set.
INSERT INTO document (id, organization_id, object_key, document_class, content_type, size_bytes, filename,
                      scan_queued_at, scan_attempts, scan_next_attempt_at, scan_lease_owner,
                      scan_lease_expires_at, upload_intent_id, created_by, updated_at)
VALUES ('DOC_B', 'ORG_TZ', 'ORG_TZ/CONTRACT/B', 'CONTRACT', 'application/pdf', 10, 'b.pdf',
        '2026-03-20 21:00:00.007', 1, '2026-03-20 21:05:00.008', 'worker-old',
        '2126-03-20 21:01:00.009', 'UPI_B', 'USR_TZ', now());

INSERT INTO access_grant (id, organization_id, document_id, subject_type, subject_id, granted_at,
                          granted_by, revoked_at, revoked_by)
VALUES ('GRT_A', 'ORG_TZ', 'DOC_A', 'USER', 'USR_OTHER', '2026-03-20 20:20:00.010', 'USR_TZ',
        '2026-03-20 20:40:00.011', 'USR_TZ'),
       ('GRT_B', 'ORG_TZ', 'DOC_A', 'USER', 'USR_THIRD', DEFAULT, 'USR_TZ', NULL, NULL);

INSERT INTO outbox_message (id, aggregate_type, aggregate_id, event_name, topic, partition_key, payload,
                            headers, organization_id, correlation_id, created_at, published_at)
VALUES ('EVT_A', 'Document', 'DOC_A', 'DOCUMENT_REGISTERED', 't.tz', 'DOC_A', '{}', '{}', 'ORG_TZ',
        'COR_A', '2026-03-20 20:10:00.456', '2026-03-20 20:10:01.012');
INSERT INTO outbox_message (id, aggregate_type, aggregate_id, event_name, topic, partition_key, payload,
                            headers, organization_id, correlation_id, attempts, last_error, claim_token,
                            claim_owner, claim_expires_at, next_attempt_at)
VALUES ('EVT_B', 'Document', 'DOC_B', 'DOCUMENT_REGISTERED', 't.tz', 'DOC_B', '{}', '{}', 'ORG_TZ',
        'COR_B', 1, 'BROKER_UNAVAILABLE', 'tok', 'relay-1', '2026-03-20 21:00:30.013',
        '2026-03-20 21:01:00.014');
`;

/** What the literals above say, as instants. */
const DOC_A_EXPECTED = {
  scannedAt: '2026-03-20T20:11:00.001Z',
  scanQueuedAt: '2026-03-20T20:10:30.003Z',
  quarantinedAt: '2026-03-20T20:11:00.001Z',
  deletedAt: '2026-03-21T08:00:00.002Z',
  createdAt: '2026-03-20T20:10:00.456Z',
  updatedAt: '2026-03-21T08:00:00.002Z',
};

describe(`${CONVERSION}: instants survive the conversion, and a non-UTC session now stores them right`, () => {
  jest.setTimeout(120_000);
  const schema = `tz_${ulid().toLowerCase()}`;
  const rawOwnerUrl = process.env.DATABASE_URL_DOCUMENT_MIGRATOR;

  /** A url for the scratch schema; UTC unless a zone is named. */
  const urlFor = (zone?: string): string => {
    const url = new URL(zone ? rawOwnerUrl! : ownerDatabaseUrl());
    url.searchParams.set('schema', schema);
    if (zone) url.searchParams.set('options', `-c TimeZone=${zone}`);
    return url.toString();
  };

  /**
   * psql as the owner, in `inSchema` and `zone`. The password travels in
   * PGPASSWORD, never in argv (libpqInvocation, as the migration verifier does).
   */
  const psql = (args: string[], zone = 'UTC', inSchema = schema) => {
    const url = new URL(rawOwnerUrl!);
    url.searchParams.set('options', `-c search_path=${inSchema} -c TimeZone=${zone}`);
    const { target, env } = libpqInvocation(url.toString());
    const result = spawnSync(
      'psql',
      [target, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args],
      {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `psql ${args.join(' ')} failed: ${`${result.stdout}${result.stderr}`.slice(0, 800)}`,
      );
    }
    return result.stdout.trim();
  };

  /**
   * One migration file, the way it is applied: in one transaction (Prisma's
   * implicit one, `--single-transaction` here), except a CONCURRENTLY build,
   * which cannot be in one and is alone in its file for that reason.
   */
  const applyFile = (name: string, file: 'migration.sql' | 'down.sql') => {
    const path = join(MIGRATIONS, name, file);
    const single = !/\bCONCURRENTLY\b/.test(readFileSync(path, 'utf8'));
    psql([...(single ? ['--single-transaction'] : []), '--file', path]);
    if (file === 'migration.sql') {
      psql(['-c', `INSERT INTO "_prisma_migrations" VALUES ('${name}')`]);
    }
  };
  let utc: PrismaService;
  let tehran: PrismaService;

  /**
   * New connections, as a restarted replica has. A connection that prepared a
   * statement on these tables before the conversion fails it afterwards — see
   * the first test — so the deploy restarts the service, and so does this.
   */
  const reconnect = async () => {
    await utc?.onModuleDestroy();
    await tehran?.onModuleDestroy();
    utc = new PrismaService(urlFor());
    tehran = new PrismaService(urlFor(TEHRAN));
  };
  const up = () => applyFile(CONVERSION, 'migration.sql');
  const down = () => applyFile(CONVERSION, 'down.sql');

  beforeAll(async () => {
    if (!rawOwnerUrl) {
      throw new Error(
        'DATABASE_URL_DOCUMENT_MIGRATOR is not set; see .env.migrator.example (D-045).',
      );
    }
    psql(['-c', `CREATE SCHEMA "${schema}"`], 'UTC', 'public');
    psql(['-c', 'CREATE TABLE "_prisma_migrations" ("migration_name" text NOT NULL)']);
    for (const name of BEFORE_CONVERSION) applyFile(name, 'migration.sql');
    psql(['-c', SEED]);
    await reconnect();
  });

  afterAll(async () => {
    await utc?.onModuleDestroy();
    await tehran?.onModuleDestroy();
    psql(['-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`], 'UTC', 'public');
  });

  /** Every instant of every seeded row, as epoch milliseconds, keyed `table.id.column`. */
  const instants = async (): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {};
    for (const [table, columns] of Object.entries(INSTANTS)) {
      const select = columns
        .map((c) => `(round(extract(epoch FROM "${c}") * 1000))::bigint::text AS "${c}"`)
        .join(', ');
      const rows = await utc.client.$queryRawUnsafe<Record<string, string | null>[]>(
        `SELECT id, ${select} FROM "${table}" ORDER BY id`,
      );
      for (const row of rows) {
        for (const c of columns) out[`${table}.${row.id}.${c}`] = row[c] ?? null;
      }
    }
    return out;
  };

  const types = async (): Promise<string[]> => {
    const rows = await utc.client.$queryRawUnsafe<{ t: string }[]>(
      `SELECT table_name || '.' || column_name || ' ' || data_type || '(' || datetime_precision || ') '
              || coalesce(column_default, '-') AS t
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND data_type LIKE 'timestamp%'
          AND table_name <> '_prisma_migrations'
        ORDER BY 1`,
    );
    return rows.map((row) => row.t);
  };

  /** Every index and constraint, by definition: the conversion must carry each over unchanged. */
  const structure = async (): Promise<string> => {
    const [row] = await utc.client.$queryRawUnsafe<{ s: string }[]>(
      `SELECT (SELECT string_agg(indexname || ' ' || indexdef, E'\\n' ORDER BY indexname)
                 FROM pg_indexes WHERE schemaname = current_schema())
              || E'\\n' ||
              (SELECT string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), E'\\n' ORDER BY c.conname)
                 FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace) AS s`,
    );
    return row!.s;
  };

  const docA = () =>
    runUnscoped('test: the scratch schema', () =>
      utc.client.document.findUniqueOrThrow({ where: { id: 'DOC_A' } }),
    );
  const iso = (row: Awaited<ReturnType<typeof docA>>) => ({
    scannedAt: row.scannedAt?.toISOString(),
    scanQueuedAt: row.scanQueuedAt?.toISOString(),
    quarantinedAt: row.quarantinedAt?.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  /** The Tehran session's distance from UTC, in seconds, asked of the session itself. */
  const tehranOffsetSeconds = async (): Promise<number> => {
    const [row] = await tehran.client.$queryRawUnsafe<{ zone: string; utc_offset: number }[]>(
      `SELECT current_setting('TimeZone') AS zone, extract(timezone FROM now())::int AS utc_offset`,
    );
    // Guards the test: a session silently in UTC would make every contrast below vacuous.
    expect(row!.zone).toBe(TEHRAN);
    expect(row!.utc_offset).not.toBe(0);
    return row!.utc_offset;
  };

  /**
   * The scan worker's claim, run by a replica whose session is in Tehran: the
   * lease is `now() + 60 s`, written by raw SQL. Returns how far from
   * `Date.now() + 60 s` the stored lease reads back through Prisma, in seconds,
   * then releases it.
   */
  const leaseDrift = async (): Promise<number> => {
    const claimed = await new ScanRepository(tehran).claim({
      owner: 'tehran-worker',
      limit: 10,
      leaseSeconds: 60,
    });
    expect(claimed.map((d) => d.id)).toEqual(['DOC_C']);
    const doc = await runUnscoped('test: the scratch schema', () =>
      utc.client.document.findUniqueOrThrow({ where: { id: 'DOC_C' } }),
    );
    const drift = (doc.scanLeaseExpiresAt!.getTime() - (Date.now() + 60_000)) / 1000;
    await utc.client.$executeRawUnsafe(
      `UPDATE document SET scan_lease_owner = NULL, scan_lease_expires_at = NULL WHERE id = 'DOC_C'`,
    );
    return drift;
  };

  /** A column default (`CURRENT_TIMESTAMP`) filled in by a Tehran session, read back through Prisma. */
  const defaultDrift = async (): Promise<number> => {
    const id = `GRT_${ulid()}`;
    await tehran.client.$executeRawUnsafe(
      `INSERT INTO access_grant (id, organization_id, document_id, subject_type, subject_id, granted_by)
       VALUES ($1, 'ORG_TZ', 'DOC_A', 'USER', $1, 'USR_TZ')`,
      id,
    );
    const grant = await runUnscoped('test: the scratch schema', () =>
      utc.client.accessGrant.findUniqueOrThrow({ where: { id } }),
    );
    await utc.client.$executeRawUnsafe(`DELETE FROM access_grant WHERE id = $1`, id);
    return (grant.grantedAt.getTime() - Date.now()) / 1000;
  };

  it('converts, rolls back and converts again with every instant unchanged', async () => {
    // A third, unleased pending document: the one the Tehran claim takes.
    psql([
      '-c',
      `INSERT INTO document (id, organization_id, object_key, document_class, content_type, size_bytes,
                             filename, upload_intent_id, created_by, updated_at)
       VALUES ('DOC_C', 'ORG_TZ', 'ORG_TZ/CONTRACT/C', 'CONTRACT', 'application/pdf', 10, 'c.pdf',
               'UPI_C', 'USR_TZ', now())`,
    ]);
    const offset = await tehranOffsetSeconds();

    // --- before: timestamp(3), and the defect D-048 records -------------------
    expect((await types()).every((t) => t.includes('timestamp without time zone(3)'))).toBe(true);
    expect(await types()).toHaveLength(17);
    // The Tehran session's `now()` lands `offset` seconds away from the instant.
    expect(Math.abs((await leaseDrift()) - offset)).toBeLessThan(15);
    expect(Math.abs((await defaultDrift()) - offset)).toBeLessThan(15);

    const before = await instants();
    const shape = await structure();
    expect(Object.values(before).filter((v) => v !== null).length).toBeGreaterThan(25);
    expect(iso(await docA())).toEqual(DOC_A_EXPECTED);

    // --- up --------------------------------------------------------------------
    up();
    // A connection that read `document` before the conversion cannot read it
    // after: PostgreSQL refuses to re-plan a prepared statement whose result
    // type changed, and Prisma keeps the statement, so every retry on that
    // connection fails the same way. Hence the restart in the runbook (D-048).
    await expect(docA()).rejects.toThrow(/cached plan must not change result type/);
    await expect(docA()).rejects.toThrow(/cached plan must not change result type/);
    await reconnect();

    const converted = await types();
    expect(converted).toHaveLength(17);
    expect(converted.every((t) => t.includes('timestamp with time zone(3)'))).toBe(true);
    // The four CURRENT_TIMESTAMP defaults survive the conversion as the same expression.
    expect(converted.filter((t) => t.endsWith(' CURRENT_TIMESTAMP'))).toHaveLength(4);
    expect(await instants()).toEqual(before);
    expect(await structure()).toEqual(shape);
    expect(iso(await docA())).toEqual(DOC_A_EXPECTED);

    // A Tehran session reads the same instants, and now writes them right.
    const viaTehran = await runUnscoped('test: the scratch schema', () =>
      tehran.client.document.findUniqueOrThrow({ where: { id: 'DOC_A' } }),
    );
    expect(iso(viaTehran)).toEqual(DOC_A_EXPECTED);
    expect(Math.abs(await leaseDrift())).toBeLessThan(15);
    expect(Math.abs(await defaultDrift())).toBeLessThan(15);

    // --- down ------------------------------------------------------------------
    down();
    await reconnect();
    expect((await types()).every((t) => t.includes('timestamp without time zone(3)'))).toBe(true);
    expect(await instants()).toEqual(before);
    expect(await structure()).toEqual(shape);
    expect(iso(await docA())).toEqual(DOC_A_EXPECTED);
    expect(
      psql([
        '-c',
        `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '${CONVERSION}'`,
      ]),
    ).toBe('0');

    // This client (built for timestamptz) still writes the old column correctly
    // under a UTC session, so the code need not be rolled back with the schema.
    const written = new Date('2026-03-22T09:15:30.250Z');
    await runUnscoped('test: the scratch schema', () =>
      utc.client.document.update({ where: { id: 'DOC_A' }, data: { updatedAt: written } }),
    );
    expect(
      psql([
        '-c',
        `SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.MS') FROM document WHERE id = 'DOC_A'`,
      ]),
    ).toBe('2026-03-22 09:15:30.250');
    await runUnscoped('test: the scratch schema', () =>
      utc.client.document.update({
        where: { id: 'DOC_A' },
        data: { updatedAt: new Date(DOC_A_EXPECTED.updatedAt) },
      }),
    );

    // --- up again --------------------------------------------------------------
    up();
    await reconnect();
    expect((await types()).every((t) => t.includes('timestamp with time zone(3)'))).toBe(true);
    expect(await instants()).toEqual(before);
    expect(await structure()).toEqual(shape);
    expect(iso(await docA())).toEqual(DOC_A_EXPECTED);
  });

  it('fails closed, changing nothing, when a transaction holds the table past lock_timeout', async () => {
    // Whatever state the test above left: roll the conversion back if it is applied.
    if ((await types())[0]?.includes('with time zone')) down();
    await reconnect();
    const before = await instants();

    // Another session holds a lock that conflicts with ACCESS EXCLUSIVE.
    await tehran.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE document IN ROW EXCLUSIVE MODE`);
        const started = Date.now();
        expect(up).toThrow(/lock timeout/);
        // Gave up at lock_timeout rather than queueing behind the transaction.
        expect(Date.now() - started).toBeLessThan(15_000);
      },
      { timeout: 60_000 },
    );

    expect((await types()).every((t) => t.includes('timestamp without time zone(3)'))).toBe(true);
    expect(await instants()).toEqual(before);
    expect(
      psql([
        '-c',
        `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '${CONVERSION}'`,
      ]),
    ).toBe('0');
  });
});

describe('the service’s own tables (D-048)', () => {
  it('stores every instant as timestamptz(3)', async () => {
    const prisma = newPrisma();
    try {
      const columns = await prisma.client.$queryRawUnsafe<{ c: string }[]>(
        `SELECT table_name || '.' || column_name || ' ' || data_type || '(' || datetime_precision || ')' AS c
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND data_type LIKE 'timestamp%'
            AND table_name <> '_prisma_migrations'
          ORDER BY 1`,
      );
      expect(columns.map((row) => row.c)).toEqual(
        Object.entries(INSTANTS)
          .flatMap(([table, cols]) => cols.map((c) => `${table}.${c} timestamp with time zone(3)`))
          .sort(),
      );
    } finally {
      await prisma.onModuleDestroy();
    }
  });
});
