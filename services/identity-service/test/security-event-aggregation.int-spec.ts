import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  parseEnvelope,
} from '@rasta/contracts';
import type { OutboxRow } from '@rasta/nest-common';
import {
  securityEventAggregationsTotal,
  securityEventCapturesTotal,
} from '../src/observability/security-event.metrics';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SecurityEventRecord } from '../src/security-events/audit-trail-envelope';
import {
  MAX_OCCURRENCE_COUNT,
  aggregationOutcomeOf,
  aggregationWindowOf,
  type CapturedOccurrence,
} from '../src/security-events/refusal-aggregation';
import { REFUSAL_SITES } from '../src/security-events/refusal-sites';
import { SecurityEventOutboxStore } from '../src/security-events/security-event-outbox.store';
import { startIdentityApi, userToken, type Caller, type IdentityApiHarness } from './api-helpers';
import { atFreshWindow, newPrisma, waitForWindowClose } from './helpers';

/**
 * Windowed refusal aggregation against a real PostgreSQL (ADR-053 § 4, AUD-004
 * Phase C2).
 *
 * Refusals come through the real endpoint wherever the property is about the
 * service — one row per window, the unchanged `403`, a restart — and through
 * the real store, with several independent database clients, wherever it is
 * about the SQL under concurrency: the upsert, the claim boundary and the
 * table's own constraints. Nothing here fakes a lock, a clock or a row.
 *
 * Every burst that must land in one window first waits, on the database clock,
 * for enough of the window to remain (`atFreshWindow`), so a result never
 * depends on where in a window the test happened to start. That is a starting
 * margin only: a burst that runs longer than it still crosses the boundary.
 *
 * This spec runs alone. Its two 500-write proofs serialize on one hot row, so
 * their pace is the database's commit latency, and beside every other
 * service's integration suite on the same PostgreSQL they measured that WAL
 * load instead (2026-09-14: bursts of 42–124 s rather than ~22 s, a `57014`
 * on the five-second capture bound, a burst crossing its window). So the
 * `aggregation-stress` jest project owns this file, and `pnpm test`,
 * `pnpm test:integration`, `pnpm verify` and CI run it once, after the
 * parallel workspace phase (`scripts/test-phases-lib.mjs`, docs/14 § 14.3).
 * What the proofs still prove is unchanged — the real endpoint and
 * independent Prisma clients, the real row lock, exactly one created row,
 * counts 1..500 with no gap, and no `timeout` or `failed` capture — with the
 * production window, statement bound and pool. They are not a throughput
 * benchmark and set no SLA.
 *
 * Everything written carries `TAG` in its actor id; cleanup removes exactly
 * that, so the suite is independent of any other run on the same database.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
const requestedOrg = (): string => `ORG-REQ-${TAG}`;
const SITE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;
const WINDOW_SECONDS = 60;
const CAPTURE = { timeoutMs: 5000, windowSeconds: WINDOW_SECONDS };
const ONE_SECOND_WINDOW = { timeoutMs: 5000, windowSeconds: 1 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ux_security_event_outbox_open_bucket`, as the driver reports it: by name,
 * as Prisma's P2002, or as PostgreSQL's 23505 detail — each naming exactly the
 * index's columns, which no other unique index on the table has.
 */
const OPEN_BUCKET_VIOLATION =
  /ux_security_event_outbox_open_bucket|Unique constraint failed on the fields: \(`organization_id`,`actor_type`,`actor_id`,`action`,`resource_type`,`resource_id`,`error_code`,`window_started_at`,`window_ends_at`\)|23505.*Key \(organization_id, actor_type, actor_id, action, resource_type, resource_id, error_code, window_started_at, window_ends_at\)=/s;

/** A refusal as `decideCapture` would build it — contract-valid, attributable, tagged. */
function refusalDraft(overrides: Partial<SecurityEventRecord> = {}): SecurityEventRecord {
  const actorId = overrides.actorId ?? tagged('USR');
  return {
    id: ulid(),
    organizationId: tagged('ORG'),
    actorType: 'USER',
    actorId,
    actorRoles: ['FLEET_MANAGER'],
    action: SITE.action,
    resourceType: SITE.resourceType,
    resourceId: actorId,
    errorCode: SITE.errorCode,
    reason: SITE.reason,
    sourceIp: '203.0.113.7',
    sourceUserAgent: 'identity aggregation itest',
    correlationId: tagged('COR'),
    traceparent: null,
    producerVersion: '0.1.0-itest',
    occurredAt: new Date(),
    occurrenceCount: 1,
    ...overrides,
  };
}

