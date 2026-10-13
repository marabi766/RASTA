import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { ContractRepository } from '../src/contract/contract.repository';
import { EventPublisher } from '../src/events/publisher';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IdempotencyStore,
  requiredIdempotencyKey,
  type ClaimFence,
  type RefusalFence,
} from '../src/shared/idempotency';
import { AuthorityRefusals } from '../src/signing/authority-refusals';
import {
  cleanup,
  databaseUrl,
  eventsOf,
  newOrganizationId,
  ownerDatabaseUrl,
  testEnv,
} from './helpers';

/**
 * The idempotency store (docs/06 § 6.8) against a real PostgreSQL, each way a claim can end:
 * completed and replayed, released after a failure, lapsed and taken over, lost to a successor,
 * held by a request that is still working, and never completed — and the record that keeps a
 * refusal's audit event from repeating. The routes' own use of it is proven in `sign.int-spec.ts`,
 * `cancel.int-spec.ts` and `approval-policy.int-spec.ts`.
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

  /**
   * A refusal is not terminal (docs/06 § 6.8): the claim is released, and its audit event is
   * de-duplicated by a record that lives as long as a completed response. The record's expiry is
   * judged against the instant the request claimed its key — never against when the purge ran.
   */
  describe('the refusal-audit record', () => {
    const OTHER_ENDPOINT = 'POST /v1/test/{id}/other';
    const refusals = (): AuthorityRefusals =>
      new AuthorityRefusals(prisma, new EventPublisher(testEnv()), new ContractRepository(prisma));
    /** A refusal of a party's authority, recorded through the request's fence. */
    const refuse = (org: string, fence: RefusalFence): Promise<never> =>
      refusals().refuse(
        {
          action: 'SIGN_CONTRACT',
          side: 'EMPLOYER',
          contractId: `CTR_${ulid()}`,
          organizationId: org,
          subjectId: null,
          reason: 'ROLE_NOT_PERMITTED',
        },
        RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['DRIVER']),
        fence,
      );
    const attempt = (
      org: string,
      k: string,
      before: (fence: RefusalFence) => Promise<void> = async () => undefined,
      endpoint = ENDPOINT,
    ) =>
      inOrganization(org, () =>
        store.execute(
          endpoint,
          k,
          { refused: true },
          200,
          async (fence) => {
            await before(fence);
            return refuse(org, fence);
          },
          async () => undefined,
        ),
      );
    const refusedEvents = async (org: string) =>
      (await eventsOf(prisma, org, 'CONTRACT_AUTHORITY_REFUSED')).length;

    const withOwner = async <T>(fn: (owner: PrismaClient) => Promise<T>): Promise<T> => {
      const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
      try {
        return await fn(owner);
      } finally {
        await owner.$disconnect();
      }
    };
    const recordsOf = (org: string, k: string) =>
      withOwner((owner) =>
        owner.refusalAuditDedupe.findMany({ where: { organizationId: org, key: k } }),
      );
    const expireRecordAt = (org: string, k: string, expiresAt: Date) =>
      withOwner((owner) =>
        owner.refusalAuditDedupe.updateMany({
          where: { organizationId: org, key: k },
          data: { expiresAt },
        }),
      );
    /** A record as a refusal would have left it, its lifetime chosen. */
    const plantRecord = (org: string, k: string, expiresAt: Date) =>
      withOwner((owner) =>
        owner.refusalAuditDedupe.create({
          data: {
            organizationId: org,
            userId: 'USR_1',
            key: k,
            requestHash: 'h',
            reason: 'ROLE_NOT_PERMITTED',
            expiresAt,
          },
        }),
      );
    /** The instant this request claimed its key: its lease, less the lease's length. */
    const claimedAt = async (org: string, k: string, endpoint = ENDPOINT): Promise<Date> => {
      const [claim] = (await rowsOf(org, k)).filter(
        (row) => row.endpoint === endpoint && row.state === 'IN_PROGRESS',
      );
      if (!claim) throw new Error('no claim in flight');
      return new Date(
        claim.expiresAt.getTime() - env.CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000,
      );
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('the same refusal repeated is audited once while the record lives, and again once it has expired — purged or not', async () => {
      const org = organization();
      const k = key();
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(1);

      // Expired, still in the table: the purge has not run. A request that claims now is new.
      await expireRecordAt(org, k, new Date(Date.now() - 1_000));
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(2);
      // The record was replaced, and lives again: the next repeat is not audited.
      const [record] = await recordsOf(org, k);
      expect(record!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(2);
    });

    it.each([
      ['expiring at the claim’s instant is expired: a new event', 0, 2],
      ['expiring a millisecond after it is not, though it has expired by the refusal: none', 1, 1],
    ])('the boundary is the claim: a record %s', async (_label, offsetMs, events) => {
      const org = organization();
      const k = key();
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(1);

      await expect(
        attempt(org, k, async () => {
          const at = await claimedAt(org, k);
          await expireRecordAt(org, k, new Date(at.getTime() + offsetMs));
          await sleep(5);
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(events);
    });

    it('two concurrent reuses after the record expired write exactly one event', async () => {
      const org = organization();
      const k = key();
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      await expireRecordAt(org, k, new Date(Date.now() - 1_000));

      // Two routes, one key, one caller and body: the claims do not serialise them, the record
      // does. Both hold their claims before either is refused.
      let arrived = 0;
      let bothClaimed!: () => void;
      const together = new Promise<void>((resolve) => {
        bothClaimed = resolve;
      });
      const meet = async () => {
        arrived += 1;
        if (arrived === 2) bothClaimed();
        await together;
      };
      const outcomes = await Promise.allSettled([
        attempt(org, k, meet, ENDPOINT),
        attempt(org, k, meet, OTHER_ENDPOINT),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
      for (const outcome of outcomes) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          code: 'INSUFFICIENT_ROLE',
        });
      }
      expect(await refusedEvents(org)).toBe(2);
      expect(await recordsOf(org, k)).toHaveLength(1);
    }, 20_000);

    it('a request that claimed while the record lived is audited once, with the purge run between its claim and its refusal', async () => {
      const org = organization();
      const k = key();
      await expect(attempt(org, k)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(1);

      await expect(
        attempt(org, k, async () => {
          // The record expires just after this request claimed, and the purge runs before it is
          // refused: the record stays, and the refusal is the same one repeated.
          const at = await claimedAt(org, k);
          await expireRecordAt(org, k, new Date(at.getTime() + 1));
          await sleep(5);
          await store.purgeExpired();
          expect(await recordsOf(org, k)).toHaveLength(1);
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      expect(await refusedEvents(org)).toBe(1);
    });

    it('is purged only once it expired more than a claim lease ago, and never while its key has a live claim', async () => {
      const org = organization();
      const lease = env.CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000;
      const longAgo = new Date(Date.now() - lease - 60_000);
      const old = key();
      const recent = key();
      const held = key();
      const lapsed = key();
      await plantRecord(org, old, longAgo);
      await plantRecord(org, recent, new Date(Date.now() - 1_000));
      await plantRecord(org, held, longAgo);
      await plant(org, held, 'h', 'IN_PROGRESS', new Date(Date.now() + 60_000));
      await plantRecord(org, lapsed, longAgo);
      await plant(org, lapsed, 'h', 'IN_PROGRESS', new Date(Date.now() - 1_000));

      await store.purgeExpired();
      expect(await recordsOf(org, old)).toEqual([]);
      expect(await recordsOf(org, recent)).toHaveLength(1);
      expect(await recordsOf(org, held)).toHaveLength(1);
      // A claim whose lease lapsed holds nothing: it is purged with its record.
      expect(await recordsOf(org, lapsed)).toEqual([]);
      expect(await rowsOf(org, lapsed)).toEqual([]);
    });

    it('a request whose claim was lost records nothing: a retryable 503, no event and no record', async () => {
      const org = organization();
      const k = key();
      await expect(
        attempt(org, k, async () => {
          await runUnscoped('the suite takes the claim away', () =>
            prisma.client.idempotencyKey.deleteMany({ where: { organizationId: org, key: k } }),
          );
        }),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryAfterSeconds: 1 });
      expect(await refusedEvents(org)).toBe(0);
      expect(await recordsOf(org, k)).toEqual([]);
    });
  });
});
