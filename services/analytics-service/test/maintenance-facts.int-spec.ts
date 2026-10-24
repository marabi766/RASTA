import { DLQ_REASONS } from '@rasta/contracts';
import { UnprocessableEventError, createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { MAINTENANCE_FACTS_CONSUMER } from '../src/maintenance/maintenance-fact';
import {
  cleanup,
  databaseUrl,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  ownerClient,
  wire,
  type Wiring,
} from './helpers';

/**
 * The MAINTENANCE_COMPLETED projection against a real PostgreSQL (ADR-071 § 2, RUN-001 PR 1):
 * idempotent on the event and on the fact, tenant-safe, and append-only.
 */

let w: Wiring;
/** A plain runtime-role client: what the service may do, without the guard or the consumer. */
let runtime: PrismaClient;
let owner: PrismaClient;
const organizations: string[] = [];
const events: string[] = [];

const org = (): string => {
  const id = newOrganizationId();
  organizations.push(id);
  return id;
};
const tracked = <T extends { eventId: string }>(envelope: T): T => {
  events.push(envelope.eventId);
  return envelope;
};

beforeAll(() => {
  w = wire();
  runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  owner = ownerClient();
});

afterAll(async () => {
  await cleanup(organizations, events);
  await Promise.all([w.close(), runtime.$disconnect(), owner.$disconnect()]);
});

const factsOf = (organizationId: string) =>
  owner.factMaintenance.findMany({ where: { organizationId }, orderBy: { requestId: 'asc' } });
const markersOf = (...eventIds: string[]) =>
  owner.processedEvent.findMany({ where: { eventId: { in: eventIds } } });

/** The verdict a handler threw, or a failure if it did not throw one. */
async function verdictOf(handled: Promise<unknown>): Promise<UnprocessableEventError> {
  try {
    await handled;
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a dead-letter verdict');
}

describe('a completion becomes one fact', () => {
  it('writes the fact the event states, under its tenant, with its marker', async () => {
    const tenant = org();
    const completion = newCompletion(tenant, {
      scheduleId: `MSC_${ulid()}`,
      downtimeMinutes: null,
    });
    const event = tracked(maintenanceCompleted(completion));

    await expect(w.consumer.handle(event)).resolves.toBeUndefined();

    const [fact] = await factsOf(tenant);
    expect(fact).toMatchObject({
      organizationId: tenant,
      requestId: completion.requestId,
      assetId: completion.assetId,
      maintenanceType: 'PREVENTIVE',
      scheduleId: completion.scheduleId,
      completedAt: new Date(completion.completedAt),
      downtimeMinutes: null,
      totalCostMinor: 4_500_000n,
      currency: 'IRR',
      sourceEventId: event.eventId,
    });
    expect(await markersOf(event.eventId)).toEqual([
      expect.objectContaining({ eventId: event.eventId, consumerName: MAINTENANCE_FACTS_CONSUMER }),
    ]);
  });
});

describe('idempotency (A-09)', () => {
  it('applies the same event delivered twice once', async () => {
    const tenant = org();
    const event = tracked(maintenanceCompleted(newCompletion(tenant)));

    await w.consumer.handle(event);
    await expect(w.consumer.handle(event)).resolves.toBe('SKIPPED');

    expect(await factsOf(tenant)).toHaveLength(1);
    expect(await markersOf(event.eventId)).toHaveLength(1);
  });

  it('takes another event stating the same completion as no second effect, and marks it', async () => {
    const tenant = org();
    const completion = newCompletion(tenant);
    const first = tracked(maintenanceCompleted(completion));
    const republished = tracked(maintenanceCompleted(completion));

    await w.consumer.handle(first);
    await expect(w.consumer.handle(republished)).resolves.toBe('SKIPPED');

    const facts = await factsOf(tenant);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.sourceEventId).toBe(first.eventId);
    expect(await markersOf(first.eventId, republished.eventId)).toHaveLength(2);
  });

  it.each([
    ['the cost', { totalCostMinor: '4500001' }, 'totalCostMinor'],
    ['the type', { type: 'CORRECTIVE' }, 'maintenanceType'],
    ['the completion instant', { completedAt: '2026-10-10T07:31:00.000Z' }, 'completedAt'],
    ['the downtime', { downtimeMinutes: 121 }, 'downtimeMinutes'],
    ['the machine', { assetId: 'AST_OTHER' }, 'assetId'],
  ])(
    'dead-letters an event that contradicts %s, keeps the first fact, and leaves no marker',
    async (_label, change, field) => {
      const tenant = org();
      const completion = newCompletion(tenant);
      const first = tracked(maintenanceCompleted(completion));
      const contradicting = tracked(maintenanceCompleted({ ...completion, ...change }));

      await w.consumer.handle(first);
      const error = await verdictOf(w.consumer.handle(contradicting));

      expect(error.reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
      expect(error.message).toContain(field);
      const facts = await factsOf(tenant);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ sourceEventId: first.eventId, totalCostMinor: 4_500_000n });
      expect(await markersOf(contradicting.eventId)).toEqual([]);
      // No marker, so a replay of the same contradiction is judged again — never skipped.
      expect((await verdictOf(w.consumer.handle(contradicting))).reason).toBe(
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );
    },
  );
});

