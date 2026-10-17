import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped, type EventConsumer } from '@rasta/nest-common';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import { RewardService } from '../src/reward/reward.service';
import { RECOGNITION_RULE_LOCK_KEY } from '../src/reward/recognition.service';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, ITEST_ACTOR, ownerDatabaseUrl } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

/**
 * Levels and badges as versioned configuration (COM-012 criterion 2,
 * ADR-047 § 1, docs/24 Q-140).
 *
 * Reward points and participation facts arrive the way production's do —
 * through the reward consumer, confirmed with their owner — and the level is
 * read over HTTP, as the caller, through the real guard, controller, service
 * and database. What is proved:
 *
 *  - no version, no level — `NO_RULE`, never a level nobody configured;
 *  - a version names its basis, and the caller's level and badges are read on
 *    exactly that basis: reward points in one version, the participation score
 *    in the next, from the instant it is created; `NO_BASIS` while the score
 *    has no rule;
 *  - only what is held is shown: no level above, no distance, no badge not
 *    held, no benefit;
 *  - a person sees only their own standing in the active organization: the
 *    same user in another organization, and a colleague, see nothing of it
 *    (tenant isolation, BOLA), and naming anyone is a 400;
 *  - versions are created by a platform administrator only, numbered,
 *    audited with the terms before and after, and never edited.
 */
