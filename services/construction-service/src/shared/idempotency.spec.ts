import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConstructionEnv } from '../config/env';
import { IdempotencyStore } from './idempotency';

/**
 * The claim's race branches, which a real database hits only by timing: a
 * collision whose row is gone by the time it is read, and an expired row.
 * Neither may ever let a caller proceed without a claim it inserted itself.
 */

const UNIQUE = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const ENDPOINT = 'POST /v1/projects';

function fakeStore() {
  const delegate = {
    create: jest.fn(),
    findUnique: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = { client: { idempotencyKey: delegate } } as unknown as PrismaService;
  const env = { CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: 24 } as ConstructionEnv;
  return { store: new IdempotencyStore(prisma, env), delegate };
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const context = {
    requestId: 'r',
    correlationId: 'c',
    authType: 'USER',
    organizationId: 'ORG_A',
    userId: 'USR_1',
    roles: [],
    startedAt: Date.now(),
  } as unknown as RequestContext;
  return runWithContext(context, fn);
}

function row(overrides: Record<string, unknown>) {
  return {
    requestHash: new IdempotencyStore({} as PrismaService, {} as ConstructionEnv).hash({ a: 1 }),
    claimToken: 'theirs',
    state: 'IN_PROGRESS',
    expiresAt: new Date(Date.now() + 60_000),
    responseBody: null,
    ...overrides,
  };
}

describe('IdempotencyStore.claim', () => {
  it('retries the atomic insert when the colliding row vanished, and proceeds only once it owns one', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValueOnce(UNIQUE).mockResolvedValueOnce({});
    delegate.findUnique.mockResolvedValueOnce(null);

    const outcome = await inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }));

    expect(outcome.kind).toBe('PROCEED');
    expect(delegate.create).toHaveBeenCalledTimes(2);
    // The claim it proceeds with is the token of the insert that succeeded.
    const inserted = delegate.create.mock.calls[1][0].data.claimToken;
    expect(outcome.kind === 'PROCEED' && outcome.claim.token).toBe(inserted);
  });

  it('never proceeds after a missing collision read: an in-flight row found on retry is a conflict', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValue(UNIQUE);
    delegate.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row({}));

    await expect(inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('gives up with a conflict, not a proceed, when the collision keeps vanishing', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValue(UNIQUE);
    delegate.findUnique.mockResolvedValue(null);

    await expect(inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(delegate.create).toHaveBeenCalledTimes(3);
  });

  it('removes an expired row only by its own token and expiry, then claims afresh', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValueOnce(UNIQUE).mockResolvedValueOnce({});
    delegate.findUnique.mockResolvedValueOnce(
      row({ claimToken: 'stale', expiresAt: new Date(Date.now() - 1000) }),
    );

    const outcome = await inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }));

    expect(outcome.kind).toBe('PROCEED');
    const [{ where }] = delegate.deleteMany.mock.calls[0];
    expect(where).toMatchObject({
      organizationId: 'ORG_A',
      endpoint: ENDPOINT,
      key: 'k',
      claimToken: 'stale',
      expiresAt: { lte: expect.any(Date) },
    });
  });

  it('replays a completed response and refuses a reused key with another body', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValue(UNIQUE);
    delegate.findUnique.mockResolvedValue(
      row({ state: 'COMPLETED', responseBody: { id: 'PRJ_1' } }),
    );

    await expect(inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }))).resolves.toEqual({
      kind: 'REPLAY',
      body: { id: 'PRJ_1' },
    });
    await expect(inTenant(() => store.claim(ENDPOINT, 'k', { a: 2 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('rethrows anything that is not a unique violation', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockRejectedValue(new Error('database down'));
    await expect(inTenant(() => store.claim(ENDPOINT, 'k', { a: 1 }))).rejects.toThrow(
      'database down',
    );
  });
});

describe('IdempotencyStore.execute', () => {
  it('runs the work directly when no key is given', async () => {
    const { store, delegate } = fakeStore();
    const outcome = await store.execute(ENDPOINT, undefined, {}, 201, async (record) => {
      await record({} as never, 'PRJ_1', 'done');
      return 'done';
    });
    expect(outcome).toEqual({ result: 'done', executed: true });
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it('refuses work that committed without recording its completion, and keeps the claim', async () => {
    const { store, delegate } = fakeStore();
    delegate.create.mockResolvedValue({});
    await expect(
      inTenant(() => store.execute(ENDPOINT, 'k', {}, 201, async () => 'forgot')),
    ).rejects.toThrow(/did not record its completion/);
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });
});
