import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  type EventEnvelope,
} from '@rasta/contracts';
import {
  EventConsumer,
  runUnscoped,
  type EventDelivery,
  type OutboxRelay,
} from '@rasta/nest-common';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { AuditTrailPublisher } from '../src/security-events/audit-trail.publisher';
import { REFUSAL_SITES, type RefusalSiteName } from '../src/security-events/refusal-sites';
import { SECURITY_EVENT_RELAY } from '../src/security-events/security-event.relay';
import { RUN_TAG, atFreshWindow, id, waitFor, waitForWindowClose } from './helpers';
import {
  serviceToken,
  startIdentityApi,
  userToken,
  type Caller,
  type IdentityApiHarness,
} from './api-helpers';
import { startAuditStub } from './audit-stub';

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

  /**
   * The roles-guard sites: GET /v1/users (Phase C3), POST /v1/users (Phase C4),
   * POST /v1/users/:id/memberships (Phase C5), POST /v1/memberships/:id/roles
   * (Phase C6), POST /v1/memberships/:id/revoke (Phase C7),
   * POST /v1/registration-requests/:id/approve (Phase C8) and
   * POST /v1/registration-requests/:id/reject (Phase C9). Each entry builds the
   * concrete path and body of the i-th refusal from the run's secret, so the
   * path id and the body differ on every request.
   */
  const roleRefusalSites: [
    string,
    RefusalSiteName,
    'get' | 'post',
    (secret: string, i: number) => { path: string; body?: Record<string, unknown> },
  ][] = [
    ['GET /v1/users', 'LIST_USERS', 'get', (secret) => ({ path: `/v1/users?q=${secret}` })],
    [
      'POST /v1/users',
      'CREATE_USER',
      'post',
      (secret, i) => ({
        path: `/v1/users?q=${secret}`,
        body: {
          username: `${secret}-${i}`,
          email: `${secret}@identity.itest`,
          roles: ['SYSTEM_ADMIN'],
        },
      }),
    ],
    [
      'POST /v1/users/:id/memberships',
      'ADD_MEMBERSHIP',
      'post',
      (secret, i) => ({
        path: `/v1/users/USR-${secret}-${i}/memberships?q=${secret}`,
        body: { organizationId: `ORG-${secret}-${i}`, roles: ['SYSTEM_ADMIN'] },
      }),
    ],
    [
      'POST /v1/memberships/:id/roles',
      'UPDATE_MEMBERSHIP_ROLES',
      'post',
      (secret, i) => ({
        path: `/v1/memberships/MBR-${secret}-${i}/roles?q=${secret}`,
        body: { roles: ['SYSTEM_ADMIN'], reason: `${secret}-reason-${i}` },
      }),
    ],
    [
      'POST /v1/memberships/:id/revoke',
      'REVOKE_MEMBERSHIP',
      'post',
      (secret, i) => ({
        path: `/v1/memberships/MBR-${secret}-${i}/revoke?q=${secret}`,
        body: { reason: `${secret}-revoke-reason-${i}` },
      }),
    ],
    [
      'POST /v1/registration-requests/:id/approve',
      'APPROVE_REGISTRATION_REQUEST',
      'post',
      (secret, i) => ({
        path: `/v1/registration-requests/REG-${secret}-${i}/approve?q=${secret}`,
        body: { organizationId: `ORG-${secret}-${i}`, roles: ['SYSTEM_ADMIN'] },
      }),
    ],
    [
      'POST /v1/registration-requests/:id/reject',
      'REJECT_REGISTRATION_REQUEST',
      'post',
      (secret, i) => ({
        path: `/v1/registration-requests/REG-${secret}-${i}/reject?q=${secret}`,
        body: { reason: `${secret}-reject-reason-${i}` },
      }),
    ],
  ];

  it.each(roleRefusalSites)(
    '%s: repeated role refusals in one window become one contract-valid INSUFFICIENT_ROLE event with their count',
    async (_label, siteName, method, build) => {
      const site = REFUSAL_SITES[siteName];
      const caller: Caller = { userId: id('USR'), organizationId: id('ORG'), roles: ['AUDITOR'] };
      const token = userToken(caller);
      const requestSecret = `role-refusal-secret-${RUN_TAG}`;
      await atFreshWindow(identity.prisma, WINDOW_SECONDS, 2_000);

      const correlations: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const correlationId = id('COR');
        correlations.push(correlationId);
        const { path, body } = build(requestSecret, i);
        const call = request(identity.app.getHttpServer())
          [method](path)
          .set('authorization', `Bearer ${token}`)
          .set('user-agent', USER_AGENT)
          .set('x-correlation-id', correlationId);
        // A body names what the caller wanted; none of it, nor the path id, is evidence.
        const response = await (body === undefined ? call : call.send(body));
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
        action: site.action,
        resourceType: site.resourceType,
        resourceId: caller.userId,
        outcome: 'REFUSED',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: site.reason,
        occurrenceCount: 3,
      });
      const expected: Record<RefusalSiteName, [string, string]> = {
        SWITCH_ACTIVE_ORGANIZATION: ['identity.active_organization.switch', 'User'],
        AUTH_TENANT_MISMATCH: ['identity.tenant_context.select', 'User'],
        SERVICE_CALLER_FORBIDDEN: ['identity.service_call.authorize', 'Service'],
        LIST_USERS: ['identity.users.list', 'User'],
        CREATE_USER: ['identity.users.create', 'User'],
        ADD_MEMBERSHIP: ['identity.memberships.create', 'Membership'],
        UPDATE_MEMBERSHIP_ROLES: ['identity.memberships.roles.replace', 'Membership'],
        REVOKE_MEMBERSHIP: ['identity.memberships.revoke', 'Membership'],
        APPROVE_REGISTRATION_REQUEST: [
          'identity.registration_requests.approve',
          'RegistrationRequest',
        ],
        REJECT_REGISTRATION_REQUEST: [
          'identity.registration_requests.reject',
          'RegistrationRequest',
        ],
      };
      expect([payload.action, payload.resourceType]).toEqual(expected[siteName]);

      const wire = JSON.stringify({ envelope, payload });
      for (const leaked of [
        requestSecret,
        token,
        'SYSTEM_ADMIN',
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
    'the auth guard tenant refusal: repeated probes in one window become one contract-valid TENANT_MISMATCH event with their count',
    async () => {
      // AUD-004 Phase C10. The refusal the platform `AuthGuard` itself makes,
      // before any controller authorization: each probe names a different
      // organization in `X-Organization-Id` and aims at a different endpoint,
      // and all of it aggregates into the one record the caller's own tenant
      // and actor identify.
      const site = REFUSAL_SITES.AUTH_TENANT_MISMATCH;
      const caller: Caller = { userId: id('USR'), organizationId: id('ORG'), roles: ['AUDITOR'] };
      const token = userToken(caller);
      const probeSecret = `tenant-probe-secret-${RUN_TAG}`;
      await atFreshWindow(identity.prisma, WINDOW_SECONDS, 2_000);

      const rejected: string[] = [];
      const correlations: string[] = [];
      const paths = ['/v1/users/me', '/v1/users', `/v1/users/USR-${probeSecret}`];
      for (let i = 0; i < 3; i += 1) {
        const requested = `ORG-REJECTED-${RUN_TAG}-${ulid()}`;
        const correlationId = id('COR');
        rejected.push(requested);
        correlations.push(correlationId);

        const response = await request(identity.app.getHttpServer())
          .get(`${paths[i]}?q=${probeSecret}`)
          .set('authorization', `Bearer ${token}`)
          .set('user-agent', USER_AGENT)
          .set('x-correlation-id', correlationId)
          .set('x-organization-id', requested);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          code: ERROR_CODES.TENANT_MISMATCH,
          message: 'You are not a member of the requested organization',
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
        'a delivery of the aggregated auth-guard refusal',
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
      // The tenant the caller legitimately acts for, from the verified token.
      expect(envelope.tenantId).toBe(caller.organizationId);
      expect(envelope.correlationId).toBe(correlations[0]);

      const payload = auditTrailPayloadSchemaV1.parse(envelope.payload);
      expect(payload).toMatchObject({
        actor: { type: 'USER', id: caller.userId, roles: ['AUDITOR'] },
        organizationId: caller.organizationId,
        action: site.action,
        resourceType: site.resourceType,
        resourceId: caller.userId,
        outcome: 'REFUSED',
        errorCode: 'TENANT_MISMATCH',
        reason: site.reason,
        occurrenceCount: 3,
      });

      // Nothing the caller chose reached the wire: not the organizations they
      // asked for, not the endpoints they aimed at, not the token.
      const wire = JSON.stringify({ envelope, payload });
      for (const leaked of [...rejected, probeSecret, token, '/v1/users', 'You are not a member']) {
        expect(wire).not.toContain(leaked);
      }

      await waitFor(
        'the auth-guard refusal row to be acknowledged',
        async () => (await rowOf(eventId)).publishedAt,
        DELIVERY_TIMEOUT_MS,
      );
      await sleep(500);
      expect(observer.deliveriesOf(eventId)).toHaveLength(1);
    },
    DELIVERY_TIMEOUT_MS + 60_000,
  );

  it(
    'the verified service caller refusal: repeated refusals in one window become one contract-valid FORBIDDEN event with their count, merged with nothing else',
    async () => {
      // AUD-004 Phase C11. The platform `AuthGuard` refuses a verified
      // internal `SERVICE` token at one refusal site, whether the endpoint
      // carries no `@AllowService` at all or carries one the caller is absent
      // from. NTF-001 made `GET /v1/users` service-callable, so these three
      // probes now cross both of the guard's FORBIDDEN branches and still
      // aggregate into the one row — which is what this test is about. The
      // actor on the wire is the token's signed subject and the tenant its
      // signed `org_id` — the unsigned `X-Organization-Id` each probe also
      // sends is never read, and never published.
      const site = REFUSAL_SITES.SERVICE_CALLER_FORBIDDEN;
      // Tagged, because a service row's actor id *is* the caller's name.
      const serviceName = (label: string): string => `svc_${RUN_TAG}_${label}_${ulid().slice(-8)}`;
      const callerService = serviceName('caller');
      const otherService = serviceName('other');
      const tenant = id('ORG');
      const otherTenant = id('ORG');
      const person: Caller = { userId: id('USR'), organizationId: tenant, roles: ['AUDITOR'] };
      const callSecret = `service-call-secret-${RUN_TAG}`;
      await atFreshWindow(identity.prisma, WINDOW_SECONDS, 2_000);

      const paths = ['/v1/users/me', '/v1/users', `/v1/users/USR-${callSecret}`];

      /**
       * Which of the guard's two FORBIDDEN refusals a path produces.
       *
       * `GET /v1/users` carries `@AllowService('notification-service')` since
       * NTF-001, so a caller that is not notification-service is refused by the
       * allowlist rather than by the absence of one. Same site, same code, same
       * aggregation — only the sentence differs.
       */
      const refusalMessage = (path: string): string =>
        path === '/v1/users'
          ? 'This service is not permitted to call this endpoint'
          : 'This endpoint is not callable by another service';
      const correlations: string[] = [];
      const tokens: string[] = [];
      const unsigned: string[] = [];

      /** One refusal of a verified service token; returns nothing but its effect. */
      const callAsService = async (
        service: string,
        organizationId: string | undefined,
        path = '/v1/users/me',
      ): Promise<string> => {
        const correlationId = id('COR');
        const token = await serviceToken(service, organizationId);
        const headerOrganization = `ORG-UNSIGNED-${RUN_TAG}-${ulid()}`;
        tokens.push(token);
        unsigned.push(headerOrganization);

        const response = await request(identity.app.getHttpServer())
          .get(`${path}?q=${callSecret}`)
          .set('x-internal-token', token)
          .set('user-agent', USER_AGENT)
          .set('x-correlation-id', correlationId)
          .set('traceparent', TRACEPARENT)
          .set('x-organization-id', headerOrganization);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          code: ERROR_CODES.FORBIDDEN,
          message: refusalMessage(path),
          correlationId,
        });
        return correlationId;
      };

      for (const path of paths) {
        correlations.push(await callAsService(callerService, tenant, path));
      }

      // In the same window, three refusals that must each stay their own row:
      // the same service for another tenant, another service for this tenant,
      // and the same service with a platform-wide token — plus one user
      // refusal, whose actor kind, action and code all differ.
      await callAsService(callerService, otherTenant);
      await callAsService(otherService, tenant);
      await callAsService(callerService, undefined);

      const userCorrelation = id('COR');
      const userRefusal = await request(identity.app.getHttpServer())
        .get('/v1/users/me')
        .set('authorization', `Bearer ${userToken(person)}`)
        .set('user-agent', USER_AGENT)
        .set('x-correlation-id', userCorrelation)
        .set('x-organization-id', `ORG-REJECTED-${RUN_TAG}-${ulid()}`);
      expect(userRefusal.status).toBe(403);
      expect(userRefusal.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);

      const serviceRows = await identity.prisma.client.securityEventOutbox.findMany({
        where: { actorId: { in: [callerService, otherService] } },
      });
      const userRows = await identity.prisma.client.securityEventOutbox.findMany({
        where: { actorId: person.userId },
      });
      expect(serviceRows).toHaveLength(4);
      expect(userRows).toHaveLength(1);

      const aggregated = serviceRows.find(
        (row) => row.actorId === callerService && row.organizationId === tenant,
      )!;
      const platformRow = serviceRows.find((row) => row.organizationId === null)!;
      const otherTenantRow = serviceRows.find((row) => row.organizationId === otherTenant)!;
      const otherServiceRow = serviceRows.find((row) => row.actorId === otherService)!;
      expect(aggregated.occurrenceCount).toBe(3);
      for (const row of [platformRow, otherTenantRow, otherServiceRow, userRows[0]!]) {
        expect(row.occurrenceCount).toBe(1);
      }
      // Five decisions, five rows: aggregation merged only what belongs
      // together.
      expect(new Set([...serviceRows, ...userRows].map((row) => row.id)).size).toBe(5);

      const deliveryOf = async (eventId: string): Promise<ObservedMessage> => {
        const [found] = await waitFor(
          `a delivery of ${eventId}`,
          async () => {
            const seen = observer.deliveriesOf(eventId);
            return seen.length > 0 ? seen : null;
          },
          DELIVERY_TIMEOUT_MS,
        );
        return found!;
      };

      const { envelope, delivery } = await deliveryOf(aggregated.id);
      expect(delivery.topic).toBe(AUDIT_TRAIL_TOPIC);
      expect(envelope.eventName).toBe(AUDIT_EVENT_RECORDED);
      expect(envelope.eventId).toBe(aggregated.id);
      // The token's signed tenant, and the first occurrence's correlation.
      expect(envelope.tenantId).toBe(tenant);
      expect(envelope.correlationId).toBe(correlations[0]);

      const payload = auditTrailPayloadSchemaV1.parse(envelope.payload);
      expect(payload).toMatchObject({
        actor: { type: 'SERVICE', id: callerService, roles: ['SERVICE'] },
        organizationId: tenant,
        action: site.action,
        resourceType: site.resourceType,
        resourceId: callerService,
        outcome: 'REFUSED',
        errorCode: 'FORBIDDEN',
        reason: site.reason,
        occurrenceCount: 3,
      });

      // A platform-wide service token is published as a platform event: no
      // tenant on the envelope, none in the payload, and no invented one.
      const platform = await deliveryOf(platformRow.id);
      expect(platform.envelope.tenantId).toBeUndefined();
      const platformPayload = auditTrailPayloadSchemaV1.parse(platform.envelope.payload);
      expect(platformPayload.organizationId).toBeUndefined();
      expect(platformPayload).toMatchObject({
        actor: { type: 'SERVICE', id: callerService, roles: ['SERVICE'] },
        action: site.action,
        errorCode: 'FORBIDDEN',
        occurrenceCount: 1,
      });

      // Neither the other tenant's, the other service's, nor the user's
      // refusal was merged into this event — each is its own message.
      const otherTenantEvent = await deliveryOf(otherTenantRow.id);
      expect(otherTenantEvent.envelope.tenantId).toBe(otherTenant);
      expect(auditTrailPayloadSchemaV1.parse(otherTenantEvent.envelope.payload)).toMatchObject({
        actor: { type: 'SERVICE', id: callerService },
        occurrenceCount: 1,
      });

      const otherServiceEvent = await deliveryOf(otherServiceRow.id);
      expect(auditTrailPayloadSchemaV1.parse(otherServiceEvent.envelope.payload)).toMatchObject({
        actor: { type: 'SERVICE', id: otherService, roles: ['SERVICE'] },
        organizationId: tenant,
        occurrenceCount: 1,
      });

      const userEvent = await deliveryOf(userRows[0]!.id);
      expect(auditTrailPayloadSchemaV1.parse(userEvent.envelope.payload)).toMatchObject({
        actor: { type: 'USER', id: person.userId, roles: ['AUDITOR'] },
        action: REFUSAL_SITES.AUTH_TENANT_MISMATCH.action,
        errorCode: 'TENANT_MISMATCH',
        occurrenceCount: 1,
      });

      // Nothing the caller controls reached the wire: not the internal tokens,
      // not the unsigned header, not the endpoints, not the refusal's text.
      const wire = JSON.stringify(
        [envelope, platform.envelope, otherTenantEvent.envelope, otherServiceEvent.envelope].map(
          (seen) => ({ seen, payload: seen.payload }),
        ),
      );
      for (const leaked of [
        ...tokens,
        ...unsigned,
        callSecret,
        '/v1/users',
        'not callable by another service',
        'not permitted to call this endpoint',
      ]) {
        expect(wire).not.toContain(leaked);
      }

      await waitFor(
        'the service refusal row to be acknowledged',
        async () => (await rowOf(aggregated.id)).publishedAt,
        DELIVERY_TIMEOUT_MS,
      );
      expect(await rowOf(aggregated.id)).toMatchObject({ occurrenceCount: 3 });
      await sleep(500);
      expect(observer.deliveriesOf(aggregated.id)).toHaveLength(1);
    },
    DELIVERY_TIMEOUT_MS + 120_000,
  );

  it(
    'the audit correction command: one schema-valid correction on the trail, keyed by its target, relayed by the standard outbox (AUD-003 correction)',
    async () => {
      // The production wiring end to end on identity's side: the real command,
      // the real standard outbox, the real standard relay, the real broker.
      // audit-service is stood in for only at its lookup; what it does with
      // this message is proved in its own Kafka suite and black-box.
      const stub = await startAuditStub();
      const corrections = await startIdentityApi({
        runDomainRelay: true,
        auditServiceUrl: stub.url,
      });
      const targetId = `01AUD${RUN_TAG}${ulid().slice(-11)}`;
      const tenant = id('ORG');
      const occurredAt = new Date(Date.now() - 120_000).toISOString();
      stub.targets.set(targetId, { id: targetId, organizationId: tenant, occurredAt });
      const admin: Caller = {
        userId: id('USR'),
        organizationId: id('ORGADMIN'),
        roles: ['SYSTEM_ADMIN'],
      };
      const correlationId = id('COR');
      const key = id('KEY');
      const secret = `kafka-correction-secret-${RUN_TAG}`;
      const body = {
        auditEventId: targetId,
        occurredAt,
        reason: 'Recorded as SUCCESS; the operation actually failed (INC-4471)',
        changes: [
          { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
          { field: 'credentials.password', from: secret, to: `${secret}-new` },
        ],
      };
      const send = () =>
        request(corrections.app.getHttpServer())
          .post('/v1/audit-corrections')
          .set('authorization', `Bearer ${userToken(admin)}`)
          .set('idempotency-key', key)
          .set('x-correlation-id', correlationId)
          .set('user-agent', USER_AGENT)
          .send(body);

      try {
        const response = await send();
        expect(response.status).toBe(202);
        const eventId = response.body.eventId as string;

        const [delivered] = await waitFor(
          'a delivery of the correction',
          async () => {
            const found = observer.deliveriesOf(eventId);
            return found.length > 0 ? found : null;
          },
          DELIVERY_TIMEOUT_MS,
        );
        const { envelope, delivery } = delivered!;
        expect(delivery.topic).toBe(AUDIT_TRAIL_TOPIC);
        expect(envelope).toMatchObject({
          eventId,
          eventName: AUDIT_EVENT_RECORDED,
          eventVersion: 1,
          producer: 'identity-service',
          aggregateType: 'AuditEvent',
          aggregateId: targetId,
          // Tenant agreement: the envelope and the payload name the same tenant,
          // and it is the target's, never the administrator's.
          tenantId: tenant,
          // The stream — and the Kafka key the relay published with — is the
          // target id: the outbox row's partition key, asserted below.
          streamKey: targetId,
          streamSeq: 1,
          correlationId,
        });

        const payload = auditTrailPayloadSchemaV1.parse(envelope.payload);
        expect(payload).toEqual({
          actor: { type: 'USER', id: admin.userId, roles: ['SYSTEM_ADMIN'] },
          organizationId: tenant,
          action: 'audit.correction',
          resourceType: 'AuditEvent',
          resourceId: targetId,
          outcome: 'SUCCESS',
          reason: body.reason,
          changes: [
            { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
            { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
          ],
          occurrenceCount: 1,
          source: { ip: expect.any(String), userAgent: USER_AGENT },
          correctionOf: targetId,
        });
        const wire = JSON.stringify(envelope);
        for (const leaked of [secret, admin.organizationId!, key]) {
          expect(wire).not.toContain(leaked);
        }

        const row = await waitFor(
          'the correction row to be acknowledged',
          async () => {
            const found = await runUnscoped('reads platform plumbing', () =>
              corrections.prisma.client.outboxMessage.findUnique({ where: { id: eventId } }),
            );
            return found?.publishedAt ? found : null;
          },
          DELIVERY_TIMEOUT_MS,
        );
        expect(row).toMatchObject({ topic: AUDIT_TRAIL_TOPIC, partitionKey: targetId });

        // A replay of the command is a replay: the same answer, no second message.
        const replay = await send();
        expect(replay.status).toBe(202);
        expect(replay.body).toEqual(response.body);
        await sleep(1_500);
        expect(observer.deliveriesOf(eventId)).toHaveLength(1);
        // The command reached audit-service only through its lookup, once.
        expect(stub.lookups.filter((lookup) => lookup.id === targetId)).toHaveLength(1);
      } finally {
        await runUnscoped('integration cleanup of this run only', async () => {
          await corrections.prisma.client.$executeRawUnsafe(
            'DELETE FROM outbox_message WHERE aggregate_id = $1',
            targetId,
          );
          await corrections.prisma.client.$executeRawUnsafe(
            'DELETE FROM outbox_stream_sequence WHERE partition_key = $1',
            targetId,
          );
          await corrections.prisma.client.$executeRawUnsafe(
            'DELETE FROM audit_correction_command WHERE target_id = $1',
            targetId,
          );
        });
        await corrections.close();
        await stub.close();
      }
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