describe('levels and badges (COM-012 criterion 2)', () => {
  let harness: ApiHarness;
  let http: Server;
  let consumer: RewardTriggerConsumer;
  const sources = new FakeSourceFacts();

  const orgA = apiTenant('RECOGNITION-A');
  const orgB = apiTenant('RECOGNITION-B');

  /** One person, a member of both organizations. */
  const ALICE = `${ITEST_ACTOR}-ALICE-${ulid().slice(-6)}`;
  const BOB = `${ITEST_ACTOR}-BOB-${ulid().slice(-6)}`;
  /** Bound to the run, so the cleanup below finds exactly this run's versions. */
  const RULE_ADMIN = `${ITEST_ACTOR}-RECOGNITION-ADMIN`;

  const as = (userId: string, organizationId: string, roles = ['OPERATOR']) =>
    `Bearer ${bearer({
      sub: `sub-${userId}`,
      rastaUserId: userId,
      organizationId,
      organizationIds: [orgA, orgB],
      roles,
    })}`;
  const asRuleAdmin = () => as(RULE_ADMIN, orgA, ['SYSTEM_ADMIN']);

  const noBroker = (): EventConsumer =>
    ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

  /** A usage record its owner confirms, recorded by `recordedBy` just now, consumed. */
  async function usage(organizationId: string, recordedBy: string) {
    const payload = { usageRecordId: `USG_${ulid()}`, assetId: `AST_${ulid()}`, organizationId };
    sources.recorded(payload, { recordedBy, recordedAt: new Date().toISOString() });
    await consumer.handle({
      eventId: ulid(),
      eventName: CONSUMED_EVENTS.USAGE_RECORDED,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'fleet-service',
      producerVersion: '0.1.0',
      aggregateType: 'UsageRecord',
      aggregateId: payload.usageRecordId,
      tenantId: organizationId,
      correlationId: `recognition-itest-${ulid()}`,
      actor: { type: 'USER', id: recordedBy },
      payload,
    } as EventEnvelope);
    return payload.usageRecordId;
  }

  const recognition = (token: string, query = '') =>
    request(http).get(`/v1/rewards/me/recognition${query}`).set('authorization', token);

  /** A second platform administrator, for the retry that must not overwrite them. */
  const OTHER_RULE_ADMIN = `${ITEST_ACTOR}-RECOGNITION-ADMIN-B`;
  const asOtherRuleAdmin = () => as(OTHER_RULE_ADMIN, orgA, ['SYSTEM_ADMIN']);

  /** A version request, under a fresh Idempotency-Key unless one is given. */
  const createVersion = (
    body: object,
    { token = asRuleAdmin(), key = `recognition-${ulid()}` }: { token?: string; key?: string } = {},
  ) =>
    request(http)
      .post('/v1/rewards/recognition-rules')
      .set('authorization', token)
      .set('idempotency-key', key)
      .send(body);

  /** `body` made against the version in force now. */
  const againstCurrent = async (body: object) => ({
    ...body,
    expectedCurrentVersion: await currentVersion(),
  });

  async function currentVersion(): Promise<number> {
    const listed = await request(http)
      .get('/v1/rewards/recognition-rules')
      .set('authorization', asRuleAdmin())
      .expect(200);
    return (listed.body.items[0]?.version as number | undefined) ?? 0;
  }

  interface ChangeRecord {
    organizationId: string | null;
    ruleId: string;
    change: string;
    changedBy: string;
    before: { version: number; basis: string } | null;
    after: { version: number; basis: string; levels: unknown[]; badges: unknown[] };
  }

  async function changeRecords(ruleId: string): Promise<ChangeRecord[]> {
    const rows = await runUnscoped('the suite reads the outbox it asserts on', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { eventName: 'RECOGNITION_RULE_CHANGED', aggregateId: ruleId },
      }),
    );
    return rows.map((row) => ({
      ...(row.payload as unknown as { payload: Omit<ChangeRecord, 'organizationId'> }).payload,
      organizationId: row.organizationId,
    }));
  }

  /** Reward points: twenty-five per usage record, in orgA only. */
  const POINTS_VERSION = {
    basis: 'REWARD_POINTS_CUMULATIVE',
    levels: [
      { name: 'سطح یک — نمونه', threshold: 0 },
      { name: 'سطح دو — نمونه', threshold: 20 },
      { name: 'سطح سه — نمونه', threshold: 1000 },
    ],
    badges: [
      { code: 'SAMPLE_FIVE', name: 'نشان پنج — نمونه', threshold: 5 },
      { code: 'SAMPLE_FIFTY', name: 'نشان پنجاه — نمونه', threshold: 50 },
    ],
    label: 'نمونه — نیازمند تصویب',
  };

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    consumer = new RewardTriggerConsumer(
      noBroker,
      harness.prisma,
      harness.app.get(RewardService),
      sources,
    );
    await runUnscoped('the suite records the platform-wide cutover as an operator would', () =>
      recordCutoverIfMissing(harness.prisma.client, new Date('2021-01-01T00:00:00.000Z')),
    );
  });

  afterAll(async () => {
    // Platform-wide, append-only: only the owner, with the guards lifted
    // inside one transaction, removes this run's versions. Bound to the run.
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await owner.$transaction(async (tx) => {
        for (const [table, trigger] of [
          ['recognition_rule', 'trg_recognition_rule_append_only'],
          ['participation_rule', 'trg_participation_rule_append_only'],
        ] as const) {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
          await tx.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE created_by LIKE $1`,
            `${ITEST_ACTOR}-%`,
          );
          // ISOLATION-ALLOW-UNBOUNDED: as above.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
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

  describe('before any version exists', () => {
    it('says NO_RULE with no level and no badges, rather than one nobody configured', async () => {
      // Another run's leftover would make this about that run, not the default.
      if ((await currentVersion()) !== 0) return;
      const response = await recognition(as(ALICE, orgA)).expect(200);
      expect(response.body).toEqual({
        organizationId: orgA,
        userId: ALICE,
        status: 'NO_RULE',
        asOf: expect.any(String),
        rule: null,
        basis: null,
        level: null,
        badges: [],
      });
    });
  });

  describe('a version', () => {
    it('is created by a platform administrator only', async () => {
      for (const token of [
        as(ALICE, orgA, ['ORGANIZATION_ADMIN']),
        as(ALICE, orgA, ['UNION_ADMIN']),
        as(ALICE, orgA, ['OPERATOR']),
        `Bearer ${admin(orgA, ['AUDITOR'])}`,
      ]) {
        await createVersion(await againstCurrent(POINTS_VERSION), { token }).expect(403);
      }
      await request(http).post('/v1/rewards/recognition-rules').send(POINTS_VERSION).expect(401);
    });

    it('names its basis explicitly, rising thresholds, and nothing it was not given', async () => {
      const before = await currentVersion();
      const { basis: _basis, ...withoutBasis } = POINTS_VERSION;
      // The version being replaced is part of the request, never assumed.
      await createVersion(POINTS_VERSION).expect(400);
      for (const body of [
        withoutBasis,
        { ...POINTS_VERSION, basis: 'LOGINS' },
        {
          ...POINTS_VERSION,
          levels: [
            { name: 'a', threshold: 10 },
            { name: 'b', threshold: 10 },
          ],
        },
        { ...POINTS_VERSION, levels: [], badges: [] },
        { ...POINTS_VERSION, benefits: ['PRIORITY_SUPPORT'] },
        { ...POINTS_VERSION, organizationId: orgA },
      ]) {
        await createVersion({ ...body, expectedCurrentVersion: before }).expect(400);
      }
    });

    it('is numbered, ranked in order, and audited with the actor and the terms before and after', async () => {
      const before = await currentVersion();
      const created = await createVersion({
        ...POINTS_VERSION,
        expectedCurrentVersion: before,
      }).expect(201);
      expect(created.body).toMatchObject({
        version: before + 1,
        basis: 'REWARD_POINTS_CUMULATIVE',
        levels: [
          { rank: 1, name: 'سطح یک — نمونه', threshold: 0 },
          { rank: 2, name: 'سطح دو — نمونه', threshold: 20 },
          { rank: 3, name: 'سطح سه — نمونه', threshold: 1000 },
        ],
        badges: POINTS_VERSION.badges,
        label: 'نمونه — نیازمند تصویب',
        createdBy: RULE_ADMIN,
      });

      const [record] = await changeRecords(created.body.id as string);
      expect(record).toMatchObject({
        organizationId: orgA,
        ruleId: created.body.id,
        change: 'CREATED',
        changedBy: RULE_ADMIN,
        after: {
          version: before + 1,
          basis: 'REWARD_POINTS_CUMULATIVE',
          levels: created.body.levels,
          badges: POINTS_VERSION.badges,
        },
      });
      expect(record!.before === null).toBe(before === 0);
      if (record!.before) expect(record!.before.version).toBe(before);
    });

    it('cannot be edited or deleted, even by SQL on the service connection', async () => {
      await expect(
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE recognition_rule SET basis = 'PARTICIPATION_SCORE' WHERE created_by = $1`,
          RULE_ADMIN,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        harness.prisma.client.$executeRawUnsafe(
          `DELETE FROM recognition_rule WHERE created_by = $1`,
          RULE_ADMIN,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('replaces the version it names only: of two made against the same one, one wins', async () => {
      const before = await currentVersion();
      const body = { ...POINTS_VERSION, expectedCurrentVersion: before };
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECOGNITION_RULE_LOCK_KEY})`;
        await tx.$executeRaw`
          INSERT INTO recognition_rule (id, version, basis, levels, badges, created_by)
          VALUES (${`RCR_${ulid()}`}, ${before + 1}, 'REWARD_POINTS_CUMULATIVE',
                  '[{"rank":1,"name":"L1","threshold":0}]'::jsonb, '[]'::jsonb, ${RULE_ADMIN})`;
        pending = createVersion({ ...POINTS_VERSION, expectedCurrentVersion: before + 1 }).then(
          (response) => response,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      const response = await pending!;
      expect(response.status).toBe(201);
      expect(response.body.version).toBe(before + 2);
      const [record] = await changeRecords(response.body.id as string);
      expect(record!.before?.version).toBe(before + 1);
    });

    it('is listed to administrators, newest first, and names no person', async () => {
      const listed = await request(http)
        .get('/v1/rewards/recognition-rules')
        .set('authorization', as(ALICE, orgA, ['ORGANIZATION_ADMIN']))
        .expect(200);
      const items = listed.body.items as { version: number }[];
      expect(items[0]!.version).toBeGreaterThan(items[1]!.version);
      expect(JSON.stringify(listed.body)).not.toContain(ALICE);

      await request(http)
        .get('/v1/rewards/recognition-rules')
        .set('authorization', as(ALICE, orgA, ['OPERATOR']))
        .expect(403);
    });
  });

  describe('a retried request (review of #328, r1)', () => {
    const termsY = {
      basis: 'PARTICIPATION_SCORE',
      levels: [{ name: 'Y — نمونه', threshold: 1 }],
      badges: [],
      label: 'Y',
    };

    it('replays the version its first attempt created, and never replaces one made since', async () => {
      const current = await currentVersion();
      const keyK = `recognition-retry-${ulid()}`;
      const requestX = { ...POINTS_VERSION, label: 'X', expectedCurrentVersion: current };

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
        .get('/v1/rewards/recognition-rules')
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
      const key = `recognition-reuse-${ulid()}`;
      const requestX = { ...POINTS_VERSION, expectedCurrentVersion: current };
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
      for (const stale of [current - 1, current + 1]) {
        const refused = await createVersion({
          ...POINTS_VERSION,
          expectedCurrentVersion: stale,
        }).expect(409);
        expect(refused.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      }
      expect(await currentVersion()).toBe(current);
    });

    it('is refused without an Idempotency-Key', async () => {
      const current = await currentVersion();
      await request(http)
        .post('/v1/rewards/recognition-rules')
        .set('authorization', asRuleAdmin())
        .send({ ...POINTS_VERSION, expectedCurrentVersion: current })
        .expect(400);
      expect(await currentVersion()).toBe(current);
    });
  });

  describe('the caller standing', () => {
    let pointsVersion: number;

    beforeAll(async () => {
      // Twenty-five reward points per usage record, in orgA only.
      await request(http)
        .post('/v1/rewards/rules')
        .set('authorization', asRuleAdmin())
        .send({ organizationId: orgA, triggerEvent: 'USAGE_RECORDED', points: 25 })
        .expect(201);
      pointsVersion = (await createVersion(await againstCurrent(POINTS_VERSION)).expect(201)).body
        .version as number;

      await usage(orgA, ALICE);
      // Alice in B: a fact, but no rule pays points there.
      await usage(orgB, ALICE);
    });

    it('is read on reward points under a points version: the level held and the badges held', async () => {
      const response = await recognition(as(ALICE, orgA)).expect(200);
      expect(response.body).toEqual({
        organizationId: orgA,
        userId: ALICE,
        status: 'EVALUATED',
        asOf: expect.any(String),
        rule: {
          id: expect.any(String),
          version: pointsVersion,
          basis: 'REWARD_POINTS_CUMULATIVE',
          label: 'نمونه — نیازمند تصویب',
          createdAt: expect.any(String),
        },
        basis: { kind: 'REWARD_POINTS_CUMULATIVE', value: 25, participationRuleVersion: null },
        level: { rank: 2, name: 'سطح دو — نمونه', threshold: 20 },
        badges: [{ code: 'SAMPLE_FIVE', name: 'نشان پنج — نمونه', threshold: 5 }],
      });

      // The points are the reward ledger's, unchanged by being read.
      const rewards = await request(http)
        .get('/v1/rewards/me')
        .set('authorization', as(ALICE, orgA))
        .expect(200);
      expect(rewards.body.balance).toMatchObject({ totalPoints: 25 });
    });

    it('shows nothing that is not held: no level above, no distance to it, no badge not held', async () => {
      const response = await recognition(as(ALICE, orgA)).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('سطح سه');
      expect(text).not.toContain('SAMPLE_FIFTY');
      expect(text).not.toMatch(/next|remaining|streak|progress|benefit/i);
    });

    it('is the same person’s, but another organization’s, in B (tenant isolation)', async () => {
      const response = await recognition(as(ALICE, orgB)).expect(200);
      expect(response.body).toMatchObject({
        organizationId: orgB,
        userId: ALICE,
        status: 'EVALUATED',
        basis: { kind: 'REWARD_POINTS_CUMULATIVE', value: 0 },
        level: { rank: 1 },
        badges: [],
      });
    });

    it('is only the caller’s own: a colleague sees theirs, and cannot name anybody else (BOLA)', async () => {
      const bob = await recognition(as(BOB, orgA)).expect(200);
      expect(bob.body).toMatchObject({
        userId: BOB,
        basis: { value: 0 },
        level: { rank: 1 },
        badges: [],
      });

      await recognition(as(BOB, orgA), `?userId=${encodeURIComponent(ALICE)}`).expect(400);
      await recognition(as(BOB, orgA), `?organizationId=${orgB}`).expect(400);
    });

    it('is refused to the oversight role, and to an unauthenticated caller', async () => {
      await recognition(`Bearer ${admin(orgA, ['AUDITOR'])}`).expect(403);
      await request(http).get('/v1/rewards/me/recognition').expect(401);
    });

    it('is read on the participation score under the next version, from the instant it is created', async () => {
      const scoreVersion = {
        basis: 'PARTICIPATION_SCORE',
        levels: [
          { name: 'مشارکت یک — نمونه', threshold: 1 },
          { name: 'مشارکت دو — نمونه', threshold: 3 },
        ],
        badges: [{ code: 'SAMPLE_SCORE_TWO', name: 'نشان — نمونه', threshold: 2 }],
      };
      const participationVersion = await request(http)
        .get('/v1/rewards/participation-rules')
        .set('authorization', asRuleAdmin())
        .expect(200)
        .then((listed) => (listed.body.items[0]?.version as number | undefined) ?? 0);

      const created = await createVersion(await againstCurrent(scoreVersion)).expect(201);

      if (participationVersion === 0) {
        // A score version with no participation rule: nothing to measure.
        const response = await recognition(as(ALICE, orgA)).expect(200);
        expect(response.body).toMatchObject({
          status: 'NO_BASIS',
          rule: { version: created.body.version, basis: 'PARTICIPATION_SCORE' },
          basis: { kind: 'PARTICIPATION_SCORE', value: null, participationRuleVersion: null },
          level: null,
          badges: [],
        });
      }

      // Three per usage record: Alice has one in A's window.
      const participation = await request(http)
        .post('/v1/rewards/participation-rules')
        .set('authorization', asRuleAdmin())
        .set('idempotency-key', `participation-${ulid()}`)
        .send({
          expectedCurrentVersion: participationVersion,
          windowDays: 30,
          contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 3 }],
        })
        .expect(201);

      const response = await recognition(as(ALICE, orgA)).expect(200);
      expect(response.body).toMatchObject({
        status: 'EVALUATED',
        rule: { id: created.body.id, version: created.body.version, basis: 'PARTICIPATION_SCORE' },
        basis: {
          kind: 'PARTICIPATION_SCORE',
          value: 3,
          participationRuleVersion: participation.body.version,
        },
        level: { rank: 2, name: 'مشارکت دو — نمونه', threshold: 3 },
        badges: [{ code: 'SAMPLE_SCORE_TWO' }],
      });
      // Not the 25 reward points: the basis is the version's.
      expect(response.body.basis.value).not.toBe(25);

      // Bob has no fact: a score of zero holds nothing under this version.
      const bob = await recognition(as(BOB, orgA)).expect(200);
      expect(bob.body).toMatchObject({
        status: 'EVALUATED',
        basis: { value: 0 },
        level: null,
        badges: [],
      });
    });
  });
});
