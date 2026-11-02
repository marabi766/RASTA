import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped, zodPipe } from '@rasta/nest-common';
import { bearer, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { createRewardRuleSchema } from '../src/reward/dto';
import { hashRequestBody } from '../src/shared/idempotency';

/**
 * `POST /v1/rewards/rules` replays a retry that says the same thing
 * differently (pre-review checklist #16; Codex PR-480 r1, R2).
 *
 * The body is put in canonical form before it is validated, hashed and
 * executed (`shared/canonical.ts`): the credit without leading zeros, the
 * instants as `toISOString`, the label's line endings LF. Before, `"01000"`,
 * `…:00.000Z` and CRLF retries of a created rule were each answered
 * `409 IDEMPOTENCY_KEY_REUSED` — never a second rule, but a legitimate retry
 * refused. A really different body is still refused, and a key stored before
 * this change is still never run twice.
 */
describe('the reward rule create, canonical before it is hashed (real HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('CANON');
  const person = `canon-${ulid().slice(-8)}`;
  const asSystem = () =>
    `Bearer ${bearer({
      sub: `sub-${person}`,
      rastaUserId: `USR-${person}`,
      organizationId: org,
      organizationIds: [org],
      roles: ['SYSTEM_ADMIN'],
    })}`;

  const createRule = (body: Record<string, unknown>, key: string) =>
    request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .set('idempotency-key', key)
      .send(body);

  /** Sent as raw JSON, so a CRLF reaches the server exactly as a client wrote it. */
  const createRaw = (json: string, key: string) =>
    request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .set('idempotency-key', key)
      .set('content-type', 'application/json')
      .send(json);

  const rulesOf = (marker: string) =>
    runUnscoped('the suite reads the rules it created', () =>
      harness.prisma.client.rewardRule.findMany({
        where: { organizationId: org, label: { startsWith: marker } },
        select: {
          id: true,
          label: true,
          creditPerPointMinor: true,
          validFrom: true,
          condition: true,
        },
      }),
    );

  const storedHash = async (key: string) =>
    (
      await runUnscoped('the suite reads its key record', () =>
        harness.prisma.client.idempotencyKey.findUniqueOrThrow({
          where: {
            organizationId_endpoint_key: {
              organizationId: org,
              endpoint: 'POST /v1/rewards/rules',
              key,
            },
          },
          select: { requestHash: true },
        }),
      )
    ).requestHash;

  /** The hash this route stored before the change: the parsed body, as sent. */
  const hashBeforeTheChange = (body: Record<string, unknown>) =>
    hashRequestBody(zodPipe(createRewardRuleSchema).transform(body, { type: 'body' }));

  const body = (marker: string, overrides: Record<string, unknown> = {}) => ({
    organizationId: org,
    triggerEvent: 'USAGE_RECORDED',
    points: 3,
    creditPerPointMinor: '1000',
    validFrom: '2027-01-01T12:00:00Z',
    label: `${marker}\nsecond line`,
    ...overrides,
  });

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  it('replays the first rule to retries spelling the amount, the instant and the line endings differently', async () => {
    const marker = `canon-${ulid()}`;
    const key = id('canon');
    const first = await createRule(body(marker), key).expect(201);
    expect(first.body).toMatchObject({
      creditPerPointMinor: '1000',
      validFrom: '2027-01-01T12:00:00.000Z',
      label: `${marker}\nsecond line`,
    });

    for (const retry of [
      body(marker, { creditPerPointMinor: '01000' }),
      body(marker, { validFrom: '2027-01-01T12:00:00.000Z' }),
      body(marker, { validFrom: '2027-01-01T12:00Z' }),
    ]) {
      const replay = await createRule(retry, key).expect(201);
      expect(replay.body).toEqual(first.body);
    }
    const crlf = JSON.stringify(
      body(marker, { creditPerPointMinor: '0001000', validFrom: '2027-01-01T12:00:00.000Z' }),
    ).replace('\\nsecond line', '\\r\\nsecond line');
    expect(crlf).toContain('\\r\\n');
    const replay = await createRaw(crlf, key).expect(201);
    expect(replay.body).toEqual(first.body);

    expect(await rulesOf(marker)).toEqual([
      expect.objectContaining({ id: first.body.id, label: `${marker}\nsecond line` }),
    ]);
  });

  it('stores and executes the canonical form, whatever spelling came first', async () => {
    const marker = `canon-first-${ulid()}`;
    const key = id('canon-first');
    const json = JSON.stringify(
      body(marker, { creditPerPointMinor: '000250', validFrom: '2027-03-01T08:30Z' }),
    ).replace('\\nsecond line', '\\r\\nsecond line');
    const created = await createRaw(json, key).expect(201);

    expect(created.body).toMatchObject({
      creditPerPointMinor: '250',
      validFrom: '2027-03-01T08:30:00.000Z',
      label: `${marker}\nsecond line`,
    });
    const [rule] = await rulesOf(marker);
    expect(rule?.label).toBe(`${marker}\nsecond line`);
    expect(rule?.creditPerPointMinor?.toString()).toBe('250');
    // The plain spelling replays it.
    const replay = await createRule(
      body(marker, { creditPerPointMinor: '250', validFrom: '2027-03-01T08:30:00.000Z' }),
      key,
    ).expect(201);
    expect(replay.body.id).toBe(created.body.id);
  });

  it.each([
    ['another amount', { creditPerPointMinor: '1001' }],
    ['zero for the amount', { creditPerPointMinor: '0' }],
    ['the amount omitted', { creditPerPointMinor: undefined }],
    ['another instant', { validFrom: '2027-01-01T12:00:00.001Z' }],
    ['another label', { label: 'a different label' }],
  ])('still refuses a really different body under the key: %s', async (_, change) => {
    const marker = `canon-diff-${ulid()}`;
    const key = id('canon-diff');
    await createRule(body(marker), key).expect(201);

    const refused = await createRule({ ...body(marker), ...change }, key).expect(409);

    expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await rulesOf(marker)).toHaveLength(1);
  });

  it.each(['9007199254740993', '9007199254740991.1', '1.00000000000000001', '7'])(
    'F5 refuses raw JSON numeric operand %s before creating a rule',
    async (lexeme) => {
      const marker = `unsafe-number-${ulid()}`;
      const json = JSON.stringify(
        body(marker, { condition: { field: 'hours', op: 'gte', value: '__NUMBER__' } }),
      ).replace('"__NUMBER__"', lexeme);
      await createRaw(json, id('unsafe-number')).expect(400);
      expect(await rulesOf(marker)).toHaveLength(0);
    },
  );

  it('F5 trims a numeric field before canonicalizing equality for the idempotency hash', async () => {
    const marker = `trim-field-${ulid()}`;
    const key = id('trim-field');
    const first = await createRule(
      body(marker, { condition: { field: ' hours ', op: 'eq', value: '07.50' } }),
      key,
    ).expect(201);
    expect(first.body.condition).toEqual({ field: 'hours', op: 'eq', value: '7.5' });
    const replay = await createRule(
      body(marker, { condition: { field: 'hours', op: 'eq', value: '7.5' } }),
      key,
    ).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await rulesOf(marker)).toHaveLength(1);
  });

  it('F5 field whitespace cannot canonicalize invalid minor-unit grammar into an integer', async () => {
    const marker = `trim-minor-${ulid()}`;
    const created = await createRule(
      body(marker, { condition: { field: ' totalCostMinor ', op: 'gte', value: '1.0' } }),
      id('trim-minor'),
    ).expect(201);
    expect(created.body.condition).toEqual({ field: 'totalCostMinor', op: 'gte', value: '1.0' });
  });

  describe('the condition’s numeric operands (Codex PR-480 r2, R2)', () => {
    const leaf = (op: string, value: string) => ({ field: 'hours', op, value });
    const shapes: [string, (node: unknown) => unknown][] = [
      ['at the top', (node) => node],
      ['under all → any', (node) => ({ all: [{ field: 'x', op: 'present' }, { any: [node] }] })],
      ['under any → all', (node) => ({ any: [{ all: [{ field: 'x', op: 'absent' }, node] }] })],
    ];
    const combos = (['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const).flatMap((op) =>
      shapes.map(([where, shape]) => [op, where, shape] as const),
    );

    it.each(combos)(
      '%s %s: a retry with "7.5" replays the rule created with "07.50"; one rule, stored canonical',
      async (op, _, shape) => {
        const marker = `canon-cond-${ulid()}`;
        const key = id('canon-cond');
        const first = await createRule(
          body(marker, { condition: shape(leaf(op, '07.50')) }),
          key,
        ).expect(201);
        expect(first.body.condition).toEqual(shape(leaf(op, '7.5')));

        const replay = await createRule(
          body(marker, { condition: shape(leaf(op, '7.5')) }),
          key,
        ).expect(201);

        expect(replay.body).toEqual(first.body);
        const rules = await rulesOf(marker);
        expect(rules).toHaveLength(1);
        expect(rules[0]?.condition).toEqual(shape(leaf(op, '7.5')));
      },
    );

    it.each(combos)(
      '%s %s: 7.6 under the key of 7.5 is still 409, never a second rule',
      async (op, _, shape) => {
        const marker = `canon-cond-diff-${ulid()}`;
        const key = id('canon-cond-diff');
        await createRule(body(marker, { condition: shape(leaf(op, '7.50')) }), key).expect(201);

        const refused = await createRule(
          body(marker, { condition: shape(leaf(op, '7.6')) }),
          key,
        ).expect(409);

        expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(await rulesOf(marker)).toHaveLength(1);
      },
    );

    it.each(['eq', 'neq'])(
      '%s compares text: "7.5" under the key of "7.50" is 409, and "7.50" is stored as sent',
      async (op) => {
        const marker = `canon-cond-eq-${ulid()}`;
        const key = id('canon-cond-eq');
        const condition = { all: [{ any: [{ field: 'type', op, value: '7.50' }] }] };
        const first = await createRule(body(marker, { condition }), key).expect(201);
        expect(first.body.condition).toEqual(condition);

        const refused = await createRule(
          body(marker, { condition: { all: [{ any: [{ field: 'type', op, value: '7.5' }] }] } }),
          key,
        ).expect(409);

        expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(await rulesOf(marker)).toHaveLength(1);
      },
    );
  });

  describe('R3: retained pre-F5 fingerprints', () => {
    const forms = [
      ['leaf', (leaf: unknown) => leaf],
      ['nested all/any', (leaf: unknown) => ({ all: [{ any: [leaf] }] })],
    ] as const;
    const cases = [
      ['numeric eq', { field: 'hours', op: 'eq', value: '07.50' }, '07.50'],
      ['numeric neq', { field: 'hours', op: 'neq', value: '07.50' }, '07.50'],
      ['integer ordering', { field: 'totalCostMinor', op: 'gte', value: '1.0' }, '1'],
      ['long decimal', { field: 'hours', op: 'gte', value: '0'.repeat(260) + '7.50' }, '7.5'],
      ['JSON number', { field: 'hours', op: 'gte', value: 7.5 }, 7.5],
    ] as const;
    it.each(
      cases.flatMap(([name, leaf, oldValue]) =>
        forms.map(([where, shape]) => [name, where, leaf, oldValue, shape] as const),
      ),
    )(
      '%s %s replays the stored pre-deploy response, with no create',
      async (_, __, leaf, oldValue, shape) => {
        const marker = `legacy-f5-${ulid()}`;
        const key = id('legacy-f5');
        const sent = body(marker, { condition: shape(leaf) });
        // Build a completed pre-deploy row. This oracle explicitly reproduces
        // v1 defaults/instant/condition, independently of the compatibility parser.
        const oldCondition = shape({ ...leaf, value: oldValue });
        const oldBody = {
          ...sent,
          rewardType: 'POINTS',
          status: 'ACTIVE',
          validFrom: '2027-01-01T12:00:00.000Z',
          condition: oldCondition,
        };
        const first = await createRule(body(marker), key).expect(201);
        const stored = { ...first.body, condition: oldCondition };
        await runUnscoped('seed only this tenant retained deployment record', () =>
          harness.prisma.client.idempotencyKey.update({
            where: {
              organizationId_endpoint_key: {
                organizationId: org,
                endpoint: 'POST /v1/rewards/rules',
                key,
              },
            },
            data: { requestHash: hashRequestBody(oldBody), responseBody: stored },
          }),
        );
        const replay = await createRule(sent, key).expect(201);
        expect(replay.body).toEqual(stored);
        expect(await rulesOf(marker)).toHaveLength(1);
        expect(await storedHash(key)).toBe(hashRequestBody(oldBody));
        const different = await createRule({ ...sent, points: 4 }, key).expect(409);
        expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        const other = `Bearer ${bearer({
          sub: 'another-subject',
          rastaUserId: 'USR-another',
          organizationId: org,
          organizationIds: [org],
          roles: ['SYSTEM_ADMIN'],
        })}`;
        const refused = await request(http)
          .post('/v1/rewards/rules')
          .set('authorization', other)
          .set('idempotency-key', key)
          .send(sent)
          .expect(409);
        expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        await request(http)
          .post('/v1/rewards/rules')
          .set(
            'authorization',
            `Bearer ${bearer({
              sub: `sub-${person}`,
              rastaUserId: `USR-${person}`,
              organizationId: org,
              organizationIds: [org],
              roles: ['OPERATOR'],
            })}`,
          )
          .set('idempotency-key', key)
          .send(sent)
          .expect(403);
      },
    );
  });

  it.each(['IN_PROGRESS', 'EXPIRED', 'UNBOUND_ACTOR'] as const)(
    'R3: a retained %s numeric request never executes legacy work',
    async (state) => {
      const marker = `legacy-state-${ulid()}`;
      const key = id('legacy-state');
      const condition = { field: 'hours', op: 'gte', value: 7 };
      const sent = body(marker, { condition });
      const oldBody = {
        ...sent,
        rewardType: 'POINTS',
        status: 'ACTIVE',
        validFrom: '2027-01-01T12:00:00.000Z',
      };
      await createRule(body(marker), key).expect(201);
      await runUnscoped('seed only this tenant legacy lifecycle', () =>
        harness.prisma.client.idempotencyKey.update({
          where: {
            organizationId_endpoint_key: {
              organizationId: org,
              endpoint: 'POST /v1/rewards/rules',
              key,
            },
          },
          data: {
            requestHash: hashRequestBody(oldBody),
            ...(state === 'IN_PROGRESS'
              ? { state: 'IN_PROGRESS' }
              : state === 'UNBOUND_ACTOR'
                ? { actorHash: null }
                : {
                    createdAt: new Date('1999-12-31T00:00:00Z'),
                    expiresAt: new Date('2000-01-01T00:00:00Z'),
                  }),
          },
        }),
      );
      const refused = await createRule(sent, key).expect(state === 'EXPIRED' ? 400 : 409);
      if (state === 'IN_PROGRESS') expect(refused.body.code).toBe('CONFLICT');
      if (state === 'UNBOUND_ACTOR') expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await rulesOf(marker)).toHaveLength(1);
    },
  );

  describe('keys stored before this change (rollout)', () => {
    it('a canonical body hashed the same before: its retry replays', async () => {
      const marker = `canon-old-same-${ulid()}`;
      const key = id('canon-old-same');
      const sent = body(marker, { validFrom: '2027-01-01T12:00:00.000Z' });
      const first = await createRule(sent, key).expect(201);

      expect(await storedHash(key)).toBe(`reward-v2:${hashBeforeTheChange(sent)}`);
      const replay = await createRule(sent, key).expect(201);
      expect(replay.body.id).toBe(first.body.id);
    });

    it('a non-canonical body hashed differently before: its retry is 409, never a second rule', async () => {
      const marker = `canon-old-diff-${ulid()}`;
      const key = id('canon-old-diff');
      const sent = body(marker, { creditPerPointMinor: '01000' });
      await createRule(sent, key).expect(201);
      // The record as the previous release wrote it: the hash of the body as sent.
      const before = hashBeforeTheChange(sent);
      expect(before).not.toBe(await storedHash(key));
      await runUnscoped('the suite rewrites its key record as the old release stored it', () =>
        harness.prisma.client.idempotencyKey.update({
          where: {
            organizationId_endpoint_key: {
              organizationId: org,
              endpoint: 'POST /v1/rewards/rules',
              key,
            },
          },
          data: { requestHash: before },
        }),
      );

      const refused = await createRule(sent, key).expect(409);

      expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await rulesOf(marker)).toHaveLength(1);
    });
  });
});