/**
 * Two deliveries for one completion at once. The second's insert waits on the fact's key until
 * the first commits or rolls back; it is then judged against what committed. Made deterministic
 * by holding the first as an open transaction and releasing it only once the second is seen
 * waiting on a lock — parallel calls alone need not overlap at all.
 */
describe('a delivery racing another for the same completion', () => {
  async function waitUntilBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await runtime.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE '%fact_maintenance%'`;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the second delivery never waited on the fact key');
  }

  /** Holds an uncommitted fact for the completion until `release` is called with a verdict. */
  function holdCompetingFact(
    completion: ReturnType<typeof newCompletion>,
    competitorEvent: string,
  ) {
    let release!: (commit: boolean) => void;
    const decided = new Promise<boolean>((resolve) => (release = resolve));
    let inserted!: () => void;
    const ready = new Promise<void>((resolve) => (inserted = resolve));
    const transaction = runtime
      .$transaction(
        async (tx) => {
          await tx.factMaintenance.create({
            data: {
              organizationId: completion.organizationId,
              requestId: completion.requestId,
              assetId: completion.assetId,
              maintenanceType: completion.type,
              scheduleId: completion.scheduleId,
              completedAt: new Date(completion.completedAt),
              downtimeMinutes: completion.downtimeMinutes,
              totalCostMinor: BigInt(completion.totalCostMinor),
              currency: completion.currency,
              sourceEventId: competitorEvent,
            },
          });
          inserted();
          if (!(await decided)) throw new Error('competitor rolled back on purpose');
        },
        { timeout: 60_000 },
      )
      .catch((error: Error) => {
        if (error.message !== 'competitor rolled back on purpose') throw error;
      });
    return { ready, release, transaction };
  }

  it('judges the waiting delivery against the fact that committed first: a contradiction is refused', async () => {
    const tenant = org();
    const completion = newCompletion(tenant);
    const competitor = `EVT_${ulid()}`;
    const contradicting = tracked(maintenanceCompleted({ ...completion, totalCostMinor: '1' }));

    const hold = holdCompetingFact(completion, competitor);
    await hold.ready;
    const handled = verdictOf(w.consumer.handle(contradicting));
    await waitUntilBlocked();
    hold.release(true);
    await hold.transaction;

    expect((await handled).reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
    const facts = await factsOf(tenant);
    expect(facts.map((fact) => fact.sourceEventId)).toEqual([competitor]);
    expect(await markersOf(contradicting.eventId)).toEqual([]);
  });

  it('applies the waiting delivery when the one ahead of it rolls back', async () => {
    const tenant = org();
    const completion = newCompletion(tenant);
    const waiting = tracked(maintenanceCompleted({ ...completion, totalCostMinor: '1' }));

    const hold = holdCompetingFact(completion, `EVT_${ulid()}`);
    await hold.ready;
    const handled = w.consumer.handle(waiting);
    await waitUntilBlocked();
    hold.release(false);
    await hold.transaction;

    await expect(handled).resolves.toBeUndefined();
    const facts = await factsOf(tenant);
    expect(facts.map((fact) => [fact.sourceEventId, fact.totalCostMinor])).toEqual([
      [waiting.eventId, 1n],
    ]);
  });
});

describe('tenant isolation (A-04)', () => {
  it('keeps the same request id of two organizations as two facts, each in its own tenant', async () => {
    const a = org();
    const b = org();
    const requestId = `MRQ_${ulid()}`;
    await w.consumer.handle(tracked(maintenanceCompleted(newCompletion(a, { requestId }))));
    await w.consumer.handle(
      tracked(maintenanceCompleted(newCompletion(b, { requestId, totalCostMinor: '7' }))),
    );

    expect((await factsOf(a)).map((f) => f.totalCostMinor)).toEqual([4_500_000n]);
    expect((await factsOf(b)).map((f) => f.totalCostMinor)).toEqual([7n]);
  });

  it('reads one organization’s facts and never another’s through the guarded repository', async () => {
    const a = org();
    const b = org();
    await w.consumer.handle(tracked(maintenanceCompleted(newCompletion(a))));
    await w.consumer.handle(
      tracked(maintenanceCompleted(newCompletion(b, { type: 'CORRECTIVE' }))),
    );

    const totalsFor = (tenant: string) =>
      runWithContext(
        createSystemContext({
          correlationId: ulid(),
          organizationId: tenant,
          callerService: 'test',
        }),
        () =>
          w.facts.fleetMaintenance(
            new Date('2026-10-01T00:00:00.000Z'),
            new Date('2026-11-01T00:00:00.000Z'),
          ),
      );
    expect((await totalsFor(a)).rows.map((row) => row.maintenanceType)).toEqual(['PREVENTIVE']);
    expect((await totalsFor(b)).rows.map((row) => row.maintenanceType)).toEqual(['CORRECTIVE']);
  });

  it.each([
    ['no tenant on the envelope', (tenant: string) => ({ tenantId: undefined, tenant })],
    [
      'a payload organization that is not the envelope’s',
      (tenant: string) => ({ tenantId: newOrganizationId(), tenant }),
    ],
  ])(
    'refuses %s as VALIDATION_FAILED, writing nothing in either organization',
    async (_label, shape) => {
      const tenant = org();
      const { tenantId } = shape(tenant);
      if (tenantId) organizations.push(tenantId);
      const event = tracked(maintenanceCompleted(newCompletion(tenant), { tenantId }));

      expect((await verdictOf(w.consumer.handle(event))).reason).toBe(
        DLQ_REASONS.VALIDATION_FAILED,
      );
      expect(await factsOf(tenant)).toEqual([]);
      if (tenantId) expect(await factsOf(tenantId)).toEqual([]);
      expect(await markersOf(event.eventId)).toEqual([]);
    },
  );

  it('refuses a payload that fails its schema before any marker, so a fixed replay still applies', async () => {
    const tenant = org();
    const completion = newCompletion(tenant);
    const eventId = ulid();
    const broken = tracked(
      maintenanceCompleted(completion, { eventId, payload: { totalCostMinor: '-1' } }),
    );

    expect((await verdictOf(w.consumer.handle(broken))).reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(await markersOf(eventId)).toEqual([]);

    await expect(
      w.consumer.handle(maintenanceCompleted(completion, { eventId })),
    ).resolves.toBeUndefined();
    expect(await factsOf(tenant)).toHaveLength(1);
  });
});

describe('a fact is never changed or erased', () => {
  let tenant: string;
  beforeAll(async () => {
    tenant = org();
    await w.consumer.handle(tracked(maintenanceCompleted(newCompletion(tenant))));
  });

  it.each([
    ['UPDATE', `UPDATE "fact_maintenance" SET "total_cost_minor" = 0 WHERE "organization_id" = $1`],
    ['DELETE', `DELETE FROM "fact_maintenance" WHERE "organization_id" = $1`],
  ])('refuses %s, even by the owner', async (operation, sql) => {
    await expect(owner.$executeRawUnsafe(sql, tenant)).rejects.toThrow(
      new RegExp(`ck_fact_maintenance_append_only.*${operation} refused`),
    );
    expect(await factsOf(tenant)).toHaveLength(1);
  });

  it('refuses TRUNCATE, even by the owner', async () => {
    await expect(owner.$executeRawUnsafe('TRUNCATE "fact_maintenance"')).rejects.toThrow(
      /ck_fact_maintenance_append_only.*TRUNCATE refused/,
    );
  });

  it.each([
    ['a negative cost', 'total_cost_minor', '-1', 'ck_fact_maintenance_cost_nonneg'],
    ['a negative downtime', 'downtime_minutes', '-1', 'ck_fact_maintenance_downtime_nonneg'],
    ['a type that is not a code', 'maintenance_type', `'preventive'`, 'ck_fact_maintenance_type'],
    ['a currency that is not ISO 4217', 'currency', `'ir'`, 'ck_fact_maintenance_currency'],
    ['a blank request', 'request_id', `' '`, 'ck_fact_maintenance_ids'],
  ])('refuses %s written past the consumer', async (_label, column, value, constraint) => {
    const values: Record<string, string> = {
      organization_id: `'${tenant}'`,
      request_id: `'MRQ_${ulid()}'`,
      asset_id: `'AST_1'`,
      maintenance_type: `'PREVENTIVE'`,
      completed_at: 'now()',
      downtime_minutes: 'NULL',
      total_cost_minor: '0',
      currency: `'IRR'`,
      source_event_id: `'EVT_RAW'`,
      [column]: value,
    };
    const columns = Object.keys(values)
      .map((name) => `"${name}"`)
      .join(', ');
    await expect(
      runtime.$executeRawUnsafe(
        `INSERT INTO "fact_maintenance" (${columns}) VALUES (${Object.values(values).join(', ')})`,
      ),
    ).rejects.toThrow(new RegExp(constraint));
  });
});

describe('recorded_at is the database clock at the insert (ADR-071 § 2 (8))', () => {
  it('stamps the insert itself — not the transaction’s start, and not what the writer sent', async () => {
    // A governance release cut decides membership and lateness by `recorded_at` (ADR-071 § 5):
    // a transaction that began before a cut and inserts after it must not be stamped before
    // it, and a writer must not be able to backdate a fact into a released period.
    const tenant = org();
    const [stamp] = await runtime.$transaction(async (tx) => {
      const [{ started }] = await tx.$queryRaw<{ started: Date }[]>`SELECT now() AS started`;
      await tx.$executeRaw`SELECT pg_sleep(0.3)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "fact_maintenance" ("organization_id", "request_id", "asset_id",
           "maintenance_type", "completed_at", "total_cost_minor", "currency", "source_event_id",
           "recorded_at")
         VALUES ($1, $2, 'AST_1', 'PREVENTIVE', now(), 0, 'IRR', 'EVT_RAW',
           '2000-01-01T00:00:00Z')`,
        tenant,
        `MRQ_${ulid()}`,
      );
      const [{ recorded }] = await tx.$queryRaw<{ recorded: Date }[]>`
        SELECT recorded_at AS recorded FROM fact_maintenance WHERE organization_id = ${tenant}`;
      return [{ started, recorded }];
    });

    expect(stamp!.recorded.getTime()).toBeGreaterThanOrEqual(stamp!.started.getTime() + 250);
  });
});
