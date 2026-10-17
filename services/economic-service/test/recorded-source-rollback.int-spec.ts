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
 * because a cancelled row keeps its source fields and so the key; renaming its
 * source type to `<type>_UNCONFIRMED` (round 2's) does not either once that
 * key is held too (review of #334 round 2, F3). The quarantine
 * (`20261017125000_transaction_source_quarantine`) takes the key off the row
 * and keeps it apart, so it collides with nothing.
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

/** A migration's whole `down.sql`, as the rollback runbook runs it. */
const downOf = (url: string, migration: string) =>
  prismaCli(['db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'], {
    url,
    stdin: readFileSync(join(SERVICE_DIR, 'prisma', 'migrations', migration, 'down.sql'), 'utf8'),
  });

const runDown = (url: string) => {
  const result = downOf(url, MIGRATION);
  if (!result.ok) throw new Error(`down.sql failed:\n${result.output.slice(0, 1200)}`);
};

/** The migration the HINT's correction comes from, applied before MIGRATION. */
const QUARANTINE = '20261017125000_transaction_source_quarantine';

/**
 * The HINT's SQL, as the operator reads it out of the error: its quotes
 * undoubled. The correction is a call naming the transaction and the decision.
 */
function hint(): { list: string; quarantine: string } {
  const sql = readFileSync(join(MIGRATION_DIR, 'migration.sql'), 'utf8');
  const text = /USING HINT = '((?:[^']|'')*)';/.exec(sql)![1]!.replace(/''/g, "'");
  return {
    list: /List them with: (SELECT [\s\S]*?); none is/.exec(text)![1]!,
    quarantine: /SELECT (\w+)\('<id>', '<decision reference>'\);/.exec(text)![1]!,
  };
}