/** Another refusal of the same identity: its own id, correlation and source. */
const again = (base: SecurityEventRecord): SecurityEventRecord => ({
  ...base,
  id: ulid(),
  correlationId: tagged('COR'),
  sourceUserAgent: `rotated-agent-${ulid()}`,
  sourceIp: '198.51.100.9',
});

async function metricValue(
  metric: typeof securityEventCapturesTotal | typeof securityEventAggregationsTotal,
  label: string,
  value: string,
): Promise<number> {
  const snapshot = await metric.get();
  return (
    snapshot.values.find((entry) => (entry.labels as Record<string, unknown>)[label] === value)
      ?.value ?? 0
  );
}

describe('windowed refusal aggregation (real PostgreSQL)', () => {
  let harness: IdentityApiHarness;
  let prisma: PrismaService;
  let store: SecurityEventOutboxStore;
  const clients: PrismaService[] = [];

  const rowsFor = (actorId: string) =>
    prisma.client.securityEventOutbox.findMany({
      where: { actorId },
      orderBy: [{ windowStartedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

  const rowById = (id: string) =>
    prisma.client.securityEventOutbox.findUniqueOrThrow({ where: { id } });

  async function independentStore(): Promise<SecurityEventOutboxStore> {
    const client = newPrisma();
    await client.onModuleInit();
    clients.push(client);
    return new SecurityEventOutboxStore(client);
  }

  async function independentClient(): Promise<PrismaService> {
    const client = newPrisma();
    await client.onModuleInit();
    clients.push(client);
    return client;
  }

  /** Claims, keeps this test's rows, and gives every other row back at once. */
  async function claimOnly(ids: readonly string[], owner: string, leaseSeconds = 60) {
    const claim = await store.claimPending({ limit: 1000, owner, leaseSeconds });
    const mine = claim.rows.filter((row) => ids.includes(row.id));
    const others = claim.rows.filter((row) => !ids.includes(row.id)).map((row) => row.id);
    if (claim.token && others.length > 0) await store.release(others, claim.token);
    return { token: claim.token, rows: mine, reclaimed: claim.reclaimed };
  }

  function refuse(api: IdentityApiHarness, caller: Caller, headers: Record<string, string> = {}) {
    const call = request(api.app.getHttpServer())
      .post(SITE.route)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', headers['x-correlation-id'] ?? tagged('COR'));
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return call.send({ organizationId: requestedOrg() });
  }

  const countOf = (row: OutboxRow): number =>
    parseEnvelope(row.payload, auditTrailPayloadSchemaV1).payload.occurrenceCount;

  beforeAll(async () => {
    harness = await startIdentityApi({ aggregationWindowSeconds: WINDOW_SECONDS });
    prisma = harness.prisma;
    store = harness.store;
    await prisma.client.$queryRawUnsafe('SELECT 1');
  }, 60_000);

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      'DELETE FROM security_event_outbox WHERE actor_id LIKE $1',
      `%_${TAG}_%`,
    );
    await Promise.all(clients.map((client) => client.onModuleDestroy()));
    await harness?.close();
  }, 60_000);

  describe('one row per identity per window', () => {
    it('counts sequential matching refusals through the real endpoint into one row, first occurrence kept', async () => {
      const caller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
      const correlations = [tagged('COR'), tagged('COR'), tagged('COR')];
      await atFreshWindow(prisma, WINDOW_SECONDS, 15_000);

      for (const [index, correlationId] of correlations.entries()) {
        const response = await refuse(harness, caller, {
          'x-correlation-id': correlationId,
          'user-agent': `agent-${index}`,
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);
        expect(response.body.correlationId).toBe(correlationId);
      }

      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        occurrenceCount: 3,
        organizationId: caller.organizationId,
        actorId: caller.userId,
        resourceId: caller.userId,
        // The first occurrence's sample, not the last one's.
        correlationId: correlations[0],
        sourceUserAgent: 'agent-0',
        claimCount: 0,
        publishedAt: null,
      });

      // The database chose the window by its own clock, exactly as defined.
      expect(aggregationWindowOf(row.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: row.windowStartedAt,
        endsAt: row.windowEndsAt,
      });
      expect(row.windowEndsAt.getTime() - row.windowStartedAt.getTime()).toBe(60_000);
      expect(row.createdAt).toEqual(row.occurredAt);
    });

    it('exactly 500 concurrent matching refusals through the real endpoint become one row with occurrenceCount 500', async () => {
      const server = harness.app.getHttpServer();
      // One listening server for every request, rather than supertest binding
      // a fresh one per call.
      if (!server.listening) {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      }
      const { port } = server.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;

      const caller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
      const token = userToken(caller);
      const TOTAL = 500;
      // Five callers at once, 100 refusals each. Every capture of one probe
      // waits on the same row lock, so each waits roughly (writers − 1) ×
      // commit latency. Fifty lanes (nine at once through the pool) held under
      // `pnpm test`, where thirty other suites share the database's WAL: 43
      // captures outlived the 5 s bound and 4 of those were cancelled — the
      // documented best-effort outcome (the 403 was unchanged, the loss was
      // counted as `timeout`), but not what this test is about. Five keeps
      // real interleaving on every increment and stays inside the bound.
      const LANES = 5;

      const timeoutsBefore = await metricValue(securityEventCapturesTotal, 'outcome', 'timeout');
      const failuresBefore = await metricValue(securityEventCapturesTotal, 'outcome', 'failed');
      const recordedBefore = await metricValue(securityEventCapturesTotal, 'outcome', 'recorded');
      const createdBefore = await metricValue(securityEventAggregationsTotal, 'result', 'created');
      const incrementedBefore = await metricValue(
        securityEventAggregationsTotal,
        'result',
        'incremented',
      );

      await atFreshWindow(prisma, WINDOW_SECONDS, 40_000);
      const statuses: number[] = [];
      await Promise.all(
        Array.from({ length: LANES }, async () => {
          for (let i = 0; i < TOTAL / LANES; i += 1) {
            const response = await request(base)
              .post(SITE.route)
              .set('authorization', `Bearer ${token}`)
              .set('x-correlation-id', tagged('COR'))
              .send({ organizationId: requestedOrg() });
            statuses.push(response.status);
          }
        }),
      );

      expect(statuses).toHaveLength(TOTAL);
      expect(statuses.every((status) => status === 403)).toBe(true);
      // Named first, so a shortfall below says why rather than just "496".
      expect(await metricValue(securityEventCapturesTotal, 'outcome', 'timeout')).toBe(
        timeoutsBefore,
      );
      expect(await metricValue(securityEventCapturesTotal, 'outcome', 'failed')).toBe(
        failuresBefore,
      );

      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrenceCount).toBe(TOTAL);
      expect(await metricValue(securityEventCapturesTotal, 'outcome', 'recorded')).toBe(
        recordedBefore + TOTAL,
      );
      expect(await metricValue(securityEventAggregationsTotal, 'result', 'created')).toBe(
        createdBefore + 1,
      );
      expect(await metricValue(securityEventAggregationsTotal, 'result', 'incremented')).toBe(
        incrementedBefore + TOTAL - 1,
      );
    }, 120_000);

    it('exactly 500 concurrent captures from four independent database clients serialize into one row, counting 1..500 with no gap', async () => {
      const stores = [
        store,
        await independentStore(),
        await independentStore(),
        await independentStore(),
      ];
      const base = refusalDraft();
      await atFreshWindow(prisma, WINDOW_SECONDS, 40_000);

      // Eight writers in flight at every moment — two per independent client —
      // until 500 have been counted. Every one of them contends for the same
      // row lock, and a hot row serializes at the database's commit latency
      // (measured with pgbench on the development volume: ~23 commits/s at 40
      // clients, 1.75 s mean — PROJECT_MEMORY, AUD-004 Phase C2). Forty writers
      // there would prove the volume's fsync, not the upsert; eight stay
      // inside the five-second statement bound and still interleave on every
      // increment — on a database this spec has to itself, which is why it is
      // scheduled alone (see the file header).
      const TOTAL = 500;
      const LANES_PER_CLIENT = 2;
      const results: CapturedOccurrence[] = [];
      let issued = 0;
      await Promise.all(
        stores.flatMap((writer) =>
          Array.from({ length: LANES_PER_CLIENT }, async () => {
            while (issued < TOTAL) {
              issued += 1;
              results.push(await writer.capture(again(base), CAPTURE));
            }
          }),
        ),
      );
      expect(results).toHaveLength(TOTAL);

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.map((result) => result.occurrenceCount).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 500 }, (_, index) => index + 1),
      );

      const rows = await rowsFor(base.actorId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: results[0]!.id, occurrenceCount: 500, claimCount: 0 });
    }, 120_000);

    it('keeps an open window across a restart: a second process counts into the first process’s row', async () => {
      const caller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
      await atFreshWindow(prisma, WINDOW_SECONDS, 30_000);

      const first = await startIdentityApi({ aggregationWindowSeconds: WINDOW_SECONDS });
      try {
        expect((await refuse(first, caller)).status).toBe(403);
        expect((await refuse(first, caller)).status).toBe(403);
      } finally {
        await first.close();
      }
      const [before] = await rowsFor(caller.userId);
      expect(before?.occurrenceCount).toBe(2);

      const second = await startIdentityApi({ aggregationWindowSeconds: WINDOW_SECONDS });
      try {
        expect((await refuse(second, caller)).status).toBe(403);
      } finally {
        await second.close();
      }

      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: before!.id, occurrenceCount: 3 });
    }, 90_000);
  });

  describe('never merges what must stay apart', () => {
    it('tenant isolation: never merges refusals across tenant, actor, action, resource or error code in one window', async () => {
      await atFreshWindow(prisma, WINDOW_SECONDS, 20_000);

      // Through the endpoint: one person acting for two tenants, a second
      // person in the first tenant, and a caller acting for no tenant.
      const home = tagged('ORG');
      const second = tagged('ORG');
      const person: Caller = {
        userId: tagged('USR'),
        organizationId: home,
        organizationIds: [home, second],
      };
      const colleague: Caller = { userId: tagged('USR'), organizationId: home };
      const platform: Caller = { userId: tagged('USR'), organizationIds: [] };

      for (let i = 0; i < 2; i += 1) {
        expect((await refuse(harness, person)).status).toBe(403);
        expect((await refuse(harness, person, { 'x-organization-id': second })).status).toBe(403);
        expect((await refuse(harness, colleague)).status).toBe(403);
        expect((await refuse(harness, platform)).status).toBe(403);
      }

      const personRows = await rowsFor(person.userId);
      expect(personRows.map((row) => [row.organizationId, row.occurrenceCount]).sort()).toEqual(
        [
          [home, 2],
          [second, 2],
        ].sort(),
      );
      expect((await rowsFor(colleague.userId)).map((row) => row.occurrenceCount)).toEqual([2]);
      // Two platform refusals are the same (NULL) tenant, not two unknowns.
      expect(
        (await rowsFor(platform.userId)).map((row) => [row.organizationId, row.occurrenceCount]),
      ).toEqual([[null, 2]]);
      // The requested organization is attacker-chosen and is in no row.
      expect(
        await prisma.client.securityEventOutbox.count({
          where: { OR: [{ organizationId: requestedOrg() }, { resourceId: requestedOrg() }] },
        }),
      ).toBe(0);

      // Through the store: every other dimension, each refused twice.
      const base = refusalDraft();
      const variants: SecurityEventRecord[] = [
        base,
        { ...base, organizationId: tagged('ORG') },
        { ...base, organizationId: null },
        { ...base, actorId: tagged('USR') },
        { ...base, actorType: 'SERVICE' },
        { ...base, action: 'identity.membership.revoke' },
        { ...base, resourceType: 'Membership' },
        { ...base, resourceId: tagged('RES') },
        { ...base, resourceId: null },
        { ...base, errorCode: ERROR_CODES.FORBIDDEN },
      ];
      const rowIds: string[] = [];
      for (const variant of variants) {
        const first = await store.capture(again(variant), CAPTURE);
        const repeat = await store.capture(again(variant), CAPTURE);
        expect(first.created).toBe(true);
        expect(repeat).toEqual({ id: first.id, occurrenceCount: 2, created: false });
        rowIds.push(first.id);
      }
      expect(new Set(rowIds).size).toBe(variants.length);
    });

    it('opens a new row in a new window: refusals on either side of a boundary are never merged', async () => {
      const base = refusalDraft();

      const first = await store.capture(again(base), ONE_SECOND_WINDOW);
      await waitForWindowClose(prisma, first.id);
      const next = await store.capture(again(base), ONE_SECOND_WINDOW);

      expect(first.created).toBe(true);
      expect(next.created).toBe(true);
      expect(next.id).not.toBe(first.id);

      const [earlier, later] = [await rowById(first.id), await rowById(next.id)];
      expect(earlier.occurrenceCount).toBe(1);
      expect(later.occurrenceCount).toBe(1);
      expect(later.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        earlier.windowEndsAt.getTime(),
      );
      for (const row of [earlier, later]) {
        expect(aggregationWindowOf(row.occurredAt, 1)).toEqual({
          startedAt: row.windowStartedAt,
          endsAt: row.windowEndsAt,
        });
      }
    });
  });

  describe('the INTEGER ceiling', () => {
    it('reaches 2147483647 exactly, then opens a successor row instead of overflowing', async () => {
      const base = refusalDraft();
      await atFreshWindow(prisma, WINDOW_SECONDS, 20_000);

      const first = await store.capture(again(base), CAPTURE);
      // Test fixture: stand the row one short of the ceiling. The table allows
      // it — the row is unclaimed and the count only grows.
      await prisma.client.$executeRawUnsafe(
        'UPDATE security_event_outbox SET occurrence_count = $1 WHERE id = $2',
        MAX_OCCURRENCE_COUNT - 1,
        first.id,
      );

      const ceiling = await store.capture(again(base), CAPTURE);
      expect(ceiling).toEqual({
        id: first.id,
        occurrenceCount: MAX_OCCURRENCE_COUNT,
        created: false,
      });
      expect(aggregationOutcomeOf(ceiling)).toBe('ceiling_reached');

      const successor = await store.capture(again(base), CAPTURE);
      expect(successor.created).toBe(true);
      expect(successor.id).not.toBe(first.id);
      expect(successor.occurrenceCount).toBe(1);
      expect(await store.capture(again(base), CAPTURE)).toEqual({
        id: successor.id,
        occurrenceCount: 2,
        created: false,
      });

      const rows = await rowsFor(base.actorId);
      expect(rows.map((row) => row.occurrenceCount).sort((a, b) => b - a)).toEqual([
        MAX_OCCURRENCE_COUNT,
        2,
      ]);
      expect(new Set(rows.map((row) => row.windowStartedAt.getTime())).size).toBe(1);
    });

    it('still answers the identical 403 TENANT_MISMATCH when the open row is at the ceiling', async () => {
      const caller: Caller = { userId: tagged('USR'), organizationId: tagged('ORG') };
      await atFreshWindow(prisma, WINDOW_SECONDS, 20_000);

      const firstResponse = await refuse(harness, caller);
      const [row] = await rowsFor(caller.userId);
      await prisma.client.$executeRawUnsafe(
        'UPDATE security_event_outbox SET occurrence_count = $1 WHERE id = $2',
        MAX_OCCURRENCE_COUNT,
        row!.id,
      );

      const atCeiling = await refuse(harness, caller);
      expect(atCeiling.status).toBe(403);
      expect(atCeiling.body.code).toBe(firstResponse.body.code);
      expect(atCeiling.body.message).toBe(firstResponse.body.message);

      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === row!.id)?.occurrenceCount).toBe(MAX_OCCURRENCE_COUNT);
      expect(rows.find((r) => r.id !== row!.id)?.occurrenceCount).toBe(1);
    });
  });

  describe('the claim boundary', () => {
    it('claims a row only after its window closes, and publishes the count persisted by then', async () => {
      const base = refusalDraft();
      const twoSeconds = { ...CAPTURE, windowSeconds: 2 };
      await atFreshWindow(prisma, 2, 1_200);

      const first = await store.capture(again(base), twoSeconds);
      await store.capture(again(base), twoSeconds);

      const whileOpen = await claimOnly([first.id], 'itest-open-window');
      expect(whileOpen.rows).toHaveLength(0);
      expect((await rowById(first.id)).claimCount).toBe(0);
      expect((await store.aggregationBacklog()).openWindows).toBeGreaterThanOrEqual(1);

      await waitForWindowClose(prisma, first.id);
      expect((await store.aggregationBacklog()).closedBacklog).toBeGreaterThanOrEqual(1);

      const closed = await claimOnly([first.id], 'itest-closed-window');
      expect(closed.rows.map((row) => row.id)).toEqual([first.id]);
      const row = closed.rows[0]!;
      expect(row.topic).toBe(AUDIT_TRAIL_TOPIC);
      const envelope = parseEnvelope(row.payload, auditTrailPayloadSchemaV1);
      expect(envelope.eventId).toBe(first.id);
      expect(envelope.payload.occurrenceCount).toBe(2);
      expect(envelope.occurredAt).toBe((await rowById(first.id)).occurredAt.toISOString());

      expect(await store.markPublished([first.id], closed.token!)).toBe(1);
      expect(await rowById(first.id)).toMatchObject({ occurrenceCount: 2, claimCount: 1 });
    });

    it('a refusal waiting on an in-flight claim of its row is counted in a successor row; the claimed row never changes', async () => {
      const base = refusalDraft();
      await atFreshWindow(prisma, WINDOW_SECONDS, 20_000);
      const first = await store.capture(again(base), CAPTURE);
      await store.capture(again(base), CAPTURE);
      const locker = await independentClient();

      let pending: Promise<CapturedOccurrence> | undefined;
      let settled = false;
      await locker.client.$transaction(
        async (tx) => {
          // Exactly the columns a claim writes, held uncommitted.
          const claimed = await tx.$executeRawUnsafe(
            `UPDATE security_event_outbox
                SET claim_token = $2, claim_owner = 'itest-race',
                    claim_expires_at = now() + interval '60 seconds',
                    claim_count = claim_count + 1
              WHERE id = $1`,
            first.id,
            randomUUID(),
          );
          expect(claimed).toBe(1);

          pending = store.capture(again(base), CAPTURE);
          pending.then(
            () => (settled = true),
            () => (settled = true),
          );
          await sleep(500);
          // Blocked on the row the claim holds — neither counted into it nor
          // anywhere else yet.
          expect(settled).toBe(false);
        },
        { maxWait: 10_000, timeout: 30_000 },
      );

      const successor = await pending!;
      expect(successor.created).toBe(true);
      expect(successor.id).not.toBe(first.id);
      expect(successor.occurrenceCount).toBe(1);
      expect(await rowById(first.id)).toMatchObject({ occurrenceCount: 2, claimCount: 1 });

      // And the database itself refuses to change a claimed row's count.
      await expect(
        prisma.client.$executeRawUnsafe(
          'UPDATE security_event_outbox SET occurrence_count = occurrence_count + 1 WHERE id = $1',
          first.id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);
    });

    it('a claim skips a row whose count is being written, and takes it with the final count after', async () => {
      const base = refusalDraft();
      const first = await store.capture(again(base), ONE_SECOND_WINDOW);
      await waitForWindowClose(prisma, first.id);
      const locker = await independentClient();

      await locker.client.$transaction(
        async (tx) => {
          // What an in-flight increment holds on the row.
          await tx.$queryRawUnsafe(
            'SELECT id FROM security_event_outbox WHERE id = $1 FOR UPDATE',
            first.id,
          );
          const during = await claimOnly([first.id], 'itest-skip-locked');
          expect(during.rows).toHaveLength(0);
        },
        { maxWait: 10_000, timeout: 30_000 },
      );

      const after = await claimOnly([first.id], 'itest-after-lock');
      expect(after.rows.map((row) => row.id)).toEqual([first.id]);
      expect(countOf(after.rows[0]!)).toBe(1);
      expect(await store.markPublished([first.id], after.token!)).toBe(1);
    });

    it('loses no refusal and changes no claimed row while captures race window closes and claims', async () => {
      const base = refusalDraft();
      const stores = [
        store,
        await independentStore(),
        await independentStore(),
        await independentStore(),
      ];
      const claimedCounts = new Map<string, number>();
      const writersUntil = Date.now() + 3_500;
      let captured = 0;
      let claiming = true;

      const drainMine = async (owner: string): Promise<void> => {
        const claim = await store.claimPending({ limit: 1000, owner, leaseSeconds: 60 });
        if (!claim.token) return;
        const mine = claim.rows.filter((row) => row.aggregateId === base.actorId);
        const others = claim.rows.filter((row) => row.aggregateId !== base.actorId);
        if (others.length > 0) {
          await store.release(
            others.map((row) => row.id),
            claim.token,
          );
        }
        for (const row of mine) claimedCounts.set(row.id, countOf(row));
        if (mine.length > 0) {
          expect(
            await store.markPublished(
              mine.map((row) => row.id),
              claim.token,
            ),
          ).toBe(mine.length);
        }
      };

      const writers = stores.map(async (writer) => {
        while (Date.now() < writersUntil) {
          await writer.capture(again(base), ONE_SECOND_WINDOW);
          captured += 1;
        }
      });
      const claimer = (async () => {
        while (claiming) {
          await drainMine('itest-race-claimer');
          await sleep(20);
        }
      })();

      await Promise.all(writers);
      for (const row of await rowsFor(base.actorId)) {
        if (row.publishedAt === null) await waitForWindowClose(prisma, row.id);
      }
      claiming = false;
      await claimer;
      await drainMine('itest-race-final');

      const rows = await rowsFor(base.actorId);
      expect(captured).toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.every((row) => row.publishedAt !== null)).toBe(true);
      // Every refusal is in exactly one row …
      expect(rows.reduce((sum, row) => sum + row.occurrenceCount, 0)).toBe(captured);
      // … and every row published the count it still holds.
      for (const row of rows) expect(claimedCounts.get(row.id)).toBe(row.occurrenceCount);
    }, 120_000);

    it('lease fencing: a reclaimed aggregated row is re-published with the same eventId and count, and only the new owner acknowledges', async () => {
      const base = refusalDraft();
      await atFreshWindow(prisma, 1, 500);
      const first = await store.capture(again(base), ONE_SECOND_WINDOW);
      await store.capture(again(base), ONE_SECOND_WINDOW);
      await store.capture(again(base), ONE_SECOND_WINDOW);
      await waitForWindowClose(prisma, first.id);
      const persisted = (await rowById(first.id)).occurrenceCount;

      const workerA = await claimOnly([first.id], 'worker-a', 1);
      expect(workerA.rows).toHaveLength(1);
      await sleep(1_500);
      const workerB = await claimOnly([first.id], 'worker-b', 60);
      expect(workerB.rows).toHaveLength(1);
      expect(workerB.reclaimed).toBeGreaterThanOrEqual(1);
      expect(workerB.token).not.toBe(workerA.token);

      expect(JSON.stringify(workerB.rows[0]!.payload)).toBe(
        JSON.stringify(workerA.rows[0]!.payload),
      );
      expect(countOf(workerA.rows[0]!)).toBe(persisted);
      expect(countOf(workerB.rows[0]!)).toBe(persisted);

      expect(await store.markPublished([first.id], workerA.token!)).toBe(0);
      expect(await store.markPublished([first.id], workerB.token!)).toBe(1);
      expect(await rowById(first.id)).toMatchObject({ occurrenceCount: persisted, claimCount: 2 });

      await expect(
        prisma.client.$executeRawUnsafe(
          'UPDATE security_event_outbox SET occurrence_count = occurrence_count + 1 WHERE id = $1',
          first.id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);
    });
  });

  describe('the table refuses what aggregation must never produce', () => {
    /** A row far in the future, so no claim in any suite can reach it. */
    const insert = (values: {
      id?: string;
      organizationId?: string | null;
      actorId?: string;
      occurredAt?: string;
      occurrenceCount?: number;
      startedAt?: string;
      endsAt?: string;
      publishedAt?: string | null;
    }) =>
      prisma.client.$executeRawUnsafe(
        `INSERT INTO security_event_outbox (
           id, organization_id, actor_type, actor_id, action, resource_type, error_code,
           correlation_id, producer_version, occurred_at, occurrence_count,
           window_started_at, window_ends_at, published_at
         ) VALUES ($1, $2, 'USER', $3, 'identity.active_organization.switch', 'User',
                   'TENANT_MISMATCH', 'COR_CONSTRAINT', '0.0.0', $4::timestamp(3), $5,
                   $6::timestamp(3), $7::timestamp(3), $8::timestamp(3))`,
        values.id ?? ulid(),
        values.organizationId === undefined ? tagged('ORG') : values.organizationId,
        values.actorId ?? tagged('USR'),
        values.occurredAt ?? '2099-01-01T00:00:30.000',
        values.occurrenceCount ?? 1,
        values.startedAt ?? '2099-01-01T00:00:00.000',
        values.endsAt ?? '2099-01-01T00:01:00.000',
        values.publishedAt ?? null,
      );

    it.each([
      [
        'a zero occurrence count',
        { occurrenceCount: 0 },
        'ck_security_event_outbox_occurrence_count_range',
      ],
      [
        'an empty window',
        { endsAt: '2099-01-01T00:00:00.000', occurredAt: '2099-01-01T00:00:00.000' },
        // Also outside its own window, so either CHECK may be the one reported.
        'ck_security_event_outbox_window_bounds|ck_security_event_outbox_occurred_within_window',
      ],
      [
        'a window over one hour',
        { endsAt: '2099-01-01T02:00:00.000' },
        'ck_security_event_outbox_window_bounds',
      ],
      [
        'a first occurrence before its window',
        { occurredAt: '2098-12-31T23:59:59.000' },
        'ck_security_event_outbox_occurred_within_window',
      ],
      [
        'a first occurrence at its window end',
        { occurredAt: '2099-01-01T00:01:00.000' },
        'ck_security_event_outbox_occurred_within_window',
      ],
      [
        'an aggregate in a single-instant window',
        {
          occurrenceCount: 2,
          occurredAt: '2099-01-01T00:00:00.000',
          endsAt: '2099-01-01T00:00:00.001',
        },
        'ck_security_event_outbox_aggregate_needs_window',
      ],
      [
        'a published row that was never claimed',
        { publishedAt: '2099-01-01T00:02:00.000' },
        'ck_security_event_outbox_published_was_claimed',
      ],
    ])('refuses %s', async (_label, values, constraint) => {
      await expect(insert(values)).rejects.toThrow(new RegExp(constraint));
    });

    it('refuses a second open row for one identity and window — NULL tenant included — but not beside a claimed or full one', async () => {
      const actorId = tagged('USR');
      const organizationId = tagged('ORG');
      const openId = ulid();
      await insert({ id: openId, actorId, organizationId });
      await expect(insert({ actorId, organizationId })).rejects.toThrow(OPEN_BUCKET_VIOLATION);

      const platformActor = tagged('USR');
      await insert({ actorId: platformActor, organizationId: null });
      await expect(insert({ actorId: platformActor, organizationId: null })).rejects.toThrow(
        OPEN_BUCKET_VIOLATION,
      );

      // Claimed: out of the index, so a successor is accepted.
      await prisma.client.$executeRawUnsafe(
        `UPDATE security_event_outbox
            SET claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1
          WHERE id = $1`,
        openId,
      );
      const successorId = ulid();
      await expect(insert({ id: successorId, actorId, organizationId })).resolves.toBe(1);

      // Full: out of the index too.
      await prisma.client.$executeRawUnsafe(
        'UPDATE security_event_outbox SET occurrence_count = $1 WHERE id = $2',
        MAX_OCCURRENCE_COUNT,
        successorId,
      );
      await expect(insert({ actorId, organizationId })).resolves.toBe(1);
    });

    it('freezes evidence, and lets the count only grow and only before the first claim', async () => {
      const id = ulid();
      await insert({ id });

      await expect(
        prisma.client.$executeRawUnsafe(
          "UPDATE security_event_outbox SET actor_id = 'USR_SOMEONE_ELSE' WHERE id = $1",
          id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);
      await expect(
        prisma.client.$executeRawUnsafe(
          "UPDATE security_event_outbox SET window_ends_at = window_ends_at + interval '1 second' WHERE id = $1",
          id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);

      await expect(
        prisma.client.$executeRawUnsafe(
          'UPDATE security_event_outbox SET occurrence_count = 5 WHERE id = $1',
          id,
        ),
      ).resolves.toBe(1);
      await expect(
        prisma.client.$executeRawUnsafe(
          'UPDATE security_event_outbox SET occurrence_count = 4 WHERE id = $1',
          id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);

      await prisma.client.$executeRawUnsafe(
        `UPDATE security_event_outbox
            SET claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1
          WHERE id = $1`,
        id,
      );
      await expect(
        prisma.client.$executeRawUnsafe(
          'UPDATE security_event_outbox SET occurrence_count = 6 WHERE id = $1',
          id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE security_event_outbox
              SET claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, claim_count = 0
            WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/tg_security_event_outbox_guard/);
    });
  });
});
