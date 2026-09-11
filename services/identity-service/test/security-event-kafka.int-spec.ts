import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  type EventEnvelope,
} from '@rasta/contracts';
import { EventConsumer, type EventDelivery, type OutboxRelay } from '@rasta/nest-common';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { AuditTrailPublisher } from '../src/security-events/audit-trail.publisher';
import { REFUSAL_SITES } from '../src/security-events/refusal-sites';
import { SECURITY_EVENT_RELAY } from '../src/security-events/security-event.relay';
import { RUN_TAG, atFreshWindow, id, waitFor, waitForWindowClose } from './helpers';
import { startIdentityApi, userToken, type Caller, type IdentityApiHarness } from './api-helpers';

/**
 * The refusal outbox against a real Kafka broker (ADR-053 § 4, AUD-004 Phases
 * C1–C2) — corrected topology.
 *
 * ## What changed, and why
 *
 * The suite this file replaces (`refusal-audit-flow.int-spec.ts`) composed
 * `AuditTrailConsumer` and `AuditRepository` from `audit-service/src/**`
 * in-process to observe the message this service published. AGENTS.md A-02
 * forbids exactly that: a service reaches another only over REST or Kafka,
 * and a test file is not an exception — its imports still couple a build of
 * identity-service to audit-service's source tree, which
 * `scripts/check-service-boundaries.mjs` now refuses on every run of
 * `pnpm verify`.
 *
 * This file proves the same production boundary — a real refusal becomes a
 * real, contract-valid message on `rasta.audit.trail.v1` — by consuming that
 * topic as an **external observer**: a bare `EventConsumer` (the platform's
 * own Kafka client, `@rasta/nest-common`, shared by every service) with a
 * handler that validates each envelope against the public contracts
 * (`@rasta/contracts`) audit-service is itself held to. Nothing here
 * imports, mocks or instantiates anything under `services/audit-service`.
 * What audit-service actually *does* with a contract-valid message —
 * persistence, the hash chain, idempotent redelivery, tenant-mismatch
 * rejection — is audit-service's own claim, proved in its own
 * `test/trail-ingestion.int-spec.ts` and `test/kafka-projector.int-spec.ts`
 * against fixtures built from the same public contracts. Proving it twice
 * from two different services would not make either proof stronger; it
 * would only give the two suites a reason to drift.
 *
 * ## Aggregation on the wire (Phase C2)
 *
 * The relay runs for real, polling every 200 ms, with a three-second
 * aggregation window (configuration, not a bypass). Matching refusals are
 * counted into one row; the suite watches that row stay unpublished — and the
 * topic stay silent about it — for as long as its window is open, then sees
 * exactly one message carrying the aggregated count once it closes.
 *
 * The full system — this service's `403`, through Kafka, into
 * audit-service's own store, readable through its own API — is proved
 * without any in-process coupling by the black-box scenario in
 * `tests/e2e/specs/identity/01-refusal-audit-trail.e2e-spec.ts`, which starts
 * both services as separate processes and observes only HTTP and the
 * database each service owns.
 */

const brokerList = process.env.KAFKA_BROKERS
  ? process.env.KAFKA_BROKERS.split(',')
      .map((broker) => broker.trim())
      .filter(Boolean)
  : null;
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[identity] KAFKA_BROKERS is not set — skipping the security-event Kafka tests');
}

/** A fresh group replays the trail topic from the start before reaching this run's messages. */
const CATCH_UP_TIMEOUT_MS = 600_000;
/** One window, one relay poll, one broker round trip — with rejoin slack. */
const DELIVERY_TIMEOUT_MS = 120_000;
/** Short enough to watch close; long enough for a burst to land in one window. */
const WINDOW_SECONDS = 3;

const SITE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const USER_AGENT = `Mozilla/5.0 (identity kafka itest ${RUN_TAG})`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ObservedMessage {
  envelope: EventEnvelope;
  delivery: EventDelivery;
}

/** Every well-formed `AUDIT_EVENT_RECORDED` envelope seen on the trail topic, keyed by eventId. */
class TrailObserver {
  private readonly seen = new Map<string, ObservedMessage[]>();
  private consumer?: EventConsumer;

