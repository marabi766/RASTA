import { runUnscoped } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import { CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import { projectTransitionsTotal } from '../src/observability/metrics';
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
 * The idempotency store against PostgreSQL (docs/06 § 6.8): a key still in
 * flight is a conflict, an expired key is reusable, expired records are purged
 * by age alone — and the key's completion commits with the resource it
 * created, so neither a crash after the commit nor a claim lost mid-work can
 * make one key create twice.
 */
describe('idempotency store', () => {
  let w: Wiring;
  let store: IdempotencyStore;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
    store = new IdempotencyStore(w.prisma, testEnv());
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
          claimToken: `seeded-${key}`,
          state,
          expiresAt,
          ...(state === 'COMPLETED'
            ? { responseStatus: 201, responseBody: { seeded: true }, resourceId: 'PRJ_SEEDED' }
            : {}),
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

  const keyRow = (organizationId: string, key: string) =>
    runUnscoped('inspect the idempotency record', () =>
      w.prisma.client.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: { organizationId, endpoint: CREATE_PROJECT_ENDPOINT, key },
        },
      }),
    );
  const projectsOf = (organizationId: string) =>
    runUnscoped('count the organization’s projects', () =>
      w.prisma.client.project.findMany({ where: { organizationId } }),
    );

  it('completes the key, with the created project’s id, in the project’s own transaction', async () => {
    const a = org();
    const project = await asAdmin(a, () => w.projects.create(PROJECT, 'atomic'));
    expect(await keyRow(a, 'atomic')).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 201,
      resourceId: project.id,
      responseBody: expect.objectContaining({ id: project.id }),
    });

    const replay = await asAdmin(a, () => w.projects.create(PROJECT, 'atomic'));
    expect(replay).toEqual(project);
    expect(await projectsOf(a)).toHaveLength(1);
  });

  it('a crash after the domain commit leaves a completed key: the retry replays', async () => {
    const a = org();
    // The first thing after the commit fails, as a process dying there would.
    jest.spyOn(projectTransitionsTotal, 'inc').mockImplementationOnce(() => {
      throw new Error('the process died after the commit');
    });
    await expect(asAdmin(a, () => w.projects.create(PROJECT, 'after-commit'))).rejects.toThrow(
      /died after the commit/,
    );

    const [created] = await projectsOf(a);
    expect(await keyRow(a, 'after-commit')).toMatchObject({
      state: 'COMPLETED',
      resourceId: created!.id,
    });
    const retried = await asAdmin(a, () => w.projects.create(PROJECT, 'after-commit'));
    expect(retried.id).toBe(created!.id);
    expect(await projectsOf(a)).toHaveLength(1);
  });

  it('a failure inside the domain transaction rolls back the project and releases the key', async () => {
    const a = org();
    const complete = store.complete.bind(store);
    jest.spyOn(IdempotencyStore.prototype, 'complete').mockImplementationOnce(async function (
      this: IdempotencyStore,
      ...args
    ) {
      await complete(...args);
      throw new Error('the transaction fails after the key was completed in it');
    });
    await expect(asAdmin(a, () => w.projects.create(PROJECT, 'rolled-back'))).rejects.toThrow(
      /fails after the key/,
    );
    expect(await projectsOf(a)).toEqual([]);
    expect(await keyRow(a, 'rolled-back')).toBeNull();

    // A corrected retry with the same key runs once.
    await asAdmin(a, () => w.projects.create(PROJECT, 'rolled-back'));
    expect(await projectsOf(a)).toHaveLength(1);
  });

  it('a claim purged and re-taken mid-work cannot complete, so its project is rolled back', async () => {
    const a = org();
    const createProject = w.repository.createProject.bind(w.repository);
    jest.spyOn(w.repository, 'createProject').mockImplementationOnce(async (tx, input) => {
      // While this request works, its claim expires, the purge removes it and
      // another caller claims the same key — all committed on other connections.
      await runUnscoped('simulate the purge and a competing claim', async () => {
        await w.prisma.client.idempotencyKey.deleteMany({
          where: { organizationId: a, key: 'purged' },
        });
        await w.prisma.client.idempotencyKey.create({
          data: {
            organizationId: a,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key: 'purged',
            requestHash: store.hash(PROJECT),
            claimToken: 'the-competing-claim',
            state: 'IN_PROGRESS',
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      });
      return createProject(tx, input);
    });

    await expect(asAdmin(a, () => w.projects.create(PROJECT, 'purged'))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await projectsOf(a)).toEqual([]);
    // The competing claim is untouched: not completed, not released.
    expect(await keyRow(a, 'purged')).toMatchObject({
      claimToken: 'the-competing-claim',
      state: 'IN_PROGRESS',
    });
  });

  it('lets exactly one of many concurrent requests with one key create', async () => {
    const a = org();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => asAdmin(a, () => w.projects.create(PROJECT, 'racing'))),
    );

    const projects = await projectsOf(a);
    expect(projects).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        expect(outcome.value.id).toBe(projects[0]!.id);
      } else {
        expect(outcome.reason).toMatchObject({ code: 'CONFLICT' });
      }
    }
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  });

  it('hashes a body independently of key order', () => {
    expect(store.hash({ a: 1, b: { c: 2, d: 3 } })).toBe(store.hash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(store.hash({ a: 1 })).not.toBe(store.hash({ a: 2 }));
  });
});
