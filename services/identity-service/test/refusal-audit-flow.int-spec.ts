import request from 'supertest';
import { ulid } from 'ulid';
import { AUDIT_EVENT_RECORDED, AUDIT_TRAIL_TOPIC, ERROR_CODES } from '@rasta/contracts';
import { EventConsumer, type OutboxRelay } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { AuditTrailPublisher } from '../src/security-events/audit-trail.publisher';
import { REFUSAL_SITES } from '../src/security-events/refusal-sites';
import { SECURITY_EVENT_RELAY } from '../src/security-events/security-event.relay';
import { startIdentityApi, userToken, type Caller, type IdentityApiHarness } from './api-helpers';

// ---------------------------------------------------------------------------
// audit-service, composed in-process for this one test file only.
//
// AGENTS.md A-02 forbids a service importing another service's source, and the
// runtime path proven here honours it completely: identity-service writes to
// its own database and publishes to Kafka; audit-service consumes from Kafka
// and writes to its own database. Nothing crosses in memory — the only thing
// the two halves share is the broker, exactly as in production.
//
// The import below is what lets one test drive both halves at once, and it is
// confined to `test/`, which is neither compiled nor linted into the service.
// The alternative — two suites in two packages, joined by messages one leaves
// on the topic for the other — would make each depend on the other having run
// first, which AGENTS.md § 5 forbids outright. So the composition is here, and
// it is named rather than hidden.
// ---------------------------------------------------------------------------
import { PrismaService as AuditPrismaService } from '../../audit-service/src/prisma/prisma.service';
import { AuditRepository } from '../../audit-service/src/audit/audit.repository';
import { AuditTrailConsumer } from '../../audit-service/src/consumers/audit-trail.consumer';
import { AUDIT_DEAD_LETTER_TOPIC } from '../../audit-service/src/audit/audit.mapper';
import { AUDIT_TRAIL_CONSUMER } from '../../audit-service/src/audit/audit-trail.mapper';
import {
  cleanupRun,
  id as auditRunId,
  newMigratorPrisma,
  RUN_TAG,
  waitFor,
} from '../../audit-service/test/helpers';

/**
 * AUD-004 Phase C1, end to end over a real broker and two real databases.
 *
 *   HTTP 403 → RefusalAuditExceptionFilter → security_event_outbox (identity DB)
 *            → refusal relay → rasta.audit.trail.v1 (Kafka)
 *            → AuditTrailConsumer → audit_event (audit DB)
 *
 * Nothing on that path is mocked except the token signature (see
 * `api-helpers.ts`). The consumer group is unique per run so this never
 * competes with a running stack, and every identifier carries audit-service's
 * `RUN_TAG` so its cleanup removes exactly this run's evidence and chain heads.
 */

const brokerList = process.env.KAFKA_BROKERS
  ? process.env.KAFKA_BROKERS.split(',')
      .map((broker) => broker.trim())
      .filter(Boolean)
  : null;
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[identity] KAFKA_BROKERS is not set — skipping the refusal audit flow tests');
}

/** A fresh group replays the trail topic from the start before reaching this run's messages. */
const CATCH_UP_TIMEOUT_MS = 600_000;
/** One relay poll, one broker round trip, one consumer transaction — with rejoin slack. */
const DELIVERY_TIMEOUT_MS = 120_000;

const SITE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const USER_AGENT = 'Mozilla/5.0 (identity to audit itest)';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A row flattened to comparable text — bigints and bytes included. */
const snapshot = (row: unknown): string =>
  JSON.stringify(row, (_key, value: unknown) =>
    typeof value === 'bigint'
      ? value.toString()
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('hex')
        : value,
  );