  async start(): Promise<void> {
    this.consumer = new EventConsumer(
      {
        brokers: brokerList as string[],
        clientId: `identity-itest-trail-observer-${ulid().slice(-8)}`,
        groupId: `identity-itest-trail-observer-${ulid().slice(-12)}`,
        topics: [AUDIT_TRAIL_TOPIC],
        fromBeginning: true,
        // A message this observer cannot make sense of is not this test's
        // problem to retry — audit-service's own consumer owns that judgment.
        deadLetterTopic: undefined,
      },
      async (envelope, delivery) => {
        const list = this.seen.get(envelope.eventId) ?? [];
        list.push({ envelope, delivery });
        this.seen.set(envelope.eventId, list);
      },
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    await this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  deliveriesOf(eventId: string): ObservedMessage[] {
    return this.seen.get(eventId) ?? [];
  }
}

describeWithKafka('security_event_outbox → rasta.audit.trail.v1 (real Kafka)', () => {
  let identity: IdentityApiHarness;
  let observer: TrailObserver;

  interface Refusal {
    caller: Caller;
    requested: string;
    correlationId: string;
    token: string;
    /** The row this refusal was counted into. */
    eventId: string;
  }

  const newCaller = (): Caller => ({
    userId: id('USR'),
    organizationId: id('ORG'),
    roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
  });

  /** A real refusal through the real endpoint; returns the identity row it was counted into. */
  async function refuse(caller: Caller = newCaller()): Promise<Refusal> {
    const requested = `ORG-REQ-${RUN_TAG}-${ulid()}`;
    const correlationId = id('COR');
    const token = userToken(caller);

    const response = await request(identity.app.getHttpServer())
      .post(`${SITE.route}?access_token=kafka-secret-${RUN_TAG}`)
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

  const rowOf = (eventId: string) =>
    identity.prisma.client.securityEventOutbox.findUniqueOrThrow({ where: { id: eventId } });

  beforeAll(async () => {
    observer = new TrailObserver();
    await observer.start();

    identity = await startIdentityApi({
      runSecurityRelay: true,
      flushIntervalMs: 200,
      aggregationWindowSeconds: WINDOW_SECONDS,
    });

    // Drain once: the observer's group reaches this run's first refusal only
    // after everything the topic already held.
    const sentinel = await refuse();
    await waitFor(
      'the trail observer to catch up with the topic',
      async () => observer.deliveriesOf(sentinel.eventId).length > 0,
      CATCH_UP_TIMEOUT_MS,
      1000,
    );
  }, CATCH_UP_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    await observer?.stop();
    if (identity) {
      await identity.prisma.client.$executeRawUnsafe(
        'DELETE FROM security_event_outbox WHERE actor_id LIKE $1',
        `%_${RUN_TAG}_%`,
      );
      await identity.close();
    }
  }, 120_000);

  it(
    'publishes nothing while a window is open, then one contract-valid AUDIT_EVENT_RECORDED envelope with the aggregated count',
    async () => {
      const caller = newCaller();
      await atFreshWindow(identity.prisma, WINDOW_SECONDS, 2_000);

      const first = await refuse(caller);
      const second = await refuse(caller);
      const third = await refuse(caller);
      expect(second.eventId).toBe(first.eventId);
      expect(third.eventId).toBe(first.eventId);
      const eventId = first.eventId;
      expect((await rowOf(eventId)).occurrenceCount).toBe(3);

      // The relay polls every 200 ms throughout. Until just before the window
      // ends on the database clock, the row is neither claimed nor published,
      // and nothing about it reaches the topic.
      let openChecks = 0;
      for (;;) {
        const [{ open }] = await identity.prisma.client.$queryRawUnsafe<{ open: boolean }[]>(
          `SELECT window_ends_at > (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                                   + interval '150 milliseconds' AS open
             FROM security_event_outbox WHERE id = $1`,
          eventId,
        );
        if (!open) break;
        const row = await rowOf(eventId);
        expect(row.publishedAt).toBeNull();
        expect(row.claimCount).toBe(0);
        expect(observer.deliveriesOf(eventId)).toHaveLength(0);
        openChecks += 1;
        await sleep(100);
      }
      expect(openChecks).toBeGreaterThan(0);

      const [delivered] = await waitFor(
        'a delivery of the aggregated refusal event',
        async () => {
          const found = observer.deliveriesOf(eventId);
          return found.length > 0 ? found : null;
        },
        DELIVERY_TIMEOUT_MS,
      );

      const { envelope, delivery } = delivered!;
      const row = await rowOf(eventId);
      expect(delivery.topic).toBe(AUDIT_TRAIL_TOPIC);
      expect(envelope.eventId).toBe(eventId);
      expect(envelope.eventName).toBe(AUDIT_EVENT_RECORDED);
      expect(envelope.producer).toBe('identity-service');
      expect(envelope.tenantId).toBe(caller.organizationId);
      // The first occurrence's correlation, trace and instant.
      expect(envelope.correlationId).toBe(first.correlationId);
      expect(envelope.traceparent).toBe(TRACEPARENT);
      expect(envelope.occurredAt).toBe(row.occurredAt.toISOString());

      // The wire contract this service is held to — the same schema
      // audit-service validates against, applied here as an external reader
      // rather than assumed.
      const payload = auditTrailPayloadSchemaV1.parse(envelope.payload);
      expect(payload).toMatchObject({
        actor: {
          type: 'USER',
          id: caller.userId,
          roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
        },
        organizationId: caller.organizationId,
        action: SITE.action,
        resourceType: SITE.resourceType,
        resourceId: caller.userId,
        outcome: 'REFUSED',
        errorCode: 'TENANT_MISMATCH',
        reason: SITE.reason,
        occurrenceCount: 3,
      });
      expect(payload.source?.userAgent).toBe(USER_AGENT);
      expect(typeof payload.source?.ip).toBe('string');

      // No sensitive value reached the wire, in either the envelope or the
      // payload — from any of the three requests.
      const wire = JSON.stringify({ envelope, payload });
      for (const leaked of [
        first.requested,
        second.requested,
        third.requested,
        first.token,
        `kafka-secret-${RUN_TAG}`,
        'You are not a member',
      ]) {
        expect(wire).not.toContain(leaked);
      }

      // Own database only: acknowledged once the broker took it, count unchanged.
      await waitFor(
        'the identity row to be acknowledged',
        async () => (await rowOf(eventId)).publishedAt,
        DELIVERY_TIMEOUT_MS,
      );
      expect(await rowOf(eventId)).toMatchObject({ occurrenceCount: 3 });
      await sleep(500);
      expect(observer.deliveriesOf(eventId)).toHaveLength(1);
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );

  it(
    'the second site: repeated GET /v1/users role refusals in one window become one contract-valid INSUFFICIENT_ROLE event with their count',
    async () => {
      const LIST = REFUSAL_SITES.LIST_USERS;
      const caller: Caller = { userId: id('USR'), organizationId: id('ORG'), roles: ['AUDITOR'] };
      const token = userToken(caller);
      const querySecret = `list-secret-${RUN_TAG}`;
      await atFreshWindow(identity.prisma, WINDOW_SECONDS, 2_000);

      const correlations: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const correlationId = id('COR');
        correlations.push(correlationId);
        const response = await request(identity.app.getHttpServer())
          .get(`${LIST.route}?q=${querySecret}`)
          .set('authorization', `Bearer ${token}`)
          .set('user-agent', USER_AGENT)
          .set('x-correlation-id', correlationId);
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          code: ERROR_CODES.INSUFFICIENT_ROLE,
          message: 'You do not have permission to perform this action',
          correlationId,
        });
      }

      const rows = await identity.prisma.client.securityEventOutbox.findMany({
        where: { actorId: caller.userId },
      });
      expect(rows).toHaveLength(1);
      const eventId = rows[0]!.id;
      expect(rows[0]!.occurrenceCount).toBe(3);

      // Silent on the topic while the window is open.
      await sleep(500);
      if ((await rowOf(eventId)).windowEndsAt.getTime() > Date.now() + 300) {
        expect(observer.deliveriesOf(eventId)).toHaveLength(0);
        expect((await rowOf(eventId)).publishedAt).toBeNull();
      }

      const [delivered] = await waitFor(
        'a delivery of the aggregated role refusal',
        async () => {
          const found = observer.deliveriesOf(eventId);
          return found.length > 0 ? found : null;
        },
        DELIVERY_TIMEOUT_MS,
      );
      const { envelope, delivery } = delivered!;
      expect(delivery.topic).toBe(AUDIT_TRAIL_TOPIC);
      expect(envelope.eventName).toBe(AUDIT_EVENT_RECORDED);
      expect(envelope.eventId).toBe(eventId);
      expect(envelope.tenantId).toBe(caller.organizationId);
      expect(envelope.correlationId).toBe(correlations[0]);

      const payload = auditTrailPayloadSchemaV1.parse(envelope.payload);
      expect(payload).toMatchObject({
        actor: { type: 'USER', id: caller.userId, roles: ['AUDITOR'] },
        organizationId: caller.organizationId,
        action: 'identity.users.list',
        resourceType: 'User',
        resourceId: caller.userId,
        outcome: 'REFUSED',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: LIST.reason,
        occurrenceCount: 3,
      });

      const wire = JSON.stringify({ envelope, payload });
      for (const leaked of [
        querySecret,
        token,
        'ORGANIZATION_ADMIN',
        'UNION_ADMIN',
        'You do not have permission',
      ]) {
        expect(wire).not.toContain(leaked);
      }

      await waitFor(
        'the role refusal row to be acknowledged',
        async () => (await rowOf(eventId)).publishedAt,
        DELIVERY_TIMEOUT_MS,
      );
      await sleep(500);
      expect(observer.deliveriesOf(eventId)).toHaveLength(1);
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );

  it(
    'lease fencing: a reclaimed aggregated row is redelivered with the same eventId and count, and the stale claim cannot mark it published',
    async () => {
      const relay = identity.moduleRef.get<OutboxRelay>(SECURITY_EVENT_RELAY);
      await relay.stop();

      try {
        const caller = newCaller();
        await atFreshWindow(identity.prisma, WINDOW_SECONDS, 1_500);
        const refusal = await refuse(caller);
        expect((await refuse(caller)).eventId).toBe(refusal.eventId);
        await waitForWindowClose(identity.prisma, refusal.eventId);

        const store = identity.store;
        const publisher = new AuditTrailPublisher(identity.moduleRef.get(KafkaEventPublisher));

        // Worker A claims with a one-second lease, publishes to the real
        // broker, and stalls before acknowledging.
        const first = await store.claimPending({ limit: 1000, owner: 'worker-a', leaseSeconds: 1 });
        const fromA = first.rows.find((row) => row.id === refusal.eventId);
        expect(fromA).toBeDefined();
        await publisher.publish([fromA!]);

        await sleep(1_500);

        // Worker B takes the expired lease back and publishes the same row
        // again — exactly what an at-least-once redelivery looks like on the
        // wire: the same logical event, published twice.
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

        // Fencing is a property of this service's own store: only the
        // current owner's token may mark the row published.
        expect(await store.markPublished([refusal.eventId], second.token!)).toBe(1);
        expect(await store.markPublished([refusal.eventId], first.token!)).toBe(0);
        await store.release(
          second.rows.map((row) => row.id).filter((rowId) => rowId !== refusal.eventId),
          second.token!,
        );

        // Both publishes actually reached the broker, each a contract-valid
        // copy of the same event with the same count — proving the
        // redelivery this test forced is indistinguishable, on the wire, from
        // a real one. That a consumer collapses the two into one record is
        // audit-service's own claim (`test/trail-ingestion.int-spec.ts`,
        // "duplicate delivery").
        const deliveries = await waitFor(
          'both deliveries of the redelivered event',
          async () => {
            const found = observer.deliveriesOf(refusal.eventId);
            return found.length >= 2 ? found : null;
          },
          DELIVERY_TIMEOUT_MS,
        );
        expect(deliveries).toHaveLength(2);
        for (const { envelope } of deliveries) {
          expect(envelope.eventId).toBe(refusal.eventId);
          expect(auditTrailPayloadSchemaV1.parse(envelope.payload).occurrenceCount).toBe(2);
        }
        expect(await rowOf(refusal.eventId)).toMatchObject({ occurrenceCount: 2, claimCount: 2 });
      } finally {
        relay.start();
      }
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );
});
