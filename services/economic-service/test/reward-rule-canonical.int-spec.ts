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
        select: { id: true, label: true, creditPerPointMinor: true, validFrom: true },
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
    await runUnscoped('the suite removes the rules it created', () =>
      harness.prisma.client.rewardRule.deleteMany({ where: { organizationId: org } }),
    );
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

  describe('keys stored before this change (rollout)', () => {
    it('a canonical body hashed the same before: its retry replays', async () => {
      const marker = `canon-old-same-${ulid()}`;
      const key = id('canon-old-same');
      const sent = body(marker, { validFrom: '2027-01-01T12:00:00.000Z' });
      const first = await createRule(sent, key).expect(201);

      expect(await storedHash(key)).toBe(hashBeforeTheChange(sent));
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
