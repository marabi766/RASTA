import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { EventConsumer, InternalTokenService } from '@rasta/nest-common';
import { StatementSettlementConsumer } from '../src/consumers/statement-settlement.consumer';
import { SourceFactsClient } from '../src/provenance/source-facts.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma';
import { StubContractService } from './contract-service.stub';
import { id, ownerDatabaseUrl, wire } from './helpers';

/**
 * `20261017100000_transaction_statement_obligation` rolled back and applied
 * again once the consumer has recorded obligations (review of #329 round 1,
 * finding 2).
 *
 * `down.sql` keeps every row, so the next `migrate deploy` meets the
 * consumer's obligations. Its preflight must accept those — each linked to
 * the processed_event marker the consumer wrote with it — and still refuse,
 * changing nothing, a STATEMENT row the previous release let
 * POST /v1/transactions write during the rollback; and the correction its
 * HINT names must be one that lets it apply.
 *
 * Every step is the real one, in a scratch schema built by the real
 * migrations as the database's owner and dropped at the end: `migrate deploy`,
 * the whole `down.sql` through `prisma db execute`, `migrate resolve`, and the
 * obligations recorded by the real consumer from a local contract-service.
 */

const MIGRATION = '20261017100000_transaction_statement_obligation';
const SERVICE_DIR = join(__dirname, '..');
const MIGRATION_DIR = join(SERVICE_DIR, 'prisma', 'migrations', MIGRATION);
const REFUSAL =
  /transaction: (\d+) row\(s\) carry source_type STATEMENT without being recorded by the STATEMENT_APPROVED consumer; refusing to reserve it/;
const SECRET = 'itest_internal_secret_at_least_32_characters';

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

/**
 * The Prisma CLI, with the url in the child's environment — never `--url`,
 * where its password would sit in the process's argv (D-045 follow-up).
 */
function prismaCli(argv: string[], options: { url: string; stdin?: string }) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: SERVICE_DIR,
    env: { ...process.env, DATABASE_URL: options.url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    input: options.stdin,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function mustRun(argv: string[], options: { url: string; stdin?: string }): string {
  const result = prismaCli(argv, options);
  if (!result.ok) throw new Error(`prisma ${argv[0]} failed:\n${result.output.slice(0, 1200)}`);
  return result.output;
}

const deploy = (url: string) =>
  prismaCli(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { url });

const runDown = (url: string) =>
  mustRun(['db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'], {
    url,
    stdin: readFileSync(join(MIGRATION_DIR, 'down.sql'), 'utf8'),
  });

/** The HINT's SQL, as the operator reads it out of the error: its quotes undoubled. */
function hint(): { list: string; correction: string } {
  const sql = readFileSync(join(MIGRATION_DIR, 'migration.sql'), 'utf8');
  const text = /USING HINT = '((?:[^']|'')*)';/.exec(sql)![1]!.replace(/''/g, "'");
  return {
    list: /List them with: (SELECT [\s\S]*?\)); none is/.exec(text)![1]!,
    correction: /(UPDATE "transaction" SET [^<]*)<id>/.exec(text)![1]!,
  };
}

