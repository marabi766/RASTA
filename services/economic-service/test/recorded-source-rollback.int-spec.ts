import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runWithContext, type EventConsumer, type RequestContext } from '@rasta/nest-common';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { PaymentService } from '../src/payment/payment.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma';
import { asActor, id, ownerDatabaseUrl, testEnv, wire } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

/**
 * `20261017130000_transaction_recorded_source` over rows that already exist
 * (review of #334 round 1, F2).
 *
 * `down.sql` keeps every row, so the next `migrate deploy` meets what the
 * owners recorded meanwhile: it must accept those — each provably its
 * owner's — and still refuse, changing nothing, a row the previous release let
 * a caller write under a reserved key. And the correction its HINT names must
 * be one that lets it apply: cancelling such a row (round 1's HINT) does not,
 * because a cancelled row keeps its source fields and so the key.
 *
 * Every step is the real one, in a scratch schema built by the real
 * migrations as the database's owner and dropped at the end: `migrate deploy`,
 * the whole `down.sql` through `prisma db execute`, `migrate resolve`; the
 * owners' rows written by the real writers — SettlementAuthorityConsumer, the
 * top-up's capture, and TransactionService as marketplace-service's call
 * reaches it; the callers' rows by the same TransactionService as a person.
 */

const MIGRATION = '20261017130000_transaction_recorded_source';
const SERVICE_DIR = join(__dirname, '..');
const MIGRATION_DIR = join(SERVICE_DIR, 'prisma', 'migrations', MIGRATION);
const REFUSAL =
  /transaction: (\d+) row\(s\) claim source_type MAINTENANCE_REQUEST, PAYMENT_INTENT or ORDER without being recorded by its owner; refusing to reserve them/;
const RESERVED = ['MAINTENANCE_REQUEST', 'PAYMENT_INTENT', 'ORDER'];

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

const resolveRolledBack = (url: string) =>
  mustRun(['migrate', 'resolve', '--rolled-back', MIGRATION, '--schema', 'prisma/schema.prisma'], {
    url,
  });

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
    list: /List them with: (SELECT [\s\S]*?); none is/.exec(text)![1]!,
    correction: /(UPDATE "transaction" SET [^<]*)<id>/.exec(text)![1]!,
  };
}

