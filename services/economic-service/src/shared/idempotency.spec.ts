import { createHash } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { AllExceptionsFilter, createSystemContext, runWithContext } from '@rasta/nest-common';
import {
  IdempotencyStore,
  TerminalRefusalError,
  hashRequestBody,
  requestActor,
  targeted,
  type IdempotentAnswer,
} from './idempotency';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import type { EconomicEnv } from '../config/env';

/** The stored answers of these tests are nobody's object: any caller may have them. */
const openly = { mayReplay: async () => undefined };

/** The claim token the store reserved its key under: the first insert's. */
function tokenOf(idempotencyKey: { create: jest.Mock }): string {
  const [[{ data }]] = idempotencyKey.create.mock.calls as [[{ data: { claimToken: string } }]];
  return data.claimToken;
}

/**
 * A claim-side statement runs in a short transaction of its own, its lock
 * wait bounded (#196): the fake hands that transaction the same delegate.
 */
function withTransaction(idempotencyKey: unknown): PrismaService {
  const tx = { idempotencyKey, $queryRaw: jest.fn().mockResolvedValue([]) };
  return {
    client: {
      idempotencyKey,
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  } as unknown as PrismaService;
}

/**
 * Request-body canonicalisation for idempotent writes (docs/06 § 6.8).
 *
 * The failure mode this guards against is subtle and expensive: a client
 * retrying with the *same* request, serialised with its keys in a different
 * order, would hash differently and be refused with
 * `409 IDEMPOTENCY_KEY_REUSED` — a legitimate retry rejected as a conflict,
 * and no clear way for the caller to tell the difference.
 *
 * The opposite failure matters just as much. Two *different* requests must
 * never hash alike, or the second would silently replay the first's response
 * and a caller would be told a payment succeeded that never ran.
 */

describe('hashRequestBody', () => {
  it('is stable for the same body', () => {
    const body = { amountMinor: '10000000', currency: 'IRR' };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('ignores key order', () => {
    // The whole reason for canonicalising. Two clients, two JSON serialisers,
    // one request.
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(hashRequestBody({ b: 2, a: 1 }));
  });

  it('ignores key order at any depth', () => {
    expect(hashRequestBody({ outer: { a: 1, b: { c: 3, d: 4 } }, top: 'x' })).toBe(
      hashRequestBody({ top: 'x', outer: { b: { d: 4, c: 3 }, a: 1 } }),
    );
  });

  it('respects array order, which is meaningful', () => {
    // Unlike object keys. `[1,2]` and `[2,1]` are different requests.
    expect(hashRequestBody({ items: [1, 2] })).not.toBe(hashRequestBody({ items: [2, 1] }));
  });

  it('distinguishes a changed amount', () => {
    // The case that must never collide: the same idempotency key with a
    // different amount is a bug or an attack, and it has to be refused.
    expect(hashRequestBody({ amountMinor: '10000000' })).not.toBe(
      hashRequestBody({ amountMinor: '10000001' }),
    );
  });

  it('distinguishes a string from a number', () => {
    // Amounts cross the wire as strings (ADR-022); `"100"` and `100` are not
    // the same request.
    expect(hashRequestBody({ amountMinor: '100' })).not.toBe(hashRequestBody({ amountMinor: 100 }));
  });

  it('distinguishes null from absent', () => {
    expect(hashRequestBody({ a: null })).not.toBe(hashRequestBody({}));
  });

  it('distinguishes an added field', () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 1, b: 2 }));
  });

  it('handles a body that is not an object', () => {
    expect(hashRequestBody('plain')).toBe(hashRequestBody('plain'));
    expect(hashRequestBody(null)).toBe(hashRequestBody(null));
    expect(hashRequestBody('plain')).not.toBe(hashRequestBody(null));
  });

  it('produces a hex digest of the expected length', () => {
    expect(hashRequestBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('targeted — the request identity of a route that acts on one resource', () => {
  const reason = { reason: 'the order was cancelled before dispatch' };

  it('tells two resources apart even when the body is identical', () => {
    // The defect: hashing only the DTO made key K + this body on TXN_B look like
    // a retry of TXN_A, so TXN_B got TXN_A's stored response and was never touched.
    expect(hashRequestBody(targeted('TXN_A', reason))).not.toBe(
      hashRequestBody(targeted('TXN_B', reason)),
    );
  });

  it('is still a retry for the same resource and the same body', () => {
    expect(hashRequestBody(targeted('TXN_A', reason))).toBe(
      hashRequestBody(targeted('TXN_A', { ...reason })),
    );
  });

  it('with no body, hashes exactly what authorise-settlement always stored', () => {
    // So keys that route recorded before this change still match after it.
    expect(hashRequestBody(targeted('TXN_A'))).toBe(hashRequestBody({ id: 'TXN_A' }));
  });
});

/**
 * The actor a record is bound to (review of #287 r2, finding 1): a person by
 * the verified issuer and subject, a service by its name — never by the
 * platform user id, which is `rasta_uid` on one token and the IdP subject on
 * the next refresh of the same person's.
 */
describe('requestActor — who an idempotency record is bound to', () => {
  const ISSUER = 'https://idp.unit.test/realms/rasta';

  const actorOf = (context: Parameters<typeof createSystemContext>[0]) =>
    runWithContext(createSystemContext(context), () => hashRequestBody(requestActor()));

  const person = (overrides: Parameters<typeof createSystemContext>[0]) =>
    actorOf({
      authType: 'USER',
      roles: ['ORGANIZATION_ADMIN'],
      organizationId: 'ORG-UNIT',
      issuer: ISSUER,
      subject: 'sub-1',
      ...overrides,
    });

  it('is one person whether or not the token carries rasta_uid', () => {
    const withoutPlatformId = person({
      correlationId: 'a',
      userId: 'sub-1',
      platformUserId: false,
    });
    const withPlatformId = person({
      correlationId: 'b',
      userId: 'USR-1',
      platformUserId: true,
    });
    expect(withPlatformId).toBe(withoutPlatformId);
  });

  it('tells two subjects apart, even under one platform user id', () => {
    expect(person({ correlationId: 'a', userId: 'USR-1', subject: 'sub-1' })).not.toBe(
      person({ correlationId: 'b', userId: 'USR-1', subject: 'sub-2' }),
    );
  });

  it('tells two issuers apart for the same subject', () => {
    expect(person({ correlationId: 'a' })).not.toBe(
      person({ correlationId: 'b', issuer: 'https://idp.other.test/realms/rasta' }),
    );
  });

  it('is a service by its name alone, and never a person with the same name', () => {
    const service = (callerService: string) =>
      actorOf({ correlationId: callerService, organizationId: 'ORG-UNIT', callerService });
    expect(service('marketplace-service')).toBe(service('marketplace-service'));
    expect(service('marketplace-service')).not.toBe(service('contract-service'));
    expect(service('marketplace-service')).not.toBe(
      person({ correlationId: 'p', subject: 'marketplace-service' }),
    );
  });
});

/**
 * The claim race (economic batch 2, item g), with the database scripted so
 * each interleaving happens exactly, every run. The same property against a
 * real database, under real concurrency, is in `idempotency.int-spec.ts`.
 *
 * The rule under test: `PROCEED` comes only from the insert that wrote the
 * reservation. Anything else that "finds nothing there" has reserved nothing.
 */
describe('IdempotencyStore.claim — who may proceed', () => {
  const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const hour = 60 * 60 * 1000;

  function storeWith(script: {
    create: jest.Mock;
    findUnique?: jest.Mock;
    deleteMany?: jest.Mock;
  }) {
    const idempotencyKey = {
      create: script.create,
      findUnique: script.findUnique ?? jest.fn(),
      deleteMany: script.deleteMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = withTransaction(idempotencyKey);
    const store = new IdempotencyStore(prisma, {
      ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
    } as EconomicEnv);
    return { store, idempotencyKey };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
      fn,
    );

  it('retries the insert, rather than proceeding, when the row it lost to has vanished', async () => {
    // Lost the insert; the winner then released its failed attempt before
    // this read. Proceeding here reserved nothing — a third request could
    // insert and proceed alongside it.
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn().mockResolvedValueOnce(null),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
      token: expect.any(String),
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('reserves under a new random token every time', async () => {
    const { store, idempotencyKey } = storeWith({ create: jest.fn().mockResolvedValue({}) });

    const first = await asTenant(() => store.claim('POST /x', 'K1', {}));
    const second = await asTenant(() => store.claim('POST /x', 'K2', {}));
    const tokens = idempotencyKey.create.mock.calls.map(
      ([{ data }]: [{ data: { claimToken: string } }]) => data.claimToken,
    );
    expect(tokens).toEqual([
      (first as { token: string }).token,
      (second as { token: string }).token,
    ]);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('refuses a live key another actor reserved, as a key reused — never a replay', async () => {
    const { store } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        actorHash: hashRequestBody({ someone: 'else' }),
        state: 'COMPLETED',
        responseStatus: 200,
        responseBody: { secret: true },
        expiresAt: new Date(Date.now() + hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('replays a record from before actors were bound — the replay guard decides', async () => {
    const { store } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        actorHash: null,
        state: 'COMPLETED',
        responseStatus: 200,
        responseBody: { id: 'TXN_OLD' },
        expiresAt: new Date(Date.now() + hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).resolves.toEqual({
      kind: 'REPLAY',
      status: 200,
      body: { id: 'TXN_OLD' },
    });
  });

  it('removes an expired row only while it is still expired, then retries the insert', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn().mockResolvedValueOnce({
        requestHash: 'whatever',
        state: 'COMPLETED',
        expiresAt: new Date(Date.now() - hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
      token: expect.any(String),
    });
    // Conditional on expiry, so a fresh claim a racer put in its place — or
    // a row a racer already deleted — is never touched and never a 500.
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'ORG-UNIT',
        endpoint: 'POST /x',
        key: 'K',
        expiresAt: { lte: expect.any(Date) },
      }),
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('answers 409 in flight, never PROCEED, when the key keeps vanishing', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(3);
  });

  it('still refuses a live key in flight at once', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        actorHash: null,
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(1);
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('passes through an error that is not a lost race', async () => {
    const { store } = storeWith({
      create: jest.fn().mockRejectedValue(new Error('connection reset')),
    });
    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toThrow(
      'connection reset',
    );
  });

  // Codex round 3 on #121, M2, and the review of #135: the key is client
  // text, and `internalContext` reaches the debug log (AGENTS.md S-09). Neither
  // refusal carries the key or anything derived from it — not even the
  // truncated SHA-256 this service used to log, which a low-entropy key makes
  // guessable. Checked through the real exception filter: what it logs and
  // what it answers.
  const RAW_KEY = 'SENTINEL-client-chosen-key-4471';
  const OLD_DIGEST = createHash('sha256').update(RAW_KEY).digest('hex').slice(0, 16);

  function throughTheFilter(error: unknown): {
    logged: string;
    body: string;
    headers: Record<string, string>;
  } {
    const lines: unknown[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args);
    };
    const logger = { debug: record, warn: record, error: record } as unknown as Logger;
    let body: unknown;
    const headers: Record<string, string> = {};
    const response = {
      status: () => response,
      json: (sent: unknown) => {
        body = sent;
      },
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    new AllExceptionsFilter(logger).catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost);
    const dump = (value: unknown) =>
      JSON.stringify(value, (_key, field: unknown) =>
        field instanceof Error
          ? { ...field, name: field.name, message: field.message, stack: field.stack }
          : field,
      );
    return { logged: dump(lines), body: dump(body), headers };
  }

  it.each([
    ['reused with another body', 'COMPLETED', { other: true }, 'IDEMPOTENCY_KEY_REUSED', {}],
    ['in flight', 'IN_PROGRESS', {}, 'CONFLICT', { 'Retry-After': '1' }],
  ])(
    'keeps the key and its digest out of the error when it is %s',
    async (_case, state, body, code, expectedHeaders) => {
      const { store } = storeWith({
        create: jest.fn().mockRejectedValue(uniqueViolation),
        findUnique: jest.fn().mockResolvedValue({
          requestHash: hashRequestBody({}),
          actorHash: null,
          state,
          expiresAt: new Date(Date.now() + hour),
        }),
      });

      const error = (await asTenant(() => store.claim('POST /x', RAW_KEY, body)).catch(
        (thrown: unknown) => thrown,
      )) as { code: string; internalContext?: unknown };
      expect(error).toMatchObject({ code });
      const { logged, body: answered, headers } = throughTheFilter(error);
      expect(logged).toContain(code); // the line was written
      // Only the in-flight refusal asks for a wait, and only from its typed
      // field, never from its context.
      expect(headers).toEqual(expectedHeaders);
      expect(error.internalContext ?? {}).not.toHaveProperty('retryAfterSeconds');
      for (const text of [
        JSON.stringify(error.internalContext ?? {}),
        logged,
        answered,
        JSON.stringify(headers),
      ]) {
        expect(text).not.toContain(RAW_KEY);
        expect(text).not.toContain('SENTINEL');
        expect(text).not.toContain(OLD_DIGEST);
      }
    },
  );
});

/**
 * Which failure frees the key. The answer is stored inside the effect's own
 * transaction (review of #283, finding 2), so the effect and the completed key
 * commit together or not at all: a failure before that commit — the answer's
 * own write included — rolls both back and frees the key; a failure after it
 * finds the row COMPLETED, and the release, which only ever removes an
 * IN_PROGRESS row, removes nothing. The same property against a real database
 * is `idempotency.int-spec.ts` and `idempotent-answer-after-commit.int-spec.ts`.
 */
describe('IdempotencyStore.run — when the claim is released', () => {
  function claimedStore(updateMany: jest.Mock) {
    const idempotencyKey = {
      create: jest.fn().mockResolvedValue({}),
      updateMany,
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = withTransaction(idempotencyKey);
    const store = new IdempotencyStore(prisma, {
      ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
    } as EconomicEnv);
    // The effect's transaction, as the fake hands it out.
    const tx = { idempotencyKey } as unknown as ExtendedPrismaClient;
    return { store, idempotencyKey, tx };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-run', organizationId: 'ORG-UNIT' }),
      fn,
    );

  /** This request's own reservation: its key, still in progress, under its token (#287 r1, F2). */
  const ownClaim = (idempotencyKey: { create: jest.Mock }) => ({
    organizationId: 'ORG-UNIT',
    endpoint: 'POST /x',
    key: 'K',
    claimToken: tokenOf(idempotencyKey),
    state: 'IN_PROGRESS',
  });
  const completedOnly = (idempotencyKey: { create: jest.Mock }) => ({
    where: ownClaim(idempotencyKey),
    data: { state: 'COMPLETED', responseStatus: 201, responseBody: { id: 'TXN_UNIT' } },
  });

  it('stores the answer in the transaction the work hands it, and returns that answer', async () => {
    const { store, idempotencyKey, tx } = claimedStore(jest.fn().mockResolvedValue({ count: 1 }));

    await expect(
      asTenant(() =>
        store.run(
          'POST /x',
          'K',
          {},
          201,
          (answer: IdempotentAnswer<{ id: string }>) => answer.respond(tx, { id: 'TXN_UNIT' }),
          openly,
        ),
      ),
    ).resolves.toEqual({ id: 'TXN_UNIT' });
    expect(idempotencyKey.updateMany).toHaveBeenCalledWith(completedOnly(idempotencyKey));
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('after a stored answer, a later failure releases only an IN_PROGRESS row — none is left', async () => {
    const { store, idempotencyKey, tx } = claimedStore(jest.fn().mockResolvedValue({ count: 1 }));

    await expect(
      asTenant(() =>
        store.run(
          'POST /x',
          'K',
          {},
          201,
          async (answer: IdempotentAnswer<{ id: string }>) => {
            await answer.respond(tx, { id: 'TXN_UNIT' });
            throw new Error('the read after the commit failed');
          },
          openly,
        ),
      ),
    ).rejects.toThrow('the read after the commit failed');
    // The committed row is COMPLETED; this predicate cannot match it.
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({ where: ownClaim(idempotencyKey) });
  });

  it('fails the effect when its answer matches no claim in progress, so it never commits keyless', async () => {
    const { store, tx } = claimedStore(jest.fn().mockResolvedValue({ count: 0 }));

    await expect(
      asTenant(() =>
        store.run(
          'POST /x',
          'K',
          {},
          201,
          (answer: IdempotentAnswer<{ id: string }>) => answer.respond(tx, { id: 'TXN_UNIT' }),
          openly,
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps the claim of a work that returned without storing an answer', async () => {
    const { store, idempotencyKey } = claimedStore(jest.fn());

    await expect(
      asTenant(() => store.run('POST /x', 'K', {}, 201, async () => ({ id: 'TXN_UNIT' }), openly)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(idempotencyKey.updateMany).not.toHaveBeenCalled();
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('releases the claim when the work itself fails, so a corrected retry can run', async () => {
    const { store, idempotencyKey } = claimedStore(jest.fn());
    const work = jest.fn().mockRejectedValue(new Error('insufficient balance'));

    await expect(asTenant(() => store.run('POST /x', 'K', {}, 201, work, openly))).rejects.toThrow(
      'insufficient balance',
    );
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({ where: ownClaim(idempotencyKey) });
    expect(idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it('records a declared refusal only on its own claim', async () => {
    const { store, idempotencyKey } = claimedStore(jest.fn().mockResolvedValue({ count: 1 }));
    const refusals = { DECLINED: { code: 'BUSINESS_RULE_VIOLATION', message: 'Final' } } as const;
    const work = jest
      .fn()
      .mockRejectedValue(new TerminalRefusalError('DECLINED', refusals.DECLINED));

    await expect(
      asTenant(() =>
        store.run('POST /x', 'K', {}, 201, work, { ...openly, terminalRefusals: refusals }),
      ),
    ).rejects.toThrow('Final');
    expect(idempotencyKey.updateMany).toHaveBeenCalledWith({
      where: ownClaim(idempotencyKey),
      data: { state: 'COMPLETED', responseStatus: 422, responseBody: { refusal: 'DECLINED' } },
    });
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * A stored answer goes back only through the endpoint's replay guard (review
 * of #287, finding 1): what a fresh request would be refused, a replay is
 * refused too, and nothing of the record leaves first.
 */
describe('IdempotencyStore.run — a replay passes the endpoint’s object checks first', () => {
  const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  function storedStore(row: { responseStatus: number; responseBody: unknown }) {
    const idempotencyKey = {
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        actorHash: null,
        state: 'COMPLETED',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...row,
      }),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    };
    const store = new IdempotencyStore(withTransaction(idempotencyKey), {
      ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
    } as EconomicEnv);
    return { store, idempotencyKey };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-replay', organizationId: 'ORG-UNIT' }),
      fn,
    );
  const work = jest.fn();
  const notFound = Object.assign(new Error('Transaction not found'), { code: 'NOT_FOUND' });
  const refusals = {
    DECLINED: { code: 'BUSINESS_RULE_VIOLATION', message: 'Declined, and final' },
  } as const;

  it('asks the guard with the stored response, then returns it', async () => {
    const { store } = storedStore({ responseStatus: 200, responseBody: { id: 'TXN_STORED' } });
    const mayReplay = jest.fn().mockResolvedValue(undefined);

    await expect(
      asTenant(() => store.run('POST /x', 'K', {}, 200, work, { mayReplay })),
    ).resolves.toEqual({ id: 'TXN_STORED' });
    expect(mayReplay).toHaveBeenCalledWith({ id: 'TXN_STORED' });
    expect(work).not.toHaveBeenCalled();
  });

  it('answers what the guard refuses with, and nothing of the stored response', async () => {
    const { store, idempotencyKey } = storedStore({
      responseStatus: 200,
      responseBody: { id: 'TXN_STORED' },
    });

    const outcome = await asTenant(() =>
      store.run('POST /x', 'K', {}, 200, work, { mayReplay: () => Promise.reject(notFound) }),
    ).catch((error: unknown) => error);
    expect(outcome).toBe(notFound);
    expect(work).not.toHaveBeenCalled();
    // A refused replay is not a failed attempt: the record stays.
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('asks the guard before a recorded refusal too, with no response to name', async () => {
    const { store } = storedStore({ responseStatus: 422, responseBody: { refusal: 'DECLINED' } });
    const mayReplay = jest.fn().mockRejectedValue(notFound);

    await expect(
      asTenant(() =>
        store.run('POST /x', 'K', {}, 200, work, { mayReplay, terminalRefusals: refusals }),
      ),
    ).rejects.toBe(notFound);
    expect(mayReplay).toHaveBeenCalledWith(undefined);
  });

  it('brings a stored success to this release’s shape after the guard (Codex on #352, finding 2)', async () => {
    const { store } = storedStore({ responseStatus: 200, responseBody: { id: 'TXN_STORED' } });
    const mayReplay = jest.fn().mockResolvedValue(undefined);
    const stored = jest.fn((answer: { id: string }) => ({ ...answer, added: null }));

    await expect(
      asTenant(() => store.run('POST /x', 'K', {}, 200, work, { mayReplay, stored })),
    ).resolves.toEqual({ id: 'TXN_STORED', added: null });
    // The guard saw the answer as stored.
    expect(mayReplay).toHaveBeenCalledWith({ id: 'TXN_STORED' });
    expect(stored).toHaveBeenCalledWith({ id: 'TXN_STORED' });
  });

  it('never passes a recorded refusal through `stored`', async () => {
    const { store } = storedStore({ responseStatus: 422, responseBody: { refusal: 'DECLINED' } });
    const stored = jest.fn();

    await expect(
      asTenant(() =>
        store.run('POST /x', 'K', {}, 200, work, {
          mayReplay: () => Promise.resolve(),
          terminalRefusals: refusals,
          stored,
        }),
      ),
    ).rejects.toBeInstanceOf(TerminalRefusalError);
    expect(stored).not.toHaveBeenCalled();
  });
});

describe('hashRequestBody — every own key, whatever its name (#194)', () => {
  // JSON.parse makes the name an own key, as the request body parser does.
  const body = (name: string, x: number): unknown =>
    JSON.parse(`{"note":"n","details":{"${name}":{"x":${x}}}}`);

  it.each(['__proto__', 'constructor'])(
    'tells bodies apart that differ only under a %s key',
    (name) => {
      expect(hashRequestBody(body(name, 1))).not.toBe(hashRequestBody(body(name, 2)));
      expect(hashRequestBody(body(name, 1))).toBe(hashRequestBody(body(name, 1)));
    },
  );

  it('tells a body with a __proto__ key from the same body without it', () => {
    expect(hashRequestBody(JSON.parse('{"a":1,"__proto__":{"b":2}}'))).not.toBe(
      hashRequestBody({ a: 1 }),
    );
  });
});
