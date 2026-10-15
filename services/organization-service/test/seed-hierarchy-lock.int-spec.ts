import { RastaError } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { OrganizationRepository, toLabel } from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { OrganizationView } from '../src/organization/dto';
import { seedOrganization, type SeedOrganizationRow } from '../src/organization/seed-organization';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma } from './helpers';

/**
 * The demo seed writes an organization under the hierarchy lock, row and path in one transaction
 * (Codex on #286).
 *
 * It used to commit a new ACTIVE row with a NULL path and set the path in a second statement. A
 * suspension of the parent committing in between cascaded over `path <@ parent`, which NULL never
 * matches, and the child stayed ACTIVE beneath a SUSPENDED parent.
 *
 * Every interleaving is forced, not raced: one writer is held at a barrier inside its transaction
 * — the seed between its insert and its path, the old window; a suspension between its
 * compare-and-set and its cascade; a move before its path rewrite — the other is let run until
 * PostgreSQL reports it waiting on a lock (or until it finishes, which is the failure the
 * assertions then report), and only then is the barrier released.
 */
describe('the demo seed takes the hierarchy lock', () => {
  let prisma: PrismaService;
  let repository: OrganizationRepository;

  const OPERATOR_ORG = 'ORG-ITEST-OPERATOR';

  const serviceWith = (repo: OrganizationRepository = repository) =>
    new OrganizationService(repo, { maxDepth: 8, policySetterRoles: ['SYSTEM_ADMIN'] });

  const operator = <T>(fn: () => Promise<T>): Promise<T> =>
    asActor({ organizationId: OPERATOR_ORG, roles: ['SYSTEM_ADMIN'] }, fn);

  let counter = 0;
  const create = (parentId?: string): Promise<OrganizationView> =>
    operator(() =>
      serviceWith().create({
        name: `سازمان بذر ${++counter}`,
        type: 'GOVERNMENT',
        metadata: {},
        ...(parentId ? { parentId } : {}),
      } as never),
    );

  /** A seed row with a fresh fixed identifier, the shape `prisma/seed.ts` declares. */
  const seedRow = (parentId: string | null): SeedOrganizationRow => ({
    id: `ORG-ITEST-SEED-${ulid().slice(-10)}`,
    name: 'دهیاری بذر',
    type: 'DEHYARI',
    parentId,
    metadata: { households: 1 },
  });

  const row = (id: string) => prisma.client.organization.findUnique({ where: { id } });

  const errorOf = async (promise: Promise<unknown>): Promise<RastaError> => {
    const outcome = await promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(RastaError);
    return outcome as RastaError;
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Holds `method` of a fresh repository at a barrier: `reached` resolves when a call arrives,
   * and the call goes on only after `release()`.
   */
  const gated = <K extends 'setPath' | 'cascadeStatus' | 'rewriteSubtreePath'>(method: K) => {
    const repo = new OrganizationRepository(prisma);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    const original = (repo[method] as (...args: unknown[]) => Promise<unknown>).bind(repo);
    (repo as unknown as Record<K, unknown>)[method] = async (...args: unknown[]) => {
      arrive();
      await gate;
      return original(...args);
    };
    return { repo, reached, release };
  };

  /**
   * Resolves once another backend of this database waits on a lock, or once `writer` has
   * settled — without waiting, which is the race the barrier was set up to expose.
   */
  const untilBlockedOrSettled = async (writer: Promise<unknown>, timeoutMs = 10_000) => {
    let settled = false;
    void writer.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (settled) return 'settled';
      const waiting = await prisma.client.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      if (waiting.length > 0) return 'blocked';
      await sleep(25);
    }
    throw new Error('the second writer neither blocked nor finished');
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    repository = new OrganizationRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  it('a suspension of the parent while the seed writes the child waits, then cascades over it', async () => {
    const root = await create();
    const parent = await create(root.id);
    const child = seedRow(parent.id);

    // Held after the insert, before the path: the window the old two-statement write left open.
    const seed = gated('setPath');
    const seeding = seedOrganization(seed.repo, child);
    seeding.catch(() => undefined);
    await seed.reached;
    const visibleWhileHeld = await row(child.id);

    const suspension = operator(() =>
      serviceWith().changeStatus(parent.id, { status: 'SUSPENDED', reason: 'seed race' }),
    );
    suspension.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(suspension);
    } finally {
      seed.release();
    }

    const outcomes = await Promise.allSettled([seeding, suspension]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    // Never ACTIVE beneath the SUSPENDED parent.
    const seeded = await row(child.id);
    expect(seeded?.status).toBe('SUSPENDED');
    expect(seeded?.depth).toBe(2);
    expect(await repository.getPath(child.id)).toBe(
      [root.id, parent.id, child.id].map(toLabel).join('.'),
    );
    expect(second).toBe('blocked');
    // Nobody saw the row before it had its path: insert and path commit together.
    expect(visibleWhileHeld).toBeNull();
  });

  it('a seed of a child while its parent is being suspended waits, then refuses it', async () => {
    const root = await create();
    const parent = await create(root.id);
    const child = seedRow(parent.id);

    // Held after its compare-and-set, before its cascade: the parent is SUSPENDED, uncommitted.
    const held = gated('cascadeStatus');
    const suspension = operator(() =>
      serviceWith(held.repo).changeStatus(parent.id, { status: 'SUSPENDED', reason: 'seed race' }),
    );
    suspension.catch(() => undefined);
    await held.reached;

    const seeding = seedOrganization(repository, child);
    seeding.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(seeding);
    } finally {
      held.release();
    }

    await suspension;
    const error = await errorOf(seeding);
    expect(second).toBe('blocked');
    expect(error.internalContext).toMatchObject({
      rule: 'ANCESTOR_NOT_ACTIVE',
      ancestorId: parent.id,
    });
    expect(await row(child.id)).toBeNull();
    expect((await row(parent.id))?.status).toBe('SUSPENDED');
  });

  it('a seed of a child while its parent is being moved places it at the parent’s new path', async () => {
    const from = await create();
    const to = await create();
    const parent = await create(from.id);
    const child = seedRow(parent.id);

    // Held under the hierarchy lock, with the parent locked, before its path rewrite.
    const held = gated('rewriteSubtreePath');
    const move = operator(() =>
      serviceWith(held.repo).move(parent.id, { parentId: to.id, reason: 'seed race' }),
    );
    move.catch(() => undefined);
    await held.reached;

    const seeding = seedOrganization(repository, child);
    seeding.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(seeding);
    } finally {
      held.release();
    }

    const outcomes = await Promise.allSettled([move, seeding]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(second).toBe('blocked');
    expect(await repository.getPath(child.id)).toBe(
      [to.id, parent.id, child.id].map(toLabel).join('.'),
    );
    expect((await row(child.id))?.depth).toBe(2);
  });

  it('a second run converges the name, and keeps the path and a cascaded status', async () => {
    const root = await create();
    const parent = await create(root.id);
    const child = seedRow(parent.id);
    const first = await seedOrganization(repository, child);

    await operator(() =>
      serviceWith().changeStatus(parent.id, { status: 'SUSPENDED', reason: 'stopped' }),
    );
    expect((await row(child.id))?.status).toBe('SUSPENDED');

    // A re-seed of a development database after an operator suspended a branch is not refused:
    // nothing is created ACTIVE, and the existing row keeps the status the cascade gave it.
    const second = await seedOrganization(repository, { ...child, name: 'دهیاری بذر دوم' });
    expect(second).toEqual(first);
    const after = await row(child.id);
    expect(after?.name).toBe('دهیاری بذر دوم');
    expect(after?.status).toBe('SUSPENDED');
  });

  it('a row an older seed left without a path is placed beneath an active parent, and refused beneath a suspended one', async () => {
    const root = await create();
    const active = await create(root.id);
    const stopped = await create(root.id);
    await operator(() =>
      serviceWith().changeStatus(stopped.id, { status: 'SUSPENDED', reason: 'stopped' }),
    );

    // The old seed's first statement, committed alone: ACTIVE, path NULL.
    const unplaced = async (parentId: string) => {
      const orphan = seedRow(parentId);
      await prisma.client.organization.create({
        data: {
          id: orphan.id,
          name: orphan.name,
          type: orphan.type,
          status: 'ACTIVE',
          parentId,
          depth: 2,
          createdBy: 'SEED',
          updatedBy: 'SEED',
        },
      });
      expect(await repository.getPath(orphan.id)).toBeNull();
      return orphan;
    };

    const underActive = await unplaced(active.id);
    await seedOrganization(repository, underActive);
    expect(await repository.getPath(underActive.id)).toBe(
      [root.id, active.id, underActive.id].map(toLabel).join('.'),
    );

    const underStopped = await unplaced(stopped.id);
    const error = await errorOf(seedOrganization(repository, underStopped));
    expect(error.internalContext).toMatchObject({
      rule: 'ANCESTOR_NOT_ACTIVE',
      ancestorId: stopped.id,
    });
    expect(await repository.getPath(underStopped.id)).toBeNull();

    // Leaves no ACTIVE row beneath the suspended parent for a later suite to trip over.
    await prisma.client.organization.update({
      where: { id: underStopped.id },
      data: { status: 'SUSPENDED' },
    });
  });
});