describe(`${MIGRATION}: down, then up again, over recorded obligations`, () => {
  jest.setTimeout(240_000);

  const schemas: string[] = [];
  const clients: PrismaClient[] = [];
  const services: PrismaService[] = [];
  const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
  const contract = new StubContractService(tokens);
  let owner: PrismaClient;

  const EMPLOYER = 'ORG_STM_ROLLBACK_EMPLOYER';
  const CONTRACTOR = 'ORG_STM_ROLLBACK_CONTRACTOR';

  const urlOf = (schema: string) => {
    const url = new URL(ownerDatabaseUrl());
    url.searchParams.set('schema', schema);
    return url.toString();
  };

  /** A schema holding every migration of this release, and the consumer over it. */
  async function scratch() {
    const schema = `stm_rollback_${ulid().toLowerCase()}`;
    schemas.push(schema);
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = urlOf(schema);
    mustRun(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { url });
    const db = new PrismaClient({ datasources: { db: { url } } });
    clients.push(db);
    const prisma = new PrismaService(url);
    await prisma.onModuleInit();
    services.push(prisma);
    const consumer = new StatementSettlementConsumer(
      () =>
        ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer,
      prisma,
      wire(prisma).transactions,
      new SourceFactsClient({
        maintenanceBaseUrl: 'http://127.0.0.1:9',
        fleetBaseUrl: 'http://127.0.0.1:9',
        contractBaseUrl: contract.url,
        timeoutMs: 2_000,
        tokens,
      }),
      null,
    );
    return { url, db, consumer };
  }

  /** An approval as contract-service stores it, and the event that announces it. */
  function approval(): { statementId: string; event: EventEnvelope } {
    const fact = contract.record({
      statementId: `STM_${ulid()}`,
      contractId: `CTR_${ulid()}`,
      status: 'APPROVED',
      netMinor: '5600000',
      currency: 'IRR',
      payerOrganizationId: EMPLOYER,
      beneficiaryOrganizationId: CONTRACTOR,
      approvedAt: new Date().toISOString(),
    });
    const event = {
      eventId: ulid(),
      eventName: 'STATEMENT_APPROVED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'contract-service',
      producerVersion: '0.1.0',
      aggregateType: 'Contract',
      aggregateId: fact.contractId,
      tenantId: EMPLOYER,
      correlationId: `statement-rollback-${ulid()}`,
      payload: {
        contractId: fact.contractId,
        statementId: fact.statementId,
        statementNumber: 1,
        organizationId: EMPLOYER,
        contractorOrganizationId: CONTRACTOR,
        approvedAt: fact.approvedAt,
      },
    } as EventEnvelope;
    return { statementId: fact.statementId, event };
  }

  /** What `down.sql` and the migration could change: the guards, the ledger row, the rows. */
  async function shape(db: PrismaClient) {
    const count = async (sql: string, ...values: unknown[]) =>
      Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql, ...values))[0]!.n);
    return {
      check: await count(
        `SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace
          WHERE s.nspname = current_schema() AND c.conname = 'ck_transaction_statement_obligation'`,
      ),
      trigger: await count(
        `SELECT count(*) AS n FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
           JOIN pg_namespace s ON s.oid = r.relnamespace
          WHERE s.nspname = current_schema() AND t.tgname = 'trg_transaction_statement_obligation_fixed'`,
      ),
      applied: await count(
        `SELECT count(*) AS n FROM "_prisma_migrations"
          WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
        MIGRATION,
      ),
      rows: (
        await db.$queryRawUnsafe<{ row: string }[]>(
          `SELECT to_jsonb(t)::text AS row FROM "transaction" t
            WHERE source_type LIKE 'STATEMENT%' ORDER BY id`,
        )
      ).map(({ row }) => JSON.parse(row) as Record<string, unknown>),
    };
  }

  const GUARDED = { check: 1, trigger: 1, applied: 1 };
  const UNGUARDED = { check: 0, trigger: 0, applied: 0 };

  /** A STATEMENT row as the previous release's POST /v1/transactions writes it. */
  const insertOverHttp = (db: PrismaClient, transactionId: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
         transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
         source_reference, idempotency_key, correlation_id, created_by, updated_at)
       VALUES ($1, $2, $3, 'CONSTRUCTION_STATEMENT', 'CREATED', 1, 'IRR', now(),
         'STATEMENT', $4, 'a-client-key-123', 'corr-http', 'USR-SOMEONE', now())`,
      transactionId,
      EMPLOYER,
      CONTRACTOR,
      `STM_${ulid()}`,
    );

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    await contract.start();
  });

  afterAll(async () => {
    for (const service of services) await service.onModuleDestroy();
    for (const client of clients) await client.$disconnect();
    for (const schema of schemas) {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; it names only a
      // scratch schema this suite created (`stm_rollback_<ulid>`).
      await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await owner?.$disconnect();
    await contract.stop();
  });

  it('up → a recorded obligation → down → up: accepted as it is, and the guards hold it again', async () => {
    const { url, db, consumer } = await scratch();
    const first = approval();
    const second = approval();
    await consumer.handle(first.event);
    await consumer.handle(second.event);
    const recorded = await shape(db);
    expect(recorded).toMatchObject(GUARDED);
    expect(recorded.rows).toHaveLength(2);

    // down: the guards and the ledger row go; every row stays exactly.
    runDown(url);
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: recorded.rows });

    // up again: applied, nothing refused, every row unchanged.
    const again = deploy(url);
    expect(again.output).not.toMatch(REFUSAL);
    expect(again.ok).toBe(true);
    expect(again.output).toContain(MIGRATION);
    expect(await shape(db)).toEqual({ ...GUARDED, rows: recorded.rows });

    // The trigger and the CHECK hold them again...
    const [row] = recorded.rows;
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "transaction" SET gross_amount_minor = gross_amount_minor + 1 WHERE id = $1`,
        row!.id,
      ),
    ).rejects.toThrow(/the terms of a statement obligation never change/);
    await expect(insertOverHttp(db, id('TXN'))).rejects.toThrow(
      /ck_transaction_statement_obligation/,
    );
    // ...and the consumer still finds its own: a replay records nothing new.
    await expect(consumer.handle({ ...first.event, eventId: ulid() })).resolves.toBeUndefined();
    expect((await shape(db)).rows).toEqual(recorded.rows);
  });

  it('refuses, changing nothing, a STATEMENT row written over HTTP during the rollback — and the HINT’s correction lets it apply', async () => {
    const { url, db, consumer } = await scratch();
    await consumer.handle(approval().event);
    runDown(url);

    // The previous release, running: POST /v1/transactions does not reserve
    // STATEMENT, so a caller writes one. And a row shaped exactly like the
    // consumer's, whose causation id another consumer — not this one — marked
    // processed.
    const overHttp = id('TXN');
    await insertOverHttp(db, overHttp);
    const forged = id('TXN');
    const elsewhere = ulid();
    await db.processedEvent.create({
      data: { eventId: elsewhere, consumerName: 'economic-service.settlement-authority' },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
         transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
         source_reference, causation_id, correlation_id, created_by, updated_at)
       VALUES ($1, $2, $3, 'CONSTRUCTION_STATEMENT', 'PENDING_SETTLEMENT', 1, 'IRR', now(),
         'STATEMENT', $4, $5, 'corr-forged', 'economic-service', now())`,
      forged,
      EMPLOYER,
      CONTRACTOR,
      `STM_${ulid()}`,
      elsewhere,
    );
    const before = await shape(db);
    expect(before.rows).toHaveLength(3);

    const refused = deploy(url);
    expect(refused.ok).toBe(false);
    expect(REFUSAL.exec(refused.output)?.[1]).toBe('2');
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: before.rows });

    // The operator: the failed attempt marked rolled back, the HINT's list —
    // exactly the two — each corrected as it says, then deploy again.
    mustRun(
      ['migrate', 'resolve', '--rolled-back', MIGRATION, '--schema', 'prisma/schema.prisma'],
      {
        url,
      },
    );
    const { list, correction } = hint();
    const listed = await db.$queryRawUnsafe<{ id: string }[]>(list);
    expect(listed.map((r) => r.id).sort()).toEqual([overHttp, forged].sort());
    for (const { id: transactionId } of listed) {
      await db.$executeRawUnsafe(`${correction}$1`, transactionId);
    }

    const applied = deploy(url);
    expect(applied.output).not.toMatch(REFUSAL);
    expect(applied.ok).toBe(true);
    const after = await shape(db);
    expect(after).toMatchObject(GUARDED);
    const recorded = before.rows.filter((r) => r.id !== overHttp && r.id !== forged);
    expect(after.rows.filter((r) => r.source_type === 'STATEMENT')).toEqual(recorded);
    expect(
      after.rows
        .filter((r) => r.source_type !== 'STATEMENT')
        .map((r) => [r.id, r.source_type])
        .sort(),
    ).toEqual(
      [
        [overHttp, 'STATEMENT_UNCONFIRMED'],
        [forged, 'STATEMENT_UNCONFIRMED'],
      ].sort(),
    );
  });
});