describeWithKafka('refusal audit flow: identity-service → Kafka → audit-service', () => {
  let identity: IdentityApiHarness;
  let auditPrisma: AuditPrismaService;
  let migrator: AuditPrismaService;
  let trail: AuditTrailConsumer;

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => silentLogger,
  } as unknown as Logger;

  interface Refusal {
    caller: Caller;
    requested: string;
    correlationId: string;
    token: string;
    eventId: string;
  }

  /** A real refusal through the real endpoint; returns the identity row's id. */
  async function refuse(): Promise<Refusal> {
    const caller: Caller = {
      userId: auditRunId('USR'),
      organizationId: auditRunId('ORG'),
      roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
    };
    // The body validator accepts `ORG_<ULID>` or the seed form `ORG-[A-Z0-9-]+`.
    const requested = `ORG-REQ-${RUN_TAG}-${ulid()}`;
    const correlationId = auditRunId('COR');
    const token = userToken(caller);

    const response = await request(identity.app.getHttpServer())
      .post(`${SITE.route}?access_token=flow-secret-${RUN_TAG}`)
      .set('authorization', `Bearer ${token}`)
      .set('user-agent', USER_AGENT)
      .set('x-correlation-id', correlationId)
      .set('traceparent', TRACEPARENT)
      .send({ organizationId: requested });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);

    const rows = await identity.prisma.client.securityEventOutbox.findMany({
      where: { actorId: caller.userId },
    });
    expect(rows).toHaveLength(1);
    return { caller, requested, correlationId, token, eventId: rows[0]!.id };
  }

  const auditRowFor = (eventId: string) => () =>
    auditPrisma.client.auditEvent.findFirst({
      where: { sourceEventId: eventId, sourceTopic: AUDIT_TRAIL_TOPIC },
    });

  beforeAll(async () => {
    const auditUrl = process.env.DATABASE_URL_AUDIT;
    if (!auditUrl) {
      throw new Error('DATABASE_URL_AUDIT is not set; this flow writes into the real audit store.');
    }
    auditPrisma = new AuditPrismaService(auditUrl);
    migrator = newMigratorPrisma();
    await auditPrisma.onModuleInit();
    await migrator.onModuleInit();

    trail = new AuditTrailConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'identity-itest-audit-trail',
            groupId: `identity-itest-trail-${ulid().slice(-12)}`,
            topics: [AUDIT_TRAIL_TOPIC],
            fromBeginning: true,
            deadLetterTopic: AUDIT_DEAD_LETTER_TOPIC,
            // Earlier runs' deliberately invalid fixtures are replayed too, and
            // are refused identically on every attempt.
            retryBackoffMs: 50,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      new AuditRepository(auditPrisma),
      silentLogger,
    );
    await trail.start();

    // The real refusal relay, polling fast.
    identity = await startIdentityApi({ runSecurityRelay: true, flushIntervalMs: 200 });

    // Drain once: the consumer reaches this run's first refusal only after
    // everything the topic already held.
    const sentinel = await refuse();
    await waitFor(
      'the audit consumer to catch up with the trail topic',
      auditRowFor(sentinel.eventId),
      CATCH_UP_TIMEOUT_MS,
      1000,
    );
  }, CATCH_UP_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    await trail?.onModuleDestroy();
    if (identity) {
      await identity.prisma.client.$executeRawUnsafe(
        'DELETE FROM security_event_outbox WHERE actor_id LIKE $1',
        `%_${RUN_TAG}_%`,
      );
      await identity.close();
    }
    if (migrator) await cleanupRun(migrator);
    await auditPrisma?.onModuleDestroy();
    await migrator?.onModuleDestroy();
  }, 120_000);

  it(
    'turns a real identity refusal into one REFUSED audit record with its actor, tenant and source',
    async () => {
      const refusal = await refuse();

      const row = await waitFor(
        'the refusal audit row',
        auditRowFor(refusal.eventId),
        DELIVERY_TIMEOUT_MS,
      );

      expect(row).toMatchObject({
        outcome: 'REFUSED',
        occurrenceCount: 1,
        actorType: 'USER',
        actorId: refusal.caller.userId,
        actorRoles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
        organizationId: refusal.caller.organizationId,
        action: SITE.action,
        resourceType: SITE.resourceType,
        resourceId: refusal.caller.userId,
        errorCode: 'TENANT_MISMATCH',
        reason: SITE.reason,
        sourceService: 'identity-service',
        sourceServiceVersion: '0.1.0-itest',
        sourceEventName: AUDIT_EVENT_RECORDED,
        sourceTopic: AUDIT_TRAIL_TOPIC,
        sourceUserAgent: USER_AGENT,
        correlationId: refusal.correlationId,
        traceparent: TRACEPARENT,
        changes: null,
        correctionOf: null,
      });
      expect(row.sourceIp).not.toBeNull();
      expect(row.recordHash).not.toBeNull();

      expect(
        await auditPrisma.client.processedEvent.count({
          where: { eventId: refusal.eventId, consumerName: AUDIT_TRAIL_CONSUMER },
        }),
      ).toBe(1);

      // The identity row is acknowledged once the broker took it.
      await waitFor(
        'the identity row to be acknowledged',
        async () =>
          (
            await identity.prisma.client.securityEventOutbox.findUniqueOrThrow({
              where: { id: refusal.eventId },
            })
          ).publishedAt,
        DELIVERY_TIMEOUT_MS,
      );

      // No sensitive value reached the permanent record.
      const stored = snapshot(row);
      for (const leaked of [
        refusal.requested,
        refusal.token,
        `flow-secret-${RUN_TAG}`,
        'You are not a member',
      ]) {
        expect(stored).not.toContain(leaked);
      }

      // Tenant isolation: nothing was written under the organization the caller
      // asked for, and nothing under any tenant but their own.
      expect(
        await auditPrisma.client.auditEvent.count({ where: { organizationId: refusal.requested } }),
      ).toBe(0);
      expect(
        await auditPrisma.client.auditEvent.count({
          where: {
            sourceEventId: refusal.eventId,
            NOT: { organizationId: refusal.caller.organizationId },
          },
        }),
      ).toBe(0);
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );

  it(
    'idempotent redelivery: two workers publishing one row produce one audit record, and the stale worker is fenced',
    async () => {
      const relay = identity.moduleRef.get<OutboxRelay>(SECURITY_EVENT_RELAY);
      await relay.stop();

      try {
        const refusal = await refuse();
        const store = identity.store;
        const publisher = new AuditTrailPublisher(identity.moduleRef.get(KafkaEventPublisher));

        // Worker A claims with a one-second lease, publishes, and stalls before acknowledging.
        const first = await store.claimPending({ limit: 1000, owner: 'worker-a', leaseSeconds: 1 });
        const fromA = first.rows.find((row) => row.id === refusal.eventId);
        expect(fromA).toBeDefined();
        await publisher.publish([fromA!]);

        await sleep(1_500);

        // Worker B takes the expired lease back and publishes the same row again.
        const second = await store.claimPending({
          limit: 1000,
          owner: 'worker-b',
          leaseSeconds: 60,
        });
        const fromB = second.rows.find((row) => row.id === refusal.eventId);
        expect(fromB).toBeDefined();
        expect(second.reclaimed).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(fromB!.payload)).toBe(JSON.stringify(fromA!.payload));
        await publisher.publish([fromB!]);

        expect(await store.markPublished([refusal.eventId], second.token!)).toBe(1);
        expect(await store.markPublished([refusal.eventId], first.token!)).toBe(0);
        await store.release(
          second.rows.map((row) => row.id).filter((id) => id !== refusal.eventId),
          second.token!,
        );

        await waitFor(
          'the redelivered refusal row',
          auditRowFor(refusal.eventId),
          DELIVERY_TIMEOUT_MS,
        );
        // Settle, then count: a count taken at once could pass only because the
        // second delivery had not arrived yet.
        await sleep(5_000);

        expect(
          await auditPrisma.client.auditEvent.count({ where: { sourceEventId: refusal.eventId } }),
        ).toBe(1);
        expect(
          await auditPrisma.client.processedEvent.count({
            where: { eventId: refusal.eventId, consumerName: AUDIT_TRAIL_CONSUMER },
          }),
        ).toBe(1);
      } finally {
        relay.start();
      }
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );
});