describe(`${MIGRATION}: down, then up again, over rows already recorded`, () => {
  jest.setTimeout(240_000);

  const schemas: string[] = [];
  const clients: PrismaClient[] = [];
  const services: PrismaService[] = [];
  let owner: PrismaClient;

  const BUYER = 'ORG_RSV_ROLLBACK_BUYER';
  const SUPPLIER = 'ORG_RSV_ROLLBACK_SUPPLIER';
  const ACCOMPLICE = 'ORG_RSV_ROLLBACK_ACCOMPLICE';

  const urlOf = (schema: string) => {
    const url = new URL(ownerDatabaseUrl());
    url.searchParams.set('schema', schema);
    return url.toString();
  };

  /** A schema holding every migration of this release, and the writers over it. */
  async function scratch() {
    const schema = `rsv_rollback_${ulid().toLowerCase()}`;
    schemas.push(schema);
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = urlOf(schema);
    mustRun(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { url });
    const db = new PrismaClient({ datasources: { db: { url } } });
    clients.push(db);
    const prisma = new PrismaService(url);
    await prisma.onModuleInit();
    services.push(prisma);
    const wiring = wire(prisma);
    const sources = new FakeSourceFacts();
    const consumer = new SettlementAuthorityConsumer(
      () =>
        ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer,
      prisma,
      wiring.transactions,
      sources,
    );
    const payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      new MockPaymentProvider(),
      wiring.paymentReconciliation,
      testEnv(),
    );

    /** An approved repair, recorded by the consumer from MAINTENANCE_APPROVED. */
    async function approveRepair(): Promise<void> {
      const payload = {
        requestId: `MNT_${ulid()}`,
        assetId: `AST_${ulid()}`,
        organizationId: BUYER,
        approvedBy: 'USR-RSV-ROLLBACK',
        approvedAt: new Date().toISOString(),
        workshopOrganizationId: SUPPLIER,
        totalCostMinor: '640000',
        currency: 'IRR',
      };
      sources.approved(payload);
      await consumer.handle({
        eventId: ulid(),
        eventName: CONSUMED_EVENTS.MAINTENANCE_APPROVED,
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'maintenance-service',
        producerVersion: '0.1.0',
        aggregateType: 'MaintenanceRequest',
        aggregateId: payload.requestId,
        tenantId: BUYER,
        correlationId: `rsv-rollback-${ulid()}`,
        payload,
      } as EventEnvelope);
    }

    /** A captured top-up: the PAYMENT_INTENT row, written by the capture. */
    async function topUp(): Promise<void> {
      const wallet = await asActor({ organizationId: BUYER }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );
      await asActor({ organizationId: BUYER }, () =>
        payments.topUp(wallet.id, { amountMinor: '900000', idempotencyKey: `RSV-RB-${ulid()}` }),
      );
    }

    /** An order's obligation as marketplace-service's call records it: a service, no user. */
    async function sagaRecordsOrder(): Promise<void> {
      const orderId = `ORD_${ulid()}`;
      const context: RequestContext = {
        correlationId: `rsv-rollback-${ulid()}`,
        requestId: ulid(),
        organizationId: BUYER,
        roles: [],
        organizationIds: [],
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        startedAt: Date.now(),
      };
      await runWithContext(context, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: SUPPLIER,
          grossAmountMinor: '250000',
          currency: 'IRR',
          sourceType: 'ORDER',
          sourceReference: orderId,
          holdFunds: false,
          idempotencyKey: `order:${orderId}:hold`,
        }),
      );
    }

    /**
     * What the previous release's POST /v1/transactions let a person write
     * under a reserved type: the route's own service call, as that person.
     */
    async function personRecords(
      sourceType: string,
      transactionType: 'MARKETPLACE_ORDER' | 'MAINTENANCE_SERVICE',
    ): Promise<string> {
      const created = await asActor({ organizationId: BUYER }, () =>
        wiring.transactions.create({
          transactionType,
          counterpartyOrganizationId: ACCOMPLICE,
          grossAmountMinor: '1',
          currency: 'IRR',
          sourceType,
          sourceReference: `REF_${ulid()}`,
          holdFunds: false,
          idempotencyKey: id('rsv-rollback-http'),
        }),
      );
      return created.id;
    }

    return { url, db, wiring, approveRepair, topUp, sagaRecordsOrder, personRecords };
  }

  /** What `down.sql` and the migration could change: the guards, the ledger row, the rows. */
  async function shape(db: PrismaClient) {
    const count = async (sql: string, ...values: unknown[]) =>
      Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql, ...values))[0]!.n);
    const constraint = (name: string) =>
      count(
        `SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace
          WHERE s.nspname = current_schema() AND c.conname = $1`,
        name,
      );
    return {
      recordedSource: await constraint('ck_transaction_recorded_source'),
      orderSource: await constraint('ck_transaction_order_source'),
      applied: await count(
        `SELECT count(*) AS n FROM "_prisma_migrations"
          WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
        MIGRATION,
      ),
      rows: (
        await db.$queryRawUnsafe<{ row: string }[]>(
          `SELECT to_jsonb(t)::text AS row FROM "transaction" t
            WHERE source_type LIKE ANY (ARRAY['MAINTENANCE_REQUEST%', 'PAYMENT_INTENT%', 'ORDER%'])
            ORDER BY id`,
        )
      ).map(({ row }) => JSON.parse(row) as Record<string, unknown>),
    };
  }

  const GUARDED = { recordedSource: 1, orderSource: 1, applied: 1 };
  const UNGUARDED = { recordedSource: 0, orderSource: 0, applied: 0 };

  beforeAll(() => {
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterAll(async () => {
    for (const service of services) await service.onModuleDestroy();
    for (const client of clients) await client.$disconnect();
    for (const schema of schemas) {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; it names only a
      // scratch schema this suite created (`rsv_rollback_<ulid>`).
      await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await owner?.$disconnect();
  });

  it('up → each owner’s rows → down → more of them → up: accepted as they are, and the guards hold again', async () => {
    const { url, db, approveRepair, topUp, sagaRecordsOrder, personRecords } = await scratch();
    await approveRepair();
    await topUp();
    await sagaRecordsOrder();
    const recorded = await shape(db);
    expect(recorded).toMatchObject(GUARDED);
    expect(recorded.rows.map((r) => r.source_type).sort()).toEqual(RESERVED.slice().sort());

    // down: the guards and the ledger row go; every row stays exactly.
    runDown(url);
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: recorded.rows });

    // The owners keep recording while the previous release runs.
    await approveRepair();
    await topUp();
    await sagaRecordsOrder();
    const meanwhile = await shape(db);
    expect(meanwhile.rows).toHaveLength(6);

    // up again: applied, nothing refused, every row unchanged.
    const again = deploy(url);
    expect(again.output).not.toMatch(REFUSAL);
    expect(again.ok).toBe(true);
    expect(again.output).toContain(MIGRATION);
    expect(await shape(db)).toEqual({ ...GUARDED, rows: meanwhile.rows });

    // The CHECKs hold again: a person's row under a reserved type is refused.
    await expect(personRecords('ORDER', 'MARKETPLACE_ORDER')).rejects.toThrow(
      /ck_transaction_order_source/,
    );
    await expect(personRecords('MAINTENANCE_REQUEST', 'MAINTENANCE_SERVICE')).rejects.toThrow(
      /ck_transaction_recorded_source/,
    );
  });

  it('refuses, changing nothing, rows a caller wrote during the rollback — cancelling one does not unblock it, and the HINT’s correction does', async () => {
    const { url, db, wiring, approveRepair, topUp, sagaRecordsOrder, personRecords } =
      await scratch();
    await approveRepair();
    await topUp();
    await sagaRecordsOrder();
    runDown(url);

    // The previous release, running: POST /v1/transactions reserves nothing,
    // so the buyer's administrator records under each type...
    const personOrder = await personRecords('ORDER', 'MARKETPLACE_ORDER');
    const personRepair = await personRecords('MAINTENANCE_REQUEST', 'MAINTENANCE_SERVICE');
    // ...and rows shaped exactly like the owners' that are not theirs: a
    // repair whose causation another consumer — not this one — marked
    // processed, and a top-up no payment intent records as its own.
    const elsewhere = ulid();
    await db.processedEvent.create({
      data: { eventId: elsewhere, consumerName: 'economic-service.statement-settlement' },
    });
    const forgedRepair = id('TXN');
    await db.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
         transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
         source_reference, causation_id, correlation_id, created_by, updated_at)
       VALUES ($1, $2, $3, 'MAINTENANCE_SERVICE', 'PENDING_SETTLEMENT', 1, 'IRR', now(),
         'MAINTENANCE_REQUEST', $4, $5, 'corr-forged', 'economic-service', now())`,
      forgedRepair,
      BUYER,
      ACCOMPLICE,
      `MNT_${ulid()}`,
      elsewhere,
    );
    const forgedTopUp = id('TXN');
    await db.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, transaction_type, status,
         gross_amount_minor, net_amount_minor, currency, occurred_at, settled_at,
         source_type, source_reference, correlation_id, created_by, updated_at)
       VALUES ($1, $2, 'WALLET_TOP_UP', 'SETTLED', 1, 1, 'IRR', now(), now(),
         'PAYMENT_INTENT', $3, 'corr-forged', 'economic-service', now())`,
      forgedTopUp,
      BUYER,
      `PAY_${ulid()}`,
    );
    const untrusted = [personOrder, personRepair, forgedRepair, forgedTopUp].sort();

    const before = await shape(db);
    expect(before.rows).toHaveLength(7);

    const refused = deploy(url);
    expect(refused.ok).toBe(false);
    expect(REFUSAL.exec(refused.output)?.[1]).toBe('4');
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: before.rows });
    resolveRolledBack(url);

    // Round 1's HINT: cancel it. The financial decision is recorded — and the
    // row keeps its source fields, so the migration refuses exactly as before.
    await asActor({ organizationId: BUYER }, () =>
      wiring.transactions.cancel(personOrder, 'Not an order this organization placed'),
    );
    const cancelled = await shape(db);
    expect(cancelled.rows.find((r) => r.id === personOrder)?.status).toBe('CANCELLED');
    const stillRefused = deploy(url);
    expect(stillRefused.ok).toBe(false);
    expect(REFUSAL.exec(stillRefused.output)?.[1]).toBe('4');
    resolveRolledBack(url);

    // The HINT now: its list — exactly the four — each taken off the reserved
    // type as it says, then deploy again.
    const { list, correction } = hint();
    const listed = await db.$queryRawUnsafe<{ id: string }[]>(list);
    expect(listed.map((r) => r.id).sort()).toEqual(untrusted);
    for (const { id: transactionId } of listed) {
      await db.$executeRawUnsafe(`${correction}$1`, transactionId);
    }

    const applied = deploy(url);
    expect(applied.output).not.toMatch(REFUSAL);
    expect(applied.ok).toBe(true);
    const after = await shape(db);
    expect(after).toMatchObject(GUARDED);

    // The owners' rows are untouched; the callers' rows keep every financial
    // fact and only leave the reserved key.
    expect(after.rows.filter((r) => !untrusted.includes(r.id as string))).toEqual(
      cancelled.rows.filter((r) => !untrusted.includes(r.id as string)),
    );
    for (const transactionId of untrusted) {
      const was = cancelled.rows.find((r) => r.id === transactionId)!;
      const now = after.rows.find((r) => r.id === transactionId)!;
      expect(now).toEqual({
        ...was,
        source_type: `${String(was.source_type)}_UNCONFIRMED`,
        updated_at: now.updated_at,
      });
    }
  });
});
