import { runUnscoped } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import { CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import {
  PROJECT,
  asAdmin,
  cleanup,
  newOrganizationId,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * The idempotency store's edges (docs/06 § 6.8): a key still in flight is a
 * conflict, an expired key is reusable, and expired records are purged by age
 * alone.
 */
describe('idempotency store', () => {
  let w: Wiring;
  let store: IdempotencyStore;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
    store = new IdempotencyStore(w.prisma, testEnv());
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  async function seedKey(
    organizationId: string,
    key: string,
    state: 'IN_PROGRESS' | 'COMPLETED',
    expiresAt: Date,
  ): Promise<void> {
    await runUnscoped('seed an idempotency record for the test', () =>
      w.prisma.client.idempotencyKey.create({
        data: {
          organizationId,
          endpoint: CREATE_PROJECT_ENDPOINT,
          key,
          requestHash: store.hash(PROJECT),
          state,
          expiresAt,
        },
      }),
    );
  }

  it('answers CONFLICT while the same key is still being processed', async () => {
    const a = org();
    await seedKey(a, 'in-flight', 'IN_PROGRESS', new Date(Date.now() + 60_000));

    await expect(asAdmin(a, () => w.projects.create(PROJECT, 'in-flight'))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('treats an expired key as unused and runs the command', async () => {
    const a = org();
    await seedKey(a, 'expired', 'COMPLETED', new Date(Date.now() - 60_000));

    const project = await asAdmin(a, () => w.projects.create(PROJECT, 'expired'));
    expect(project.status).toBe('DRAFT');
  });

  it('purges expired records and keeps live ones', async () => {
    const a = org();
    await seedKey(a, 'old', 'COMPLETED', new Date(Date.now() - 60_000));
    await seedKey(a, 'live', 'COMPLETED', new Date(Date.now() + 3_600_000));

    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    const left = await runUnscoped('inspect what the purge left', () =>
      w.prisma.client.idempotencyKey.findMany({ where: { organizationId: a } }),
    );
    expect(left.map((row) => row.key)).toEqual(['live']);
  });

  it('hashes a body independently of key order', () => {
    expect(store.hash({ a: 1, b: { c: 2, d: 3 } })).toBe(store.hash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(store.hash({ a: 1 })).not.toBe(store.hash({ a: 2 }));
  });
});
