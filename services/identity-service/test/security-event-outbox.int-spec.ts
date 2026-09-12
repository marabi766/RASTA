import { isIP } from 'node:net';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  parseEnvelope,
} from '@rasta/contracts';
import { runUnscoped, type EventPublisher, type OutboxRow } from '@rasta/nest-common';
import { securityEventCapturesTotal } from '../src/observability/security-event.metrics';
import { REFUSAL_SITES } from '../src/security-events/refusal-sites';
import { createSecurityEventRelay } from '../src/security-events/security-event.relay';
import type { PrismaService } from '../src/prisma/prisma.service';
import { startIdentityApi, userToken, type Caller, type IdentityApiHarness } from './api-helpers';
import { newPrisma, waitForWindowClose } from './helpers';

/**
 * The refusal outbox against a real PostgreSQL (ADR-053 § 4, AUD-004 Phase C1).
 *
 * Every refusal here is a real HTTP request through the real `AppModule`: the
 * global auth guard resolves the tenant, `IdentityService` refuses, the refusal
 * filter captures, and the row is read back from the database. The claim
 * protocol is driven through the real store so lease expiry, fencing and retry
 * are properties of the SQL, not of a fake.
 *
 * Everything this file writes carries `TAG`, and cleanup removes exactly that.
 *
 * Since AUD-004 Phase C2 a row is claimable only once its aggregation window
 * has closed, so this suite runs with a one-second window (configuration) and
 * waits for it before driving the claim protocol. Every caller here refuses
 * once, so every row still holds one occurrence; aggregation itself is proved
 * in `security-event-aggregation.int-spec.ts`.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
/**
 * An organization id the request body validator accepts — the readable seed
 * form `ORG-[A-Z0-9-]{1,48}` — still carrying this run's tag.
 */
const validOrg = (label: string): string => `ORG-${label}-${TAG}-${ulid()}`;
const requestedOrg = (): string => validOrg('REQ');
const SITE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;
const ROUTE = SITE.route;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const USER_AGENT = 'Mozilla/5.0 (identity refusal itest)';

