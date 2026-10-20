import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped, type EventConsumer } from '@rasta/nest-common';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import { RewardService } from '../src/reward/reward.service';
import { PARTICIPATION_RULE_LOCK_KEY } from '../src/reward/participation.service';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, ITEST_ACTOR, ownerDatabaseUrl } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

/**
 * The participation score, explained apart from reward points (COM-012
 * criterion 1, ADR-047 § 1).
 *
 * The facts arrive the way production's do: through the reward consumer, which
 * confirms each with its owner (`source-facts.fake.ts`) and records whose
 * behaviour it was. The score is then read over HTTP, as the caller, through
 * the real guard, controller, service and database. What is proved:
 *
 *  - no rule, no score — `NO_RULE`, never an invented zero (docs/24 Q-139);
 *  - the score is its breakdown, under the version it names, over its window,
 *    capped per window, and is counted whether or not any reward rule paid;
 *  - reward points stay where they were (`/v1/rewards/me` is untouched);
 *  - a person sees only their own score in the active organization: the same
 *    user in another organization, and a colleague in the same one, see
 *    nothing of it (tenant isolation, BOLA), and naming a user is a 400;
 *  - versions are created, numbered and audited, never edited.
 */
describe('participation breakdown (COM-012)', () => {
  let harness: ApiHarness;
  let http: Server;
  let consumer: RewardTriggerConsumer;
  const sources = new FakeSourceFacts();

  const orgA = apiTenant('PARTICIPATION-A');
  const orgB = apiTenant('PARTICIPATION-B');

  /** One person, a member of both organizations. */
  const ALICE = `${ITEST_ACTOR}-ALICE-${ulid().slice(-6)}`;
  const BOB = `${ITEST_ACTOR}-BOB-${ulid().slice(-6)}`;
  const CAROL = `${ITEST_ACTOR}-CAROL-${ulid().slice(-6)}`;
  /** Bound to the run, so the cleanup below finds exactly this run's versions. */
  const RULE_ADMIN = `${ITEST_ACTOR}-PARTICIPATION-ADMIN`;
  /** A second platform administrator, for the retry that must not overwrite them. */
  const OTHER_RULE_ADMIN = `${ITEST_ACTOR}-PARTICIPATION-ADMIN-B`;

  const as = (userId: string, organizationId: string, roles = ['OPERATOR']) =>
    `Bearer ${bearer({
      sub: `sub-${userId}`,
      rastaUserId: userId,
      organizationId,
      organizationIds: [orgA, orgB],
      roles,
    })}`;
  const asRuleAdmin = () => as(RULE_ADMIN, orgA, ['SYSTEM_ADMIN']);
  const asOtherRuleAdmin = () => as(OTHER_RULE_ADMIN, orgA, ['SYSTEM_ADMIN']);

  /** A version request, under a fresh Idempotency-Key unless one is given. */
  const createVersion = (
    body: object,
    {
      token = asRuleAdmin(),
      key = `participation-${ulid()}`,
    }: { token?: string; key?: string } = {},
  ) =>
    request(http)
      .post('/v1/rewards/participation-rules')
      .set('authorization', token)
      .set('idempotency-key', key)
      .send(body);

  const noBroker = (): EventConsumer =>
    ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  /** A usage record its owner confirms, recorded by `recordedBy`, consumed. */
  async function usage(organizationId: string, recordedBy: string, recordedAt = daysAgo(1)) {
    const payload = { usageRecordId: `USG_${ulid()}`, assetId: `AST_${ulid()}`, organizationId };
    sources.recorded(payload, { recordedBy, recordedAt });
    await consumer.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload));
    return payload.usageRecordId;
  }

  async function repair(organizationId: string, completedBy: string, completedAt = daysAgo(1)) {
    const payload = { requestId: `MNT_${ulid()}`, assetId: `AST_${ulid()}`, organizationId };
    sources.completed(payload, { completedBy, completedAt });
    await consumer.handle(
      envelope(CONSUMED_EVENTS.MAINTENANCE_COMPLETED, {
        ...payload,
        type: 'PREVENTIVE',
        completedAt,
      }),
    );
    return payload.requestId;
  }

  function envelope(eventName: string, payload: Record<string, unknown>): EventEnvelope {
    return {
      eventId: ulid(),
      eventName,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'fleet-service',
      producerVersion: '0.1.0',
      aggregateType: 'UsageRecord',
      aggregateId: String(payload.usageRecordId ?? payload.requestId),
      tenantId: String(payload.organizationId),
      correlationId: `participation-itest-${ulid()}`,
      // A forged actor: the subject must come from the owner, never from here.
      actor: { type: 'USER', id: 'USR-FORGED-ACTOR' },
      payload,
    } as EventEnvelope;
  }

  const participation = (token: string, query = '') =>
    request(http).get(`/v1/rewards/me/participation${query}`).set('authorization', token);

  interface ChangeRecord {
    organizationId: string | null;
    ruleId: string;
    change: string;
    changedBy: string;
    before: { version: number } | null;
    after: { version: number; windowDays: number };
  }

  async function changeRecords(ruleId: string): Promise<ChangeRecord[]> {
    const rows = await runUnscoped('the suite reads the outbox it asserts on', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { eventName: 'PARTICIPATION_RULE_CHANGED', aggregateId: ruleId },
      }),
    );
    // The outbox stores the whole envelope; the record is its payload.
    return rows.map((row) => ({
      ...(row.payload as unknown as { payload: Omit<ChangeRecord, 'organizationId'> }).payload,
      organizationId: row.organizationId,
    }));
  }

  async function currentVersion(): Promise<number> {
    const listed = await request(http)
      .get('/v1/rewards/participation-rules')
      .set('authorization', asRuleAdmin())
      .expect(200);
    return (listed.body.items[0]?.version as number | undefined) ?? 0;
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    consumer = new RewardTriggerConsumer(
      noBroker,
      harness.prisma,
      harness.app.get(RewardService),
      sources,
    );
    // As consumers.int-spec.ts: the operator's cutover, before every fact here.
    await runUnscoped('the suite records the platform-wide cutover as an operator would', () =>
      recordCutoverIfMissing(harness.prisma.client, new Date('2021-01-01T00:00:00.000Z')),
    );
  });

  afterAll(async () => {
    // Platform-wide, append-only: only the owner, with the guard lifted inside
    // one transaction, removes this run's versions (as helpers.ts does for a
    // posted commission). Bound to the run's author.
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await owner.$transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE participation_rule DISABLE TRIGGER trg_participation_rule_append_only',
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM participation_rule WHERE created_by LIKE $1',
          `${ITEST_ACTOR}-%`,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(
          'ALTER TABLE participation_rule ENABLE TRIGGER trg_participation_rule_append_only',
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM reward_source_evaluation WHERE organization_id = ANY($1::text[])',
          [orgA, orgB],
        );
      });
    } finally {
      await owner.$disconnect();
    }
    await cleanup(harness.prisma, [orgA, orgB]);
    await harness.close();
  });

  describe('before any rule exists', () => {
    it('says NO_RULE with no score, rather than a zero nobody decided', async () => {
      // A fresh database has no version; another run's leftover would make
      // this assertion about that run, not about the default.
      if ((await currentVersion()) !== 0) return;
      // A verified fact exists; with no rule it still counts for nothing.
      await usage(orgA, CAROL);
      const response = await participation(as(CAROL, orgA)).expect(200);
      expect(response.body).toMatchObject({
        organizationId: orgA,
        userId: CAROL,
        spendable: false,
        status: 'NO_RULE',
        score: null,
        rule: null,
        window: null,
        breakdown: [],
        recentFacts: [],
      });
    });
  });

  describe('a rule version', () => {
    it('is created by a platform administrator only, and audited', async () => {
      const body = {
        windowDays: 30,
        contributions: [
          { triggerEvent: 'USAGE_RECORDED', weight: 2, maxPerWindow: 2 },
          { triggerEvent: 'MAINTENANCE_COMPLETED', weight: 5 },
        ],
        label: 'نمونه — نیازمند تصویب',
      };
      const before = await currentVersion();
      for (const token of [
        as(ALICE, orgA, ['ORGANIZATION_ADMIN']),
        as(ALICE, orgA, ['UNION_ADMIN']),
        `Bearer ${admin(orgA, ['AUDITOR'])}`,
      ]) {
        await createVersion({ ...body, expectedCurrentVersion: before }, { token }).expect(403);
      }
      await createVersion({
        ...body,
        expectedCurrentVersion: before,
        contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: -1 }],
      }).expect(400);
      // The version being replaced is part of the request, never assumed.
      await createVersion(body).expect(400);

      const created = await createVersion({ ...body, expectedCurrentVersion: before }).expect(201);
      expect(created.body).toMatchObject({
        version: before + 1,
        windowDays: 30,
        contributions: [
          { triggerEvent: 'USAGE_RECORDED', weight: 2, maxPerWindow: 2 },
          { triggerEvent: 'MAINTENANCE_COMPLETED', weight: 5, maxPerWindow: null },
        ],
        createdBy: RULE_ADMIN,
      });

      const [record] = await changeRecords(created.body.id as string);
      expect(record).toMatchObject({
        organizationId: orgA,
        ruleId: created.body.id,
        change: 'CREATED',
        changedBy: RULE_ADMIN,
        after: { version: before + 1, windowDays: 30 },
      });
      expect(record!.before === null).toBe(before === 0);
    });

    it('cannot be edited or deleted, even by SQL on the service connection', async () => {
      await expect(
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE participation_rule SET window_days = 1 WHERE created_by = $1`,
          RULE_ADMIN,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        harness.prisma.client.$executeRawUnsafe(
          `DELETE FROM participation_rule WHERE created_by = $1`,
          RULE_ADMIN,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('replaces the version it names only: of two made against the same one, one wins', async () => {
      const before = await currentVersion();
      const body = {
        expectedCurrentVersion: before,
        windowDays: 30,
        contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1 }],
      };
      const responses = await Promise.all([0, 1].map(() => createVersion(body)));
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const [won] = responses.filter((response) => response.status === 201);
      const [lost] = responses.filter((response) => response.status === 409);
      expect(won!.body.version).toBe(before + 1);
      expect(lost!.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await currentVersion()).toBe(before + 1);
      const [record] = await changeRecords(won!.body.id as string);
      expect(record!.before?.version ?? 0).toBe(before);
    });

    it('waits for a version being created, and numbers itself after it', async () => {
      // Deterministic where two requests at once are only likely to overlap: a
      // version is being created (lock held, row written, not committed) while
      // the request — made against that version — arrives. Without the lock it
      // would read the old number and be refused as stale.
      const before = await currentVersion();
      let pending: Promise<request.Response> | undefined;
      await harness.prisma.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PARTICIPATION_RULE_LOCK_KEY})`;
        await tx.$executeRaw`
          INSERT INTO participation_rule (id, version, window_days, contributions, created_by)
          VALUES (${`PRL_${ulid()}`}, ${before + 1}, 30,
                  '[{"triggerEvent":"USAGE_RECORDED","weight":1,"maxPerWindow":null}]'::jsonb,
                  ${RULE_ADMIN})`;
        pending = createVersion({
          expectedCurrentVersion: before + 1,
          windowDays: 30,
          contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1 }],
        }).then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      const response = await pending!;
      expect(response.status).toBe(201);
      expect(response.body.version).toBe(before + 2);
      const [record] = await changeRecords(response.body.id as string);
      expect(record!.before?.version).toBe(before + 1);
    });
  });

  describe('a retried request (review of #328, r1)', () => {
    const termsX = {
      windowDays: 30,
      contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 3 }],
      label: 'X',
    };
    const termsY = {
      windowDays: 14,
      contributions: [{ triggerEvent: 'MAINTENANCE_COMPLETED', weight: 4 }],
      label: 'Y',
    };

    it('replays the version its first attempt created, and never replaces one made since', async () => {
      const current = await currentVersion();
      const keyK = `participation-retry-${ulid()}`;
      const requestX = { ...termsX, expectedCurrentVersion: current };

      // 1. Administrator A sends X under K; it commits, and the response is lost.
      const first = await createVersion(requestX, { key: keyK }).expect(201);
      expect(first.body.version).toBe(current + 1);
      // 2. Administrator B, who saw A's version, replaces it with Y.
      const second = await createVersion(
        { ...termsY, expectedCurrentVersion: current + 1 },
        { token: asOtherRuleAdmin() },
      ).expect(201);
      expect(second.body.version).toBe(current + 2);
      // 3. A retries the identical request under K.
      const retry = await createVersion(requestX, { key: keyK }).expect(201);

      // The first answer, exactly — not a new version of X over Y.
      expect(retry.body).toEqual(first.body);
      const listed = await request(http)
        .get('/v1/rewards/participation-rules')
        .set('authorization', asRuleAdmin())
        .expect(200);
      expect(listed.body.items[0]).toMatchObject({
        id: second.body.id,
        version: current + 2,
        label: 'Y',
        createdBy: OTHER_RULE_ADMIN,
      });
      expect(
        (listed.body.items as { version: number }[]).filter((item) => item.version > current),
      ).toHaveLength(2);
      expect(await changeRecords(first.body.id as string)).toHaveLength(1);
    });

    it('refuses the key with other terms, or from another administrator, and writes nothing', async () => {
      const current = await currentVersion();
      const key = `participation-reuse-${ulid()}`;
      const requestX = { ...termsX, expectedCurrentVersion: current };
      await createVersion(requestX, { key }).expect(201);

      const otherTerms = await createVersion(
        { ...termsY, expectedCurrentVersion: current },
        { key },
      ).expect(409);
      expect(otherTerms.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const otherActor = await createVersion(requestX, {
        key,
        token: asOtherRuleAdmin(),
      }).expect(409);
      expect(otherActor.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await currentVersion()).toBe(current + 1);
    });

    it('refuses a fresh request made against a version no longer in force, writing nothing', async () => {
      const current = await currentVersion();
      // An administrator still looking at the previous version, with a new key
      // — a key that expired, or another organization acted from.
      for (const stale of [current - 1, current + 1]) {
        const refused = await createVersion({ ...termsX, expectedCurrentVersion: stale }).expect(
          409,
        );
        expect(refused.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      }
      expect(await currentVersion()).toBe(current);
    });

    it('is refused without an Idempotency-Key', async () => {
      const current = await currentVersion();
      await request(http)
        .post('/v1/rewards/participation-rules')
        .set('authorization', asRuleAdmin())
        .send({ ...termsX, expectedCurrentVersion: current })
        .expect(400);
      expect(await currentVersion()).toBe(current);
    });
  });

  describe('the score', () => {
    const facts: Record<string, string> = {};

    beforeAll(async () => {
      // The version every assertion below reads under.
      await createVersion({
        expectedCurrentVersion: await currentVersion(),
        windowDays: 30,
        contributions: [
          { triggerEvent: 'USAGE_RECORDED', weight: 2, maxPerWindow: 2 },
          { triggerEvent: 'MAINTENANCE_COMPLETED', weight: 5 },
        ],
      }).expect(201);

      // Alice in A: three usage records in the window (two count), one repair,
      // one usage record forty days ago (outside), and one recorded by nobody.
      facts.oldest = await usage(orgA, ALICE, daysAgo(3));
      facts.middle = await usage(orgA, ALICE, daysAgo(2));
      facts.latest = await usage(orgA, ALICE, daysAgo(1));
      facts.repair = await repair(orgA, ALICE, daysAgo(1));
      facts.outside = await usage(orgA, ALICE, daysAgo(40));
      facts.system = await usage(orgA, 'SYSTEM');
      // Bob in A, and Alice in B.
      facts.bob = await usage(orgA, BOB);
      facts.aliceInB = await usage(orgB, ALICE);
    });

    it('is its breakdown: counted × weight per kind, capped, under the version it names', async () => {
      const version = await currentVersion();
      const response = await participation(as(ALICE, orgA)).expect(200);
      expect(response.body).toMatchObject({
        organizationId: orgA,
        userId: ALICE,
        spendable: false,
        status: 'SCORED',
        score: 9,
        rule: { version, windowDays: 30 },
        breakdown: [
          {
            triggerEvent: 'USAGE_RECORDED',
            weight: 2,
            maxPerWindow: 2,
            facts: 3,
            counted: 2,
            contribution: 4,
          },
          {
            triggerEvent: 'MAINTENANCE_COMPLETED',
            weight: 5,
            maxPerWindow: null,
            facts: 1,
            counted: 1,
            contribution: 5,
          },
        ],
      });
      const window = response.body.window as { from: string; to: string };
      expect(Date.parse(window.to) - Date.parse(window.from)).toBe(30 * DAY);

      // The earliest two usage records count; the latest is past the cap.
      const effects = Object.fromEntries(
        (
          response.body.recentFacts as {
            sourceReference: string;
            counted: boolean;
            effect: number;
          }[]
        ).map((fact) => [fact.sourceReference, [fact.counted, fact.effect]]),
      );
      expect(effects).toEqual({
        [facts.oldest!]: [true, 2],
        [facts.middle!]: [true, 2],
        [facts.latest!]: [false, 0],
        [facts.repair!]: [true, 5],
      });
    });

    it('records whose fact it was from the owner, not from the event, and nobody for a system record', async () => {
      const rows = await runUnscoped('the suite reads the evaluations it asserts on', () =>
        harness.prisma.client.rewardSourceEvaluation.findMany({
          where: { sourceReference: { in: [facts.latest!, facts.system!] } },
        }),
      );
      const bySource = Object.fromEntries(rows.map((row) => [row.sourceReference, row]));
      expect(bySource[facts.latest!]).toMatchObject({ subjectUserId: ALICE, outcome: 'NO_RULE' });
      expect(bySource[facts.latest!]!.occurredAt).toBeInstanceOf(Date);
      expect(bySource[facts.system!]).toMatchObject({
        subjectUserId: null,
        occurredAt: null,
        outcome: 'NO_SUBJECT',
      });
    });

    it('does not count one fact twice when it is re-emitted under a new event id', async () => {
      const recorded = sources.usage.get(facts.latest!)!;
      const payload = {
        usageRecordId: recorded.id,
        assetId: recorded.assetId,
        organizationId: orgA,
      };
      await consumer.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload));
      const response = await participation(as(ALICE, orgA)).expect(200);
      expect(response.body.breakdown[0]).toMatchObject({ facts: 3, counted: 2 });
      expect(response.body.score).toBe(9);
    });

    it('is not reward points: no reward rule paid, and /v1/rewards/me holds nothing', async () => {
      const rewards = await request(http)
        .get('/v1/rewards/me')
        .set('authorization', as(ALICE, orgA))
        .expect(200);
      expect(rewards.body).toEqual({ balance: null, rewards: [] });
    });

    it('is the same person’s, but another organization’s, in B (tenant isolation)', async () => {
      const response = await participation(as(ALICE, orgB)).expect(200);
      expect(response.body).toMatchObject({ organizationId: orgB, userId: ALICE, score: 2 });
      expect(
        (response.body.recentFacts as { sourceReference: string }[]).map((f) => f.sourceReference),
      ).toEqual([facts.aliceInB]);
    });

    it('is only the caller’s own: a colleague sees theirs, and cannot name anybody else (BOLA)', async () => {
      const bob = await participation(as(BOB, orgA)).expect(200);
      expect(bob.body).toMatchObject({ userId: BOB, score: 2 });
      expect(
        (bob.body.recentFacts as { sourceReference: string }[]).map((f) => f.sourceReference),
      ).toEqual([facts.bob]);

      await participation(as(BOB, orgA), `?userId=${encodeURIComponent(ALICE)}`).expect(400);
      await participation(as(BOB, orgA), `?organizationId=${orgB}`).expect(400);
    });

    it('is refused to the oversight role, and to an unauthenticated caller', async () => {
      await participation(`Bearer ${admin(orgA, ['AUDITOR'])}`).expect(403);
      await request(http).get('/v1/rewards/me/participation').expect(401);
    });

    it('reads the window under the next version from the instant it is created', async () => {
      const next = await createVersion({
        expectedCurrentVersion: await currentVersion(),
        windowDays: 30,
        contributions: [{ triggerEvent: 'MAINTENANCE_COMPLETED', weight: 1 }],
      }).expect(201);
      const response = await participation(as(ALICE, orgA)).expect(200);
      expect(response.body).toMatchObject({
        score: 1,
        rule: { id: next.body.id, version: next.body.version },
        breakdown: [
          { triggerEvent: 'MAINTENANCE_COMPLETED', facts: 1, counted: 1, contribution: 1 },
        ],
      });
      // The usage records are still there; this version does not count them.
      expect(
        (response.body.recentFacts as { sourceReference: string }[]).map((f) => f.sourceReference),
      ).toEqual([facts.repair]);

      const listed = await request(http)
        .get('/v1/rewards/participation-rules')
        .set('authorization', as(ALICE, orgA, ['ORGANIZATION_ADMIN']))
        .expect(200);
      expect(listed.body.items[0]).toMatchObject({ id: next.body.id, version: next.body.version });
      expect(listed.body.items[1].version).toBe((next.body.version as number) - 1);
    });
  });
});
