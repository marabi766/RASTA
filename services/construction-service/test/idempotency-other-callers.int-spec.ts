import { createHmac, randomBytes } from 'node:crypto';
import { runUnscoped, runWithContext } from '@rasta/nest-common';
import { CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import { IdempotencyStore, type RequestHasher } from '../src/shared/idempotency';
import {
  PROJECT,
  asAdmin,
  cleanup,
  context,
  newOrganizationId,
  newUserId,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * The replay fence (PM decision D-065) lives in the shared `IdempotencyStore`; these are the OTHER callers
 * of that store — a keyed request hasher (the bid's), a claim taken only after authorization, and the
 * atomic completion — proven unchanged when no replay deadline is sent. Each keeps its own full int-spec
 * (`bids`, `api-bids`, `idempotency`, `need-lifecycle` …); these three are the regression the fence adds.
 */
describe('the shared idempotency store, for callers that send no replay deadline', () => {
  let w: Wiring;
  let store: IdempotencyStore;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
    store = new IdempotencyStore(w.prisma, testEnv());
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const row = (organizationId: string, endpoint: string, key: string) =>
    runUnscoped('inspect the idempotency record', () =>
      w.prisma.client.idempotencyKey.findUnique({
        where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
      }),
    );

  /** A keyed, salted hasher of the bid's shape: nothing in the stored hash can be compared across claims. */
  const bidLikeHasher = (): RequestHasher => {
    const secret = randomBytes(32);
    return {
      hash: (body) => {
        const salt = randomBytes(8).toString('hex');
        return `${salt}.${createHmac('sha256', secret).update(salt).update(JSON.stringify(body)).digest('hex')}`;
      },
      matches: (stored, body) => {
        const [salt, mac] = stored.split('.');
        return (
          mac ===
          createHmac('sha256', secret).update(salt!).update(JSON.stringify(body)).digest('hex')
        );
      },
    };
  };

  it('bid hashing: a keyed hasher still replays, refuses another body, reuses an expired key — and stores no deadline', async () => {
    const a = org();
    const hasher = bidLikeHasher();
    const endpoint = 'POST /v1/tenders/{id}/bids';
    const body = { price: '1000' };
    const actAs = <T>(fn: () => T): T => asAdmin(a, fn, newUserId());

    const first = await actAs(() => store.claim(endpoint, 'bid-key', body, hasher));
    expect(first.kind).toBe('PROCEED');
    expect((await row(a, endpoint, 'bid-key'))?.replayDeadlineAt).toBeNull();

    // In flight: CONFLICT. Different body: REUSED.
    await expect(actAs(() => store.claim(endpoint, 'bid-key', body, hasher))).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );
    await expect(
      actAs(() => store.claim(endpoint, 'bid-key', { price: '2000' }, hasher)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    // Completed: the stored response. Expired: reusable, as before.
    await runUnscoped('complete and age the record', () =>
      w.prisma.client.idempotencyKey.update({
        where: { organizationId_endpoint_key: { organizationId: a, endpoint, key: 'bid-key' } },
        data: {
          state: 'COMPLETED',
          responseStatus: 201,
          responseBody: { bid: 'stored' },
          resourceId: 'BID_1',
        },
      }),
    );
    expect(await actAs(() => store.claim(endpoint, 'bid-key', body, hasher))).toEqual({
      kind: 'REPLAY',
      body: { bid: 'stored' },
    });
    await runUnscoped('age the record', () =>
      w.prisma.client.idempotencyKey.update({
        where: { organizationId_endpoint_key: { organizationId: a, endpoint, key: 'bid-key' } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    const again = await actAs(() => store.claim(endpoint, 'bid-key', body, hasher));
    expect(again.kind).toBe('PROCEED');
  });

  it('authorization first: an unauthorised caller claims nothing — with a replay deadline too', async () => {
    const a = org();
    const bystander = <T>(fn: () => T): T =>
      runWithContext(
        context({
          organizationId: a,
          organizationIds: [a],
          userId: newUserId(),
          roles: ['CONTRACTOR'],
        }),
        fn,
      );

    await expect(bystander(() => w.projects.create(PROJECT, 'no-claim'))).rejects.toMatchObject({
      code: 'INSUFFICIENT_ROLE',
    });
    await expect(
      bystander(() => w.projects.create(PROJECT, 'no-claim-fenced', Date.now() + 3_600_000)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    // A deadline already behind the clock changes nothing about who is told what: authorization is first.
    await expect(
      bystander(() => w.projects.create(PROJECT, 'no-claim-late', Date.now() - 1000)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    for (const key of ['no-claim', 'no-claim-fenced', 'no-claim-late']) {
      expect(await row(a, CREATE_PROJECT_ENDPOINT, key)).toBeNull();
    }
  });

  it('atomic completion: a claim purged and re-taken mid-work still cannot complete, with or without a deadline', async () => {
    for (const deadline of [undefined, Date.now() + 3_600_000]) {
      const a = org();
      const key = `taken-${deadline === undefined ? 'plain' : 'fenced'}`;
      const author = newUserId();
      const createProject = w.repository.createProject.bind(w.repository);
      jest.spyOn(w.repository, 'createProject').mockImplementationOnce(async (tx, input) => {
        await runUnscoped('simulate the purge and a competing claim', async () => {
          await w.prisma.client.idempotencyKey.deleteMany({ where: { organizationId: a, key } });
          await w.prisma.client.idempotencyKey.create({
            data: {
              organizationId: a,
              endpoint: CREATE_PROJECT_ENDPOINT,
              key,
              requestHash: store.hash({ requester: author, body: PROJECT }),
              claimToken: 'the-competing-claim',
              state: 'IN_PROGRESS',
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
        });
        return createProject(tx, input);
      });

      await expect(
        asAdmin(a, () => w.projects.create(PROJECT, key, deadline), author),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await runUnscoped('count projects', () =>
          w.prisma.client.project.findMany({ where: { organizationId: a } }),
        ),
      ).toEqual([]);
      expect(await row(a, CREATE_PROJECT_ENDPOINT, key)).toMatchObject({
        claimToken: 'the-competing-claim',
        state: 'IN_PROGRESS',
      });
    }
  });
});