/** Round 2's correction, which the HINT named before: a rename within the source key. */
const RENAME = `UPDATE "transaction" SET source_type = source_type || '_UNCONFIRMED' WHERE id = $1`;

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
      sourceReference = `REF_${ulid()}`,
    ): Promise<string> {
      const created = await asActor({ organizationId: BUYER }, () =>
        wiring.transactions.create({
          transactionType,
          counterpartyOrganizationId: ACCOMPLICE,
          grossAmountMinor: '1',
          currency: 'IRR',
          sourceType,
          sourceReference,
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
    const json = async (sql: string) =>
      (await db.$queryRawUnsafe<{ row: string }[]>(sql)).map(
        ({ row }) => JSON.parse(row) as Record<string, unknown>,
      );
    return {
      recordedSource: await constraint('ck_transaction_recorded_source'),
      orderSource: await constraint('ck_transaction_order_source'),
      applied: await count(
        `SELECT count(*) AS n FROM "_prisma_migrations"
          WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
        MIGRATION,
      ),
      // Every row under (or once under) a reserved type, its look-alikes included.
      rows: await json(
        `SELECT to_jsonb(t)::text AS row FROM "transaction" t
          WHERE source_type LIKE ANY (ARRAY['MAINTENANCE_REQUEST%', 'PAYMENT_INTENT%', 'ORDER%'])
             OR id IN (SELECT transaction_id FROM transaction_source_quarantine)
          ORDER BY id`,
      ),
      quarantined: await json(
        `SELECT to_jsonb(q)::text AS row FROM transaction_source_quarantine q ORDER BY transaction_id`,
      ),
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
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: recorded.rows, quarantined: [] });

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
    expect(await shape(db)).toEqual({ ...GUARDED, rows: meanwhile.rows, quarantined: [] });

    // The CHECKs hold again: a person's row under a reserved type is refused.
    await expect(personRecords('ORDER', 'MARKETPLACE_ORDER')).rejects.toThrow(
      /ck_transaction_order_source/,
    );
    await expect(personRecords('MAINTENANCE_REQUEST', 'MAINTENANCE_SERVICE')).rejects.toThrow(
      /ck_transaction_recorded_source/,
    );
  });

  /**
   * The previous release, running after `down.sql`: POST /v1/transactions
   * reserves nothing, so the buyer's administrator records under each type,
   * and rows shaped exactly like the owners' that are not theirs exist too.
   * Each one's `<type>_UNCONFIRMED` key under the same reference is already
   * held as well — by the same administrator, which the previous release (and
   * this one) allows (review of #334 round 2, F3).
   */
  async function untrustedRows(
    db: PrismaClient,
    personRecords: Awaited<ReturnType<typeof scratch>>['personRecords'],
  ) {
    const keys = {
      order: `ORD_${ulid()}`,
      repair: `MNT_${ulid()}`,
      forgedRepair: `MNT_${ulid()}`,
      forgedTopUp: `PAY_${ulid()}`,
    };
    const personOrder = await personRecords('ORDER', 'MARKETPLACE_ORDER', keys.order);
    const personRepair = await personRecords(
      'MAINTENANCE_REQUEST',
      'MAINTENANCE_SERVICE',
      keys.repair,
    );
    // A repair whose causation another consumer — not this one — marked
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
      keys.forgedRepair,
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
      keys.forgedTopUp,
    );

    // The quarantine keys round 2's rename would have taken, each held already.
    const occupied = [
      await personRecords('ORDER_UNCONFIRMED', 'MARKETPLACE_ORDER', keys.order),
      await personRecords('MAINTENANCE_REQUEST_UNCONFIRMED', 'MAINTENANCE_SERVICE', keys.repair),
      await personRecords(
        'MAINTENANCE_REQUEST_UNCONFIRMED',
        'MAINTENANCE_SERVICE',
        keys.forgedRepair,
      ),
      await personRecords('PAYMENT_INTENT_UNCONFIRMED', 'MAINTENANCE_SERVICE', keys.forgedTopUp),
    ];
    return {
      personOrder,
      untrusted: [personOrder, personRepair, forgedRepair, forgedTopUp].sort(),
      occupied,
    };
  }

  it('refuses, changing nothing, rows a caller wrote during the rollback; with their quarantine keys held, the rename collides and the HINT’s quarantine applies', async () => {
    const { url, db, wiring, approveRepair, topUp, sagaRecordsOrder, personRecords } =
      await scratch();
    await approveRepair();
    await topUp();
    await sagaRecordsOrder();
    runDown(url);

    const { personOrder, untrusted, occupied } = await untrustedRows(db, personRecords);

    const before = await shape(db);
    expect(before.rows).toHaveLength(11);

    const refused = deploy(url);
    expect(refused.ok).toBe(false);
    expect(REFUSAL.exec(refused.output)?.[1]).toBe('4');
    expect(await shape(db)).toEqual({ ...UNGUARDED, rows: before.rows, quarantined: [] });
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

    // Round 2's HINT: rename to <type>_UNCONFIRMED. Each new key is held, so
    // each rename is refused by the unique index, and nothing changes.
    for (const transactionId of untrusted) {
      await expect(db.$executeRawUnsafe(RENAME, transactionId)).rejects.toThrow(
        /Code: `23505`[\s\S]*\(organization_id, source_type, source_reference\)=[\s\S]*already exists/,
      );
    }
    expect(await shape(db)).toEqual(cancelled);

    // The HINT now: its list — exactly the four — each quarantined, naming the
    // decision, then deploy again.
    const { list, quarantine } = hint();
    const listed = await db.$queryRawUnsafe<{ id: string }[]>(list);
    expect(listed.map((r) => r.id).sort()).toEqual(untrusted);
    for (const { id: transactionId } of listed) {
      await db.$executeRawUnsafe(
        `SELECT ${quarantine}($1, $2)`,
        transactionId,
        `DEC-${transactionId}: not its owner's fact`,
      );
    }

    const applied = deploy(url);
    expect(applied.output).not.toMatch(REFUSAL);
    expect(applied.ok).toBe(true);
    const after = await shape(db);
    expect(after).toMatchObject(GUARDED);

    // The owners' rows and the occupied keys' rows are untouched.
    expect(after.rows.filter((r) => !untrusted.includes(r.id as string))).toEqual(
      cancelled.rows.filter((r) => !untrusted.includes(r.id as string)),
    );
    expect(occupied.every((held) => after.rows.some((r) => r.id === held))).toBe(true);

    // The callers' rows keep every fact but the key; the key is kept apart,
    // exactly as the row carried it, with the decision and who took it.
    const migrator = decodeURIComponent(new URL(ownerDatabaseUrl()).username);
    for (const transactionId of untrusted) {
      const was = cancelled.rows.find((r) => r.id === transactionId)!;
      const now = after.rows.find((r) => r.id === transactionId)!;
      expect(now).toEqual({ ...was, source_type: null, source_reference: null });
      expect(after.quarantined.find((q) => q.transaction_id === transactionId)).toEqual({
        transaction_id: transactionId,
        organization_id: was.organization_id,
        source_type: was.source_type,
        source_reference: was.source_reference,
        decision: `DEC-${transactionId}: not its owner's fact`,
        quarantined_by: migrator,
        quarantined_at: expect.any(String),
      });
    }
    expect(after.quarantined).toHaveLength(4);
  });

  it('the quarantine refuses what it cannot keep, and what it keeps is never changed', async () => {
    const { db, personRecords } = await scratch();
    const call = (transactionId: string, decision: string) =>
      db.$executeRawUnsafe(`SELECT quarantine_transaction_source($1, $2)`, transactionId, decision);

    const keyed = await personRecords('E2E', 'MARKETPLACE_ORDER');
    await expect(call(id('TXN'), 'DEC-1: no such row')).rejects.toThrow(/no such transaction/);
    await expect(call(keyed, '   short ')).rejects.toThrow(
      /ck_transaction_source_quarantine_decision/,
    );
    await call(keyed, 'DEC-2: taken off for the test');
    // Taken once: the row holds no key any more.
    await expect(call(keyed, 'DEC-3: a second time')).rejects.toThrow(/holds no source key/);

    // Append-only, and the transaction it keeps a key for cannot go.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE transaction_source_quarantine SET source_type = 'X' WHERE transaction_id = $1`,
        keyed,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(
        `DELETE FROM transaction_source_quarantine WHERE transaction_id = $1`,
        keyed,
      ),
    ).rejects.toThrow(/append-only/);
    // ISOLATION-ALLOW-UNBOUNDED: TRUNCATE cannot carry a WHERE; this is a scratch schema.
    await expect(db.$executeRawUnsafe(`TRUNCATE transaction_source_quarantine`)).rejects.toThrow(
      /append-only/,
    );

    // An operator's tool: nobody but its owner may run it.
    const publicGrants = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n
         FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.proname = 'quarantine_transaction_source'
          AND p.pronamespace = current_schema()::regnamespace
          AND a.grantee = 0`,
    );
    expect(Number(publicGrants[0]!.n)).toBe(0);
  });

  it(`${QUARANTINE}'s down refuses while a key is quarantined, and goes cleanly when none is`, async () => {
    const used = await scratch();
    const keyed = await used.personRecords('E2E', 'MARKETPLACE_ORDER');
    await used.db.$executeRawUnsafe(
      `SELECT quarantine_transaction_source($1, $2)`,
      keyed,
      'DEC-4: taken off for the test',
    );
    runDown(used.url);
    const refused = downOf(used.url, QUARANTINE);
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(
      /transaction_source_quarantine holds 1 row\(s\); refusing to drop the source keys they keep/,
    );
    expect((await shape(used.db)).quarantined).toHaveLength(1);

    const unused = await scratch();
    runDown(unused.url);
    expect(downOf(unused.url, QUARANTINE).ok).toBe(true);
    const gone = await unused.db.$queryRawUnsafe<{ t: string | null; f: string | null }[]>(
      `SELECT to_regclass('transaction_source_quarantine')::text AS t,
              to_regprocedure('quarantine_transaction_source(text, text)')::text AS f`,
    );
    expect(gone).toEqual([{ t: null, f: null }]);

    // Both forward again, in order.
    const again = deploy(unused.url);
    expect(again.ok).toBe(true);
    expect(again.output).toContain(QUARANTINE);
    expect(again.output).toContain(MIGRATION);
  });
});
