import {
  createSystemContext,
  runUnscoped,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationRepository } from '../src/notification/notification.repository';
import { DispatcherConsumer } from '../src/intake/dispatcher.consumer';
import {
  ResolutionWorker,
  type ResolutionWorkerOptions,
} from '../src/resolution/resolution.worker';
import type {
  RecipientPort,
  RecipientQuery,
  RecipientResolution,
} from '../src/recipients/recipient.port';
import type { ScrubbedLogger } from '../src/logging/scrub';
import { SERVICE_NAME } from '../src/config/env';

/**
 * Scaffolding for the integration suites.
 *
 * Every suite under `test/` needs the real `rasta_notification` database with
 * this service's migration applied; the Kafka suites additionally need a
 * broker and skip visibly without one. Nothing is mocked that the assertion is
 * about: the CHECK constraints, the deferred foreign key, the `ON CONFLICT`
 * dedupe decision, the fenced claim — none of it is visible to a unit test.
 *
 * The one thing substituted is identity-service, behind the `RecipientPort`:
 * a fake that answers, refuses or throws on command is how the retry path is
 * proven without staging an outage. The real HTTP adapter has its own unit
 * suite; the identity-side authorization it depends on has its own test in
 * identity-service.
 */

export const DEDUPE_RETENTION_DAYS = 45;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_NOTIFICATION;
  if (!url) {
    throw new Error(
      'DATABASE_URL_NOTIFICATION is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up`, copy .env.example to .env, and apply this ' +
        "service's migration to rasta_notification first.",
    );
  }
  return url;
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

/** A fresh organization id per test, so suites never collide or share rows. */
export function newOrganizationId(): string {
  return `ORG_ITEST_${ulid()}`;
}

export function newUserId(): string {
  return `USR_${ulid()}`;
}

export function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: ulid(),
    correlationId: ulid(),
    authType: 'USER',
    roles: [],
    organizationIds: [],
    startedAt: Date.now(),
    ...overrides,
  } as RequestContext;
}

/** Runs `fn` as a user of `organizationId`. */
export function asUser<T>(
  organizationId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    context({ organizationId, userId, organizationIds: [organizationId] }),
    async () => fn(),
  );
}

/** Runs `fn` the way the consumer does: a system context carrying the event's tenant. */
export function asConsumer<T>(
  organizationId: string,
  correlationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    createSystemContext({ correlationId, organizationId, callerService: 'asset-service' }),
    async () => fn(),
  );
}

/** Runs `fn` the way the worker does for one claimed intent: a system context carrying its tenant. */
export function asWorker<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    createSystemContext({
      correlationId: `COR_${ulid()}`,
      organizationId,
      callerService: SERVICE_NAME,
    }),
    async () => fn(),
  );
}

export const silentLogger: ScrubbedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A logger that keeps every line, for the redaction assertions. */
export function capturingLogger(): ScrubbedLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => void lines.push(message);
  return { lines, info: push, warn: push, error: push, debug: push };
}

// ---------------------------------------------------------------------------
// Envelopes, as the producers emit them
// ---------------------------------------------------------------------------

export const INSURANCE_TOPIC = 'rasta.insurance.v1';
export const MAINTENANCE_TOPIC = 'rasta.maintenance.v1';

export function insuranceExpiring(input: {
  organizationId: string;
  policyId: string;
  daysRemaining: number;
  assetId?: string;
  eventId?: string;
  streamSeq?: number;
  occurredAt?: string;
}): EventEnvelope {
  return {
    eventId: input.eventId ?? ulid(),
    eventName: 'INSURANCE_EXPIRING',
    eventVersion: 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'InsurancePolicy',
    aggregateId: input.policyId,
    tenantId: input.organizationId,
    correlationId: `COR_${ulid()}`,
    ...(input.streamSeq !== undefined
      ? { streamSeq: input.streamSeq, streamKey: input.policyId }
      : {}),
    payload: {
      assetId: input.assetId ?? `AST_${ulid()}`,
      organizationId: input.organizationId,
      policyId: input.policyId,
      insurerName: 'بیمه آزمون',
      validTo: new Date(Date.now() + input.daysRemaining * 86_400_000).toISOString(),
      daysRemaining: input.daysRemaining,
    },
  };
}

