import { withUtcSession } from '@rasta/config';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaintenanceFactRepository } from '../src/maintenance/maintenance-fact.repository';
import { MaintenanceFactsConsumer } from '../src/maintenance/maintenance-facts.consumer';

/**
 * Scaffolding for the integration suites.
 *
 * Everything asserted under `test/` is a property only PostgreSQL has: the keys that decide
 * whether a second event makes a second fact, the wait one delivery makes on another's key, the
 * rollback that takes a refused event's marker with it, the append-only trigger, the tenant guard
 * against real rows. None of it is visible to a unit test, so the helpers are thin and touch the
 * real database.
 *
 * Needs `DATABASE_URL_ANALYTICS` (the runtime role of `rasta_analytics`) with this service's
 * migration applied (`pnpm --filter @rasta/analytics-service db:migrate`).
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ANALYTICS;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ANALYTICS is not set. These tests run against a real PostgreSQL; start it ' +
        "with `pnpm infra:up` and apply this service's migration first.",
    );
  }
  return withUtcSession(url);
}

/**
 * The owner connection the suites' cleanup alone may use to lift the append-only trigger
 * (`DATABASE_URL_ANALYTICS_MIGRATOR`). **Required, with no fallback** to the runtime URL: since
 * D-045 the runtime role owns nothing and cannot lift a trigger, and a suite that fell back would
 * fail for a reason that hides the real one — a missing variable.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_ANALYTICS_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ANALYTICS_MIGRATOR is not set. The suites lift the append-only trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export const newOrganizationId = (): string => `ORG_${ulid()}`;

/** What maintenance-service publishes for one completed request, unless a test says otherwise. */
export interface CompletionFixture {
  readonly organizationId: string;
  readonly requestId: string;
  readonly assetId: string;
  readonly type: string;
  readonly scheduleId: string | null;
  readonly completedAt: string;
  readonly downtimeMinutes: number | null;
  readonly totalCostMinor: string;
  readonly currency: string;
}

export function newCompletion(
  organizationId: string,
  overrides: Partial<CompletionFixture> = {},
): CompletionFixture {
  return {
    organizationId,
    requestId: `MRQ_${ulid()}`,
    assetId: `AST_${ulid()}`,
    type: 'PREVENTIVE',
    scheduleId: null,
    completedAt: '2026-10-10T07:30:00.000Z',
    downtimeMinutes: 120,
    totalCostMinor: '4500000',
    currency: 'IRR',
    ...overrides,
  };
}

/** The `MAINTENANCE_COMPLETED` envelope as maintenance-service publishes it. */
export function maintenanceCompleted(
  completion: CompletionFixture,
  overrides: { tenantId?: string | undefined; eventId?: string; payload?: object } = {},
): EventEnvelope {
  const tenantId = 'tenantId' in overrides ? overrides.tenantId : completion.organizationId;
  return eventEnvelopeSchema.parse({
    eventId: overrides.eventId ?? ulid(),
    eventName: 'MAINTENANCE_COMPLETED',
    eventVersion: 1,
    occurredAt: completion.completedAt,
    producer: 'maintenance-service',
    aggregateType: 'MaintenanceRequest',
    aggregateId: completion.requestId,
    ...(tenantId === undefined ? {} : { tenantId }),
    correlationId: ulid(),
    payload: {
      requestId: completion.requestId,
      assetId: completion.assetId,
      organizationId: completion.organizationId,
      type: completion.type,
      scheduleId: completion.scheduleId,
      completedAt: completion.completedAt,
      downtimeMinutes: completion.downtimeMinutes,
      totalCostMinor: completion.totalCostMinor,
      currency: completion.currency,
      ...overrides.payload,
    },
  }) as EventEnvelope;
}

export interface Wiring {
  prisma: PrismaService;
  facts: MaintenanceFactRepository;
  /** The projection's handler, without a broker: `consumer.handle(envelope)`. */
  consumer: MaintenanceFactsConsumer;
  close(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

export function wire(): Wiring {
  const prisma = new PrismaService(databaseUrl());
  const facts = new MaintenanceFactRepository(prisma);
  const consumer = new MaintenanceFactsConsumer(
    () => {
      throw new Error('these suites drive handle(); nothing subscribes');
    },
    prisma,
    facts,
    silent,
  );
  return { prisma, facts, consumer, close: () => prisma.disconnect() };
}

/** A connection as the owner, for the suites' inspection and cleanup only. */
export function ownerClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
}

/**
 * Removes everything the given organizations' facts and the given events' markers left. A fact
 * is never deleted by the service (`tg_fact_maintenance_append_only`), so the suite's own removal
 * goes through the **owner** connection and lifts the trigger for the length of one transaction —
 * never through the runtime `PrismaService` under test.
 */
export async function cleanup(organizationIds: string[], eventIds: string[] = []): Promise<void> {
  const owner = ownerClient();
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "fact_maintenance" DISABLE TRIGGER "tg_fact_maintenance_append_only"',
      );
      if (organizationIds.length > 0) {
        await tx.factMaintenance.deleteMany({ where: { organizationId: { in: organizationIds } } });
      }
      await tx.$executeRawUnsafe(
        'ALTER TABLE "fact_maintenance" ENABLE TRIGGER "tg_fact_maintenance_append_only"',
      );
    });
    if (eventIds.length > 0) {
      await owner.processedEvent.deleteMany({ where: { eventId: { in: eventIds } } });
    }
  } finally {
    await owner.$disconnect();
  }
}