const QUERY_SECRET = `query-secret-${TAG}`;
const COOKIE_SECRET = `cookie-secret-${TAG}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface SwitchOptions {
  token?: string;
  correlationId?: string;
  query?: string;
  headers?: Record<string, string>;
}

function switchOrganization(
  harness: IdentityApiHarness,
  caller: Caller,
  target: string,
  options: SwitchOptions = {},
) {
  const call = request(harness.app.getHttpServer())
    .post(`${ROUTE}${options.query ?? ''}`)
    .set('authorization', `Bearer ${options.token ?? userToken(caller)}`)
    .set('user-agent', USER_AGENT)
    .set('x-correlation-id', options.correlationId ?? tagged('COR'))
    .set('traceparent', TRACEPARENT);
  for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
  return call.send({ organizationId: target });
}

function withoutTimestamp(body: unknown): Record<string, unknown> {
  const { timestamp, ...rest } = body as Record<string, unknown>;
  expect(typeof timestamp).toBe('string');
  return rest;
}

async function captureCount(outcome: string): Promise<number> {
  const metric = await securityEventCapturesTotal.get();
  return metric.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

describe('security_event_outbox (real PostgreSQL)', () => {
  let harness: IdentityApiHarness;
  let prisma: PrismaService;

  const rowsFor = (actorId: string) =>
    prisma.client.securityEventOutbox.findMany({
      where: { actorId },
      orderBy: { createdAt: 'asc' },
    });

  /** Every column of one row as PostgreSQL renders it — nothing mapped away. */
  const rawRow = async (id: string): Promise<string> => {
    const rows = await prisma.client.$queryRawUnsafe<{ row: string }[]>(
      'SELECT row_to_json(s)::text AS row FROM security_event_outbox s WHERE id = $1',
      id,
    );
    return rows[0]?.row ?? '';
  };

  beforeAll(async () => {
    harness = await startIdentityApi({ aggregationWindowSeconds: 1 });
    prisma = harness.prisma;
    await prisma.client.$queryRawUnsafe('SELECT 1');
  }, 60_000);

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      'DELETE FROM security_event_outbox WHERE actor_id LIKE $1',
      `%_${TAG}_%`,
    );
    await runUnscoped('integration cleanup of this run only', async () => {
      await prisma.client.membership.deleteMany({ where: { userId: { contains: TAG } } });
      await prisma.client.user.deleteMany({ where: { id: { contains: TAG } } });
    });
    await harness?.close();
  }, 60_000);

  it('durably captures a real TENANT_MISMATCH refusal with trusted attribution and no request data', async () => {
    const caller: Caller = {
      userId: tagged('USR'),
      organizationId: tagged('ORG'),
      roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
    };
    const requested = requestedOrg();
    const correlationId = tagged('COR');
    const token = userToken(caller);
    const before = new Date(Date.now() - 1000);

    const response = await switchOrganization(harness, caller, requested, {
      token,
      correlationId,
      query: `?access_token=${QUERY_SECRET}`,
      headers: { cookie: `session=${COOKIE_SECRET}` },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: ERROR_CODES.TENANT_MISMATCH, correlationId });

    const rows = await rowsFor(caller.userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row).toMatchObject({
      organizationId: caller.organizationId,
      actorType: 'USER',
      actorId: caller.userId,
      actorRoles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
      action: SITE.action,
      resourceType: SITE.resourceType,
      resourceId: caller.userId,
      errorCode: 'TENANT_MISMATCH',
      reason: SITE.reason,
      sourceUserAgent: USER_AGENT,
      correlationId,
      traceparent: TRACEPARENT,
      producerVersion: '0.1.0-itest',
      occurrenceCount: 1,
      publishedAt: null,
      attempts: 0,
      claimToken: null,
      claimOwner: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
    });
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isIP(row.sourceIp ?? '')).not.toBe(0);
    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Nothing from the request that is not evidence reached the table — checked
    // against every column as PostgreSQL itself renders the row.
    const everything = await rawRow(row.id);
    for (const leaked of [
      requested,
      QUERY_SECRET,
      COOKIE_SECRET,
      token,
      'access_token',
      'You are not a member',
    ]) {
      expect(everything).not.toContain(leaked);
    }
  });

  it('tenant isolation: files each refusal under the tenant the caller acted for, never the requested one', async () => {
    const home = tagged('ORG');
    const second = tagged('ORG');
    const requested = requestedOrg();

    // Acting for the token's active organization.
    const inHome: Caller = {
      userId: tagged('USR'),
      organizationId: home,
      organizationIds: [home, second],
    };
    expect((await switchOrganization(harness, inHome, requested)).status).toBe(403);

    // Acting for a second membership, selected by header and verified against the token.
    const inSecond: Caller = {
      userId: tagged('USR'),
      organizationId: home,
      organizationIds: [home, second],
    };
    expect(
      (
        await switchOrganization(harness, inSecond, requested, {
          headers: { 'x-organization-id': second },
        })
      ).status,
    ).toBe(403);

    // Acting for no organization at all: a platform-scoped record.
    const platform: Caller = { userId: tagged('USR'), organizationIds: [] };
    expect((await switchOrganization(harness, platform, requested)).status).toBe(403);

    expect((await rowsFor(inHome.userId)).map((row) => row.organizationId)).toEqual([home]);
    expect((await rowsFor(inSecond.userId)).map((row) => row.organizationId)).toEqual([second]);
    expect((await rowsFor(platform.userId)).map((row) => row.organizationId)).toEqual([null]);

    // The organization a caller asked for is attacker-chosen and appears nowhere.
    expect(
      await prisma.client.securityEventOutbox.count({ where: { organizationId: requested } }),
    ).toBe(0);
    expect(
      await prisma.client.securityEventOutbox.count({ where: { resourceId: requested } }),
    ).toBe(0);
  });

  it('captures no 401, no uninstrumented 403, no guard-level TENANT_MISMATCH and no successful switch', async () => {
    const before = await prisma.client.securityEventOutbox.count({
      where: { correlationId: { contains: TAG } },
    });

    // 401: no credentials at all.
    const anonymousCorrelation = tagged('COR');
    const anonymous = await request(harness.app.getHttpServer())
      .post(ROUTE)
      .set('x-correlation-id', anonymousCorrelation)
      .send({ organizationId: tagged('ORG') });
    expect(anonymous.status).toBe(401);

    // 403 INSUFFICIENT_ROLE from the roles guard on an endpoint that is not an
    // allowlisted site. (`GET /v1/users`, `POST /v1/users`,
    // `POST /v1/users/:id/memberships` and `POST /v1/memberships/:id/roles`
    // became sites in AUD-004 Phases C3–C6 and are proved captured in
    // `security-event-role-refusal.int-spec.ts`.)
    const underPrivileged: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
    const revoking = await request(harness.app.getHttpServer())
      .post(`/v1/memberships/${tagged('MBR')}/revoke`)
      .set('authorization', `Bearer ${userToken(underPrivileged)}`)
      .send({});
    expect(revoking.status).toBe(403);
    expect(revoking.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);

    // 403 TENANT_MISMATCH raised by the auth guard for a header outside the
    // token's memberships — the same code, but not the identity decision.
    const probing: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
    const guardRefusal = await switchOrganization(harness, probing, tagged('ORG'), {
      headers: { 'x-organization-id': tagged('ORGHDR') },
    });
    expect(guardRefusal.status).toBe(403);
    expect(guardRefusal.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);

    // A switch that is allowed.
    const member: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
    const target = validOrg('OK');
    await runUnscoped('integration fixture for an allowed switch', async () => {
      await prisma.client.user.create({
        data: {
          id: member.userId,
          username: `refusal-itest-${ulid().toLowerCase()}`,
          email: `refusal-itest-${ulid().toLowerCase()}@identity.itest`,
          firstName: 'Refusal',
          lastName: 'Itest',
          status: 'ACTIVE',
          createdBy: 'identity-itest',
          updatedBy: 'identity-itest',
        },
      });
      await prisma.client.membership.create({
        data: {
          id: tagged('MBR'),
          userId: member.userId,
          organizationId: target,
          roles: ['FLEET_MANAGER'],
          status: 'ACTIVE',
          createdBy: 'identity-itest',
          updatedBy: 'identity-itest',
        },
      });
    });
    const allowed = await switchOrganization(harness, member, target);
    expect(allowed.status).toBe(200);
    expect(allowed.body.activeOrganizationId).toBe(target);

    for (const actor of [underPrivileged, probing, member]) {
      expect(await rowsFor(actor.userId)).toHaveLength(0);
    }
    expect(
      await prisma.client.securityEventOutbox.count({
        where: { correlationId: anonymousCorrelation },
      }),
    ).toBe(0);
    expect(
      await prisma.client.securityEventOutbox.count({
        where: { correlationId: { contains: TAG } },
      }),
    ).toBe(before);
  });

  describe('a failed capture returns the identical 403 TENANT_MISMATCH', () => {
    it('when the insert is cancelled by its statement timeout behind a lock', async () => {
      const bounded = await startIdentityApi({ captureTimeoutMs: 200 });
      const locker = newPrisma();
      await locker.onModuleInit();

      try {
        const correlationId = tagged('COR');
        const requested = requestedOrg();
        const baselineCaller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
        const lockedCaller: Caller = { ...baselineCaller, userId: tagged('USR') };

        const baseline = await switchOrganization(harness, baselineCaller, requested, {
          correlationId,
        });
        expect(await rowsFor(baselineCaller.userId)).toHaveLength(1);

        const timeoutsBefore = await captureCount('timeout');
        let locked!: request.Response;
        let elapsedMs = 0;

        await locker.client.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('LOCK TABLE security_event_outbox IN ACCESS EXCLUSIVE MODE');
            const started = Date.now();
            locked = await switchOrganization(bounded, lockedCaller, requested, { correlationId });
            elapsedMs = Date.now() - started;
          },
          { maxWait: 10_000, timeout: 30_000 },
        );

        expect(locked.status).toBe(baseline.status);
        expect(locked.status).toBe(403);
        expect(withoutTimestamp(locked.body)).toEqual(withoutTimestamp(baseline.body));
        expect(locked.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);
        // Held no longer than the bound plus request overhead.
        expect(elapsedMs).toBeLessThan(5_000);
        expect(await captureCount('timeout')).toBe(timeoutsBefore + 1);

        // The cancelled insert left nothing behind once the lock was gone.
        await sleep(300);
        expect(await rowsFor(lockedCaller.userId)).toHaveLength(0);
      } finally {
        await locker.onModuleDestroy();
        await bounded.close();
      }
    });

    it('when the insert itself fails', async () => {
      const failing = await startIdentityApi({
        securityEventStore: {
          capture: async () => {
            throw Object.assign(new Error(`connection refused near ${QUERY_SECRET}`), {
              name: 'PrismaClientInitializationError',
            });
          },
          pendingCount: async () => 0,
          activeLeaseCount: async () => 0,
          oldestPendingAgeSeconds: async () => 0,
          aggregationBacklog: async () => ({
            openWindows: 0,
            closedBacklog: 0,
            closedBacklogAgeSeconds: 0,
          }),
        },
      });

      try {
        const correlationId = tagged('COR');
        const requested = requestedOrg();
        const baselineCaller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
        const failingCaller: Caller = { ...baselineCaller, userId: tagged('USR') };

        const baseline = await switchOrganization(harness, baselineCaller, requested, {
          correlationId,
        });
        const failuresBefore = await captureCount('failed');
        const failed = await switchOrganization(failing, failingCaller, requested, {
          correlationId,
        });

        expect(failed.status).toBe(403);
        expect(withoutTimestamp(failed.body)).toEqual(withoutTimestamp(baseline.body));
        expect(await captureCount('failed')).toBe(failuresBefore + 1);
        expect(await rowsFor(failingCaller.userId)).toHaveLength(0);
      } finally {
        await failing.close();
      }
    });
  });

  describe('delivery state (ADR-050 semantics)', () => {
    async function refusalRow(): Promise<string> {
      const caller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
      expect((await switchOrganization(harness, caller, requestedOrg())).status).toBe(403);
      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(1);
      // An open window is never claimable (Phase C2).
      await waitForWindowClose(prisma, rows[0]!.id);
      return rows[0]!.id;
    }

    it('reclaims an expired lease and fences the stale worker out of acknowledging', async () => {
      const id = await refusalRow();

      const first = await harness.store.claimPending({
        limit: 1000,
        owner: 'worker-a',
        leaseSeconds: 1,
      });
      expect(first.rows.map((row) => row.id)).toContain(id);

      // Worker A stalls past its lease.
      await sleep(1_500);

      const second = await harness.store.claimPending({
        limit: 1000,
        owner: 'worker-b',
        leaseSeconds: 60,
      });
      expect(second.rows.map((row) => row.id)).toContain(id);
      expect(second.reclaimed).toBeGreaterThanOrEqual(1);
      expect(second.token).not.toBe(first.token);

      // The stale token touches nothing; the live one acknowledges.
      expect(await harness.store.markPublished([id], first.token!)).toBe(0);
      expect(
        await harness.store.markFailed(id, first.token!, 'stale', {
          baseSeconds: 5,
          maxSeconds: 5,
        }),
      ).toBe(0);
      expect(await harness.store.markPublished([id], second.token!)).toBe(1);

      const others = second.rows.map((row) => row.id).filter((other) => other !== id);
      await harness.store.release(others, second.token!);

      const row = await prisma.client.securityEventOutbox.findUniqueOrThrow({ where: { id } });
      expect(row.publishedAt).not.toBeNull();
      expect(row.claimCount).toBe(2);
      expect(row).toMatchObject({
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
        attempts: 0,
      });
    });

    it('keeps a row after a failed publish and delivers it on a later attempt', async () => {
      const id = await refusalRow();
      const backoff = { baseSeconds: 1, maxSeconds: 1 };
      const relayDefaults = {
        store: harness.store,
        pollIntervalMs: 60_000,
        batchSize: 1000,
        leaseSeconds: 60,
        backoff,
        shutdownGraceSeconds: 0,
      };

      const refusing: EventPublisher = {
        publish: async () => {
          throw new Error('broker unavailable');
        },
      };
      await createSecurityEventRelay({ ...relayDefaults, publisher: refusing }).tick();

      const failed = await prisma.client.securityEventOutbox.findUniqueOrThrow({ where: { id } });
      expect(failed).toMatchObject({
        publishedAt: null,
        attempts: 1,
        claimToken: null,
        claimOwner: null,
      });
      expect(failed.lastError).toContain('broker unavailable');
      expect(failed.nextAttemptAt).not.toBeNull();
      const [{ due }] = await prisma.client.$queryRawUnsafe<{ due: boolean }[]>(
        'SELECT next_attempt_at <= now() AS due FROM security_event_outbox WHERE id = $1',
        id,
      );
      expect(due).toBe(false);

      await sleep(1_300);

      const sent: OutboxRow[] = [];
      const accepting: EventPublisher = {
        publish: async (rows) => {
          sent.push(...rows);
        },
      };
      await createSecurityEventRelay({ ...relayDefaults, publisher: accepting }).tick();

      const delivered = sent.filter((row) => row.id === id);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.topic).toBe(AUDIT_TRAIL_TOPIC);
      expect(delivered[0]!.partitionKey).toBe(
        (delivered[0]!.payload as { aggregateId: string }).aggregateId,
      );
      const envelope = parseEnvelope(delivered[0]!.payload, auditTrailPayloadSchemaV1);
      expect(envelope.eventId).toBe(id);
      expect(envelope.payload).toMatchObject({ outcome: 'REFUSED', occurrenceCount: 1 });

      const published = await prisma.client.securityEventOutbox.findUniqueOrThrow({
        where: { id },
      });
      expect(published.publishedAt).not.toBeNull();
      expect(published.attempts).toBe(1);
      expect(published.nextAttemptAt).toBeNull();
    });
  });
});
