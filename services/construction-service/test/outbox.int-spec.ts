import { eventEnvelopeSchema } from '@rasta/contracts';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { validateConstructionPayload, type ConstructionEventName } from '../src/events/events';
import {
  PROJECT,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The transactional outbox (AGENTS.md A-08, ADR-021, ADR-050, ADR-051 B3).
 *
 * Every row carries the platform envelope with the request's correlation id,
 * the tenant, a payload that satisfies its published contract, and a dense
 * per-project stream sequence allocated inside the writing transaction.
 */

describe('the transactional outbox', () => {
  let w: Wiring;
  let store: PrismaOutboxStore;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
    store = new PrismaOutboxStore(w.prisma);
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

  async function fullLifecycle(organizationId: string): Promise<string> {
    const project = await asAdmin(organizationId, () => w.projects.create(PROJECT));
    await asAdmin(organizationId, () =>
      w.projects.update(project.id, { expectedVersion: 1, title: 'Renamed project' }),
    );
    const need = await asAdmin(organizationId, () =>
      w.needs.add(project.id, { title: 'Gravel', description: 'Base course' }),
    );
    await asAdmin(organizationId, () =>
      w.needs.update(project.id, need.id, { expectedVersion: 1, unit: 'm3' }),
    );
    await asAdmin(organizationId, () =>
      w.needs.submit(project.id, need.id, { expectedVersion: 2 }),
    );
    await asAdmin(organizationId, () =>
      w.needs.withdraw(project.id, need.id, { expectedVersion: 3, reason: 'Scope was reduced' }),
    );
    await asAdmin(organizationId, () =>
      w.projects.cancel(project.id, { expectedVersion: 2, reason: 'Funding was withdrawn' }),
    );
    return project.id;
  }

  it('publishes all seven events, each valid against its contract and carrying the envelope', async () => {
    const a = org();
    const projectId = await fullLifecycle(a);

    const rows = await outboxFor(w.prisma, a);
    expect(rows.map((row) => row.eventName)).toEqual([
      'PROJECT_CREATED',
      'PROJECT_UPDATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_UPDATED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_NEED_WITHDRAWN',
      'PROJECT_STATUS_CHANGED',
    ]);

    for (const row of rows) {
      const envelope = eventEnvelopeSchema.parse(row.payload);
      expect(envelope).toMatchObject({
        eventName: row.eventName,
        producer: 'construction-service',
        aggregateType: 'Project',
        aggregateId: projectId,
        tenantId: a,
        streamKey: projectId,
        correlationId: row.correlationId,
      });
      expect(() =>
        validateConstructionPayload(row.eventName as ConstructionEventName, envelope.payload),
      ).not.toThrow();
      expect(row.topic).toBe('rasta.construction.v1');
      expect(row.partitionKey).toBe(projectId);
      expect(row.isStreamHead).toBe(false);
    }
  });

  it('numbers one project’s events as one dense stream, and another project’s separately', async () => {
    const a = org();
    const first = await fullLifecycle(a);
    const second = await asAdmin(a, () => w.projects.create({ ...PROJECT, title: 'Second' }));

    const rows = await outboxFor(w.prisma, a);
    const seqOf = (projectId: string) =>
      rows.filter((row) => row.partitionKey === projectId).map((row) => row.streamSeq);

    expect(seqOf(first)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(seqOf(second.id)).toEqual([1n]);
  });

  it('writes nothing for a refused command: the event rolls back with the state change', async () => {
    const a = org();
    const project = await asAdmin(a, () => w.projects.create(PROJECT));
    const before = (await outboxFor(w.prisma, a)).length;

    await expect(
      asAdmin(a, () => w.projects.update(project.id, { expectedVersion: 7, title: 'Stale' })),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    await expect(
      asAdmin(a, () => w.needs.submit(project.id, 'PND_NOPE', { expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await outboxFor(w.prisma, a)).toHaveLength(before);
    // The counter rolled back too: the next event takes the next number, no gap.
    await asAdmin(a, () => w.projects.update(project.id, { expectedVersion: 1, title: 'Fresh' }));
    expect((await outboxFor(w.prisma, a)).map((row) => row.streamSeq)).toEqual([1n, 2n]);
  });

  it('can be claimed and acknowledged by the relay with a fencing token (ADR-050)', async () => {
    const a = org();
    await asAdmin(a, () => w.projects.create(PROJECT));

    const claim = await store.claimPending({ limit: 500, owner: 'test', leaseSeconds: 60 });
    const mine = claim.rows.filter((row) => row.organizationId === a).map((row) => row.id);
    const others = claim.rows.filter((row) => row.organizationId !== a).map((row) => row.id);
    expect(mine).toHaveLength(1);

    expect(await store.markPublished(mine, 'not-the-token')).toBe(0);
    expect(await store.markPublished(mine, claim.token as string)).toBe(1);
    if (others.length > 0) await store.release(others, claim.token as string);

    const [row] = await outboxFor(w.prisma, a);
    expect(row?.publishedAt).not.toBeNull();
  });

  it('records a failure with backoff, renews a live lease, and purges only published rows', async () => {
    const a = org();
    await asAdmin(a, () => w.projects.create(PROJECT));
    await asAdmin(a, () => w.projects.create({ ...PROJECT, title: 'Second' }));

    const claim = await store.claimPending({ limit: 500, owner: 'test', leaseSeconds: 60 });
    const token = claim.token as string;
    const mine = claim.rows.filter((row) => row.organizationId === a).map((row) => row.id);
    const others = claim.rows.filter((row) => row.organizationId !== a).map((row) => row.id);
    expect(mine).toHaveLength(2);
    expect(await store.activeLeaseCount()).toBeGreaterThanOrEqual(2);

    const renewed = await store.renew(mine, token, 60, 5_000);
    expect([...renewed].sort()).toEqual([...mine].sort());

    const [failed, published] = mine as [string, string];
    expect(
      await store.markFailed(failed, token, 'broker down', { baseSeconds: 5, maxSeconds: 60 }),
    ).toBe(1);
    expect(await store.markPublished([published], token)).toBe(1);
    if (others.length > 0) await store.release(others, token);

    const rows = await outboxFor(w.prisma, a);
    const failedRow = rows.find((row) => row.id === failed)!;
    expect(failedRow).toMatchObject({ attempts: 1, lastError: 'broker down', publishedAt: null });
    expect(failedRow.nextAttemptAt).not.toBeNull();
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(1);
    expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(0);

    // Nothing published is older than the retention window yet, so nothing goes.
    const before = (await outboxFor(w.prisma, a)).length;
    await store.purgePublished(7);
    expect(await outboxFor(w.prisma, a)).toHaveLength(before);
    // With a zero-day window the published row goes and the failed one stays.
    await store.purgePublished(0);
    expect((await outboxFor(w.prisma, a)).map((row) => row.id)).toEqual([failed]);
  });
});