export function maintenanceDue(input: {
  organizationId: string;
  scheduleId: string;
  assetId?: string;
  state?: string;
  eventId?: string;
  correlationId?: string;
}): EventEnvelope {
  return {
    eventId: input.eventId ?? ulid(),
    eventName: 'MAINTENANCE_DUE',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'maintenance-service',
    producerVersion: '0.1.0',
    aggregateType: 'MaintenanceSchedule',
    aggregateId: input.scheduleId,
    tenantId: input.organizationId,
    correlationId: input.correlationId ?? `COR_${ulid()}`,
    payload: {
      scheduleId: input.scheduleId,
      assetId: input.assetId ?? `AST_${ulid()}`,
      organizationId: input.organizationId,
      title: 'سرویس دوره‌ای',
      basis: 'HOURS',
      state: input.state ?? 'DUE_SOON',
      dueBy: null,
      dueAtMeter: '1200',
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * A recipient port under test control.
 *
 * `answers` maps organization → recipients; an organization with no entry
 * resolves to nobody. `failWith` makes every call reject until cleared, which
 * is how an identity outage is staged.
 */
export class FakeRecipientPort implements RecipientPort {
  readonly queries: RecipientQuery[] = [];
  readonly answers = new Map<string, { userId: string; role: string }[]>();
  failWith?: Error;
  truncated = false;

  async resolve(query: RecipientQuery): Promise<RecipientResolution> {
    this.queries.push(query);
    if (this.failWith) throw this.failWith;
    return {
      recipients: (this.answers.get(query.organizationId) ?? []).slice(0, query.limit),
      truncated: this.truncated,
    };
  }
}

export interface Wiring {
  prisma: PrismaService;
  repository: NotificationRepository;
  consumer: DispatcherConsumer;
  worker: ResolutionWorker;
  recipients: FakeRecipientPort;
}

export const workerOptions: ResolutionWorkerOptions = {
  pollIntervalMs: 60_000,
  batchSize: 100,
  leaseSeconds: 60,
  backoffMaxSeconds: 600,
  maxRecipients: 500,
  inAppTtlDays: 60,
  owner: `${SERVICE_NAME}@itest`,
};

/**
 * The domain, wired by hand — no Nest container, no broker. The consumer's
 * `handle` is invoked directly with an envelope, exactly as `EventConsumer`
 * would after parsing; the worker's `tick` is invoked directly instead of
 * waiting on its timer.
 */
export function wire(
  logger: ScrubbedLogger = silentLogger,
  options: Partial<ResolutionWorkerOptions> = {},
): Wiring {
  const prisma = newPrisma();
  const repository = new NotificationRepository(prisma);
  const recipients = new FakeRecipientPort();
  const consumer = new DispatcherConsumer(
    () => {
      throw new Error('these suites drive handle() directly');
    },
    repository,
    DEDUPE_RETENTION_DAYS,
    logger,
  );
  const worker = new ResolutionWorker(
    repository,
    recipients,
    { ...workerOptions, ...options },
    logger,
  );
  return { prisma, repository, consumer, worker, recipients };
}

/** Delivers one envelope the way the consumer would: inside the event's tenant context. */
export function deliver(wiring: Wiring, envelope: EventEnvelope, topic = INSURANCE_TOPIC) {
  return asConsumer(envelope.tenantId as string, envelope.correlationId, () =>
    wiring.consumer.handle(envelope, Object.freeze({ topic, partition: 0 })),
  );
}

/**
 * Removes everything the listed organizations wrote.
 *
 * Children before parents, because every foreign key is `ON DELETE RESTRICT`.
 * `processed_event` carries no tenant, so its rows are matched through the
 * intents they produced; a deduped event that produced no intent leaves a
 * marker behind, which is harmless — its id is a fresh ULID no other run uses.
 */
export async function cleanup(prisma: PrismaService, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const where = { organizationId: { in: organizationIds } };

  await runUnscoped('integration cleanup removes exactly what the suite wrote', async () => {
    const intents = await prisma.client.notificationIntent.findMany({
      where,
      select: { sourceEventId: true },
    });
    await prisma.client.inAppNotification.deleteMany({ where });
    await prisma.client.deliveryAttempt.deleteMany({ where });
    await prisma.client.notificationDelivery.deleteMany({ where });
    await prisma.client.recipientResolution.deleteMany({ where });
    await prisma.client.notificationDedupe.deleteMany({ where });
    await prisma.client.notificationIntent.deleteMany({ where });
    await prisma.client.processedEvent.deleteMany({
      where: { eventId: { in: intents.map((intent) => intent.sourceEventId) } },
    });
  });
}

/** Every row one organization holds, read without a tenant context — for assertions only. */
export function rowsFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped("integration assertions read one organization's rows directly", async () => ({
    intents: await prisma.client.notificationIntent.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }),
    dedupe: await prisma.client.notificationDedupe.findMany({ where: { organizationId } }),
    resolutions: await prisma.client.recipientResolution.findMany({ where: { organizationId } }),
    deliveries: await prisma.client.notificationDelivery.findMany({ where: { organizationId } }),
    attempts: await prisma.client.deliveryAttempt.findMany({ where: { organizationId } }),
    inApp: await prisma.client.inAppNotification.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }),
  }));
}

/**
 * The broker list, or `undefined` when none is configured — returned rather
 * than thrown so the Kafka suite can *skip* visibly on a machine without a
 * broker, while the database suites still run.
 */
export function brokers(): string[] | undefined {
  const raw = process.env.KAFKA_BROKERS?.trim();
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Waits for `predicate` to hold, bounded by wall clock rather than by turns. */
export async function waitFor<T>(
  describe: string,
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
