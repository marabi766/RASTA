import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IdempotencyStore,
  requiredIdempotencyKey,
  type ClaimFence,
} from '../src/shared/idempotency';
import { cleanup, databaseUrl, newOrganizationId, ownerDatabaseUrl } from './helpers';

/**
 * The idempotency store (docs/06 § 6.8) against a real PostgreSQL, each way a claim can end:
 * completed and replayed, released after a failure, lapsed and taken over, lost to a successor,
 * held by a request that is still working, and never completed. The routes' own use of it is
 * proven in `sign.int-spec.ts`, `cancel.int-spec.ts` and `approval-policy.int-spec.ts`.
 */
describe('the idempotency store', () => {
  let prisma: PrismaService;
  let store: IdempotencyStore;
  const organizations: string[] = [];
  const ENDPOINT = 'POST /v1/test/{id}';

  const env = {
    CONTRACT_IDEMPOTENCY_TTL_HOURS: 24,
    CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
  };

  const inOrganization = <T>(organizationId: string, fn: () => T, userId = 'USR_1'): T =>
    runWithContext(
      {
        requestId: ulid(),
        correlationId: ulid(),
        authType: 'USER',
        organizationId,
        organizationIds: [organizationId],
        userId,
        roles: ['ORGANIZATION_ADMIN'],
        startedAt: Date.now(),
      } as unknown as RequestContext,
      fn,
    );

  const organization = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const key = (): string => `idem-${ulid()}`;

  /** A row as the store would leave it, written by the owner so its lifetime can be chosen. */
  async function plant(
    organizationId: string,
    k: string,
    hash: string,
    state: 'IN_PROGRESS' | 'COMPLETED',
    expiresAt: Date,
  ): Promise<void> {
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await owner.idempotencyKey.create({
        data: {
          organizationId,
          endpoint: ENDPOINT,
          key: k,
          requestHash: hash,
          claimToken: ulid(),
          state,
          expiresAt,
          ...(state === 'COMPLETED'
            ? { responseStatus: 200, responseBody: { planted: true } }
            : {}),
        },
      });
    } finally {
      await owner.$disconnect();
    }
  }

  const rowsOf = (organizationId: string, k: string) =>
    runUnscoped('the suite reads the store', () =>
      prisma.client.idempotencyKey.findMany({ where: { organizationId, key: k } }),
    );

  beforeAll(() => {
    prisma = new PrismaService(databaseUrl());
    store = new IdempotencyStore(prisma, env);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await prisma.onModuleDestroy();
  });

  describe('the key itself', () => {
    it.each([
      ['missing', undefined],
      ['blank', '   '],
    ])('a %s key is VALIDATION_FAILED with code required', (_label, value) => {
      try {
        requiredIdempotencyKey(value);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as RastaError).details).toEqual([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
        ]);
      }
    });

    it.each([
      ['too short', 'short'],
      ['too long', 'k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)],
    ])('a key that is %s is VALIDATION_FAILED with code invalid', (_label, value) => {
      try {
        requiredIdempotencyKey(value);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as RastaError).details).toEqual([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'invalid' }),
        ]);
      }
    });

    it('is trimmed', () => {
      expect(requiredIdempotencyKey('  an-idempotency-key  ')).toBe('an-idempotency-key');
    });
  });

  describe('a command that completes', () => {
    it('runs once, stores its response and replays it — for the same caller only', async () => {
      const org = organization();
      const k = key();
      let runs = 0;
      const run = (userId = 'USR_1', body: object = { a: 1 }) =>
        inOrganization(
          org,
          () =>
            store.execute<{ n: number }>(
              ENDPOINT,
              k,
              body,
              201,
              async (fence) =>
                prisma.transaction(async (tx) => {
                  await fence.hold(tx);
                  runs += 1;
                  return fence.complete(tx, { n: runs });
                }),
              async () => undefined,
            ),
          userId,
        );

      expect(await run()).toEqual({ result: { n: 1 }, executed: true });
      expect(await run()).toEqual({ result: { n: 1 }, executed: false });
      expect(runs).toBe(1);
      const [row] = await rowsOf(org, k);
      expect(row).toMatchObject({ state: 'COMPLETED', responseStatus: 201 });

      // The same key from another person, or with another body, is another request: refused.
      await expect(run('USR_2')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      await expect(run('USR_1', { a: 2 })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it('does not replay a response the caller may no longer see', async () => {
      const org = organization();
      const k = key();
      const work = async (fence: ClaimFence<{ id: string }>) =>
        prisma.transaction(async (tx) => {
          await fence.hold(tx);
          return fence.complete(tx, { id: 'X' });
        });
      await inOrganization(org, () =>
        store.execute(ENDPOINT, k, {}, 200, work, async () => undefined),
      );
      await expect(
        inOrganization(org, () =>
          store.execute(ENDPOINT, k, {}, 200, work, async () => {
            throw RastaError.notFound('Thing', 'X');
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('a command that does not complete', () => {
    it('frees the key when it fails, so a corrected retry runs', async () => {
      const org = organization();
      const k = key();
      const failing = inOrganization(org, () =>
        store.execute(
          ENDPOINT,
          k,
          {},
          200,
          async () => {
            throw new Error('the work failed');
          },
          async () => undefined,
        ),
      );
      await expect(failing).rejects.toThrow('the work failed');
      expect(await rowsOf(org, k)).toEqual([]);

      const retry = await inOrganization(org, () =>
        store.execute(
          ENDPOINT,
          k,
          {},
          200,
          async (fence) =>
            prisma.transaction(async (tx) => {
              await fence.hold(tx);
              return fence.complete(tx, { ok: true });
            }),
          async () => undefined,
        ),
      );
      expect(retry).toEqual({ result: { ok: true }, executed: true });
    });

    it('treats a work that returns without completing its claim as a defect, and frees the key', async () => {
      const org = organization();
      const k = key();
      await expect(
        inOrganization(org, () =>
          store.execute(
            ENDPOINT,
            k,
            {},
            200,
            async () => ({ forgot: 'to complete' }),
            async () => undefined,
          ),
        ),
      ).rejects.toThrow(/returned without completing its idempotency claim/);
      expect(await rowsOf(org, k)).toEqual([]);
    });

    it('aborts a work whose claim was lost before it held it, and again before it completed it', async () => {
      const org = organization();
      const loseClaim = (k: string) =>
        runUnscoped('the suite takes the claim away', () =>
          prisma.client.idempotencyKey.deleteMany({ where: { organizationId: org, key: k } }),
        );

      const beforeHold = key();
      await expect(
        inOrganization(org, () =>
          store.execute(
            ENDPOINT,
            beforeHold,
            {},
            200,
            async (fence) => {
              await loseClaim(beforeHold);
              return prisma.transaction(async (tx) => {
                await fence.hold(tx);
                return fence.complete(tx, {});
              });
            },
            async () => undefined,
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/lapsed/) });

      const beforeComplete = key();
      await expect(
        inOrganization(org, () =>
          store.execute(
            ENDPOINT,
            beforeComplete,
            {},
            200,
            async (fence) =>
              prisma.transaction(async (tx) => {
                await loseClaim(beforeComplete);
                // `hold` skipped on purpose: the token still fences the completion.
                return fence.complete(tx, {});
              }),
            async () => undefined,
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/lapsed/) });
    });

    it('releasing a claim that is no longer this request’s changes nothing and does not throw', async () => {
      const org = organization();
      await expect(
        inOrganization(org, () => store.release(ENDPOINT, key(), 'no-such-token')),
      ).resolves.toBeUndefined();
    });
  });

  describe('a claim that lapsed or is still held', () => {
    it('is taken over once its lease has lapsed: the retry runs under a new token', async () => {
      const org = organization();
      const k = key();
      const hash = inOrganization(org, () => store.hash({}));
      await plant(org, k, hash, 'IN_PROGRESS', new Date(Date.now() - 60_000));

      const result = await inOrganization(org, () =>
        store.execute(
          ENDPOINT,
          k,
          {},
          200,
          async (fence) =>
            prisma.transaction(async (tx) => {
              await fence.hold(tx);
              return fence.complete(tx, { takenOver: true });
            }),
          async () => undefined,
        ),
      );
      expect(result).toEqual({ result: { takenOver: true }, executed: true });
    });

    it('a lapsed COMPLETED record is removed and the request runs again', async () => {
      const org = organization();
      const k = key();
      const hash = inOrganization(org, () => store.hash({}));
      await plant(org, k, hash, 'COMPLETED', new Date(Date.now() - 60_000));
      const result = await inOrganization(org, () =>
        store.execute(
          ENDPOINT,
          k,
          {},
          200,
          async (fence) =>
            prisma.transaction(async (tx) => {
              await fence.hold(tx);
              return fence.complete(tx, { again: true });
            }),
          async () => undefined,
        ),
      );
      expect(result.executed).toBe(true);
    });

    it('a duplicate of a request still in flight waits its budget out, then is a retryable CONFLICT', async () => {
      const org = organization();
      const k = key();
      const hash = inOrganization(org, () => store.hash({}));
      await plant(org, k, hash, 'IN_PROGRESS', new Date(Date.now() + 120_000));

      const started = Date.now();
      await expect(
        inOrganization(org, () =>
          store.execute(
            ENDPOINT,
            k,
            {},
            200,
            async () => ({}),
            async () => undefined,
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    }, 20_000);

    it('a request whose key is in flight under another body learns nothing of it: KEY_REUSED', async () => {
      const org = organization();
      const k = key();
      const hash = inOrganization(org, () => store.hash({ other: true }));
      await plant(org, k, hash, 'IN_PROGRESS', new Date(Date.now() + 120_000));
      await expect(
        inOrganization(org, () =>
          store.execute(
            ENDPOINT,
            k,
            {},
            200,
            async () => ({}),
            async () => undefined,
          ),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });
  });

  it('purges what has expired and nothing else', async () => {
    const org = organization();
    const old = key();
    const fresh = key();
    await plant(org, old, 'h', 'COMPLETED', new Date(Date.now() - 60_000));
    await plant(org, fresh, 'h', 'COMPLETED', new Date(Date.now() + 60_000));
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(org, old)).toEqual([]);
    expect(await rowsOf(org, fresh)).toHaveLength(1);
  });
});
