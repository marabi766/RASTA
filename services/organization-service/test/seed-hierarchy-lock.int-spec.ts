import { RastaError } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { OrganizationRepository, toLabel } from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { OrganizationView } from '../src/organization/dto';
import { seedOrganization, type SeedOrganizationRow } from '../src/organization/seed-organization';
import type { PrismaService, PrismaTransactionClient } from '../src/prisma/prisma.service';
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
 * PostgreSQL reports its own backend waiting on the held writer's (or until it finishes, which is
 * the failure the assertions then report), and only then is the barrier released. Both backends
 * are the writers' own, read from their transactions: no other session of the database can
 * release the barrier early (Codex r1 on #295).
 *
 * The seed also places a row only within the depth limit, read under the same lock (Codex r1 on
 * #295): a move that deepened the parent meanwhile cannot leave its child over the limit.
 */
describe('the demo seed takes the hierarchy lock', () => {
  let prisma: PrismaService;
  let repository: OrganizationRepository;

  const OPERATOR_ORG = 'ORG-ITEST-OPERATOR';
  const MAX_DEPTH = 8;

  const serviceWith = (repo: OrganizationRepository = repository, maxDepth = MAX_DEPTH) =>
    new OrganizationService(repo, { maxDepth, policySetterRoles: ['SYSTEM_ADMIN'] });

  const runSeed = (repo: OrganizationRepository, org: SeedOrganizationRow, maxDepth = MAX_DEPTH) =>
    seedOrganization(repo, org, { maxDepth });

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

  /** The backend a transaction runs on, read from that transaction's own connection. */
  const backendOf = async (tx: PrismaTransactionClient): Promise<number> => {
    const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    return pid;
  };

  /**
   * Holds `method` of a fresh repository at a barrier: `reached` resolves, with the backend of
   * the held transaction, when a call arrives, and the call goes on only after `release()`.
   */
  const gated = <K extends 'setPath' | 'cascadeStatus' | 'rewriteSubtreePath'>(method: K) => {
    const repo = new OrganizationRepository(prisma);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrive!: (backend: number) => void;
    const reached = new Promise<number>((resolve) => (arrive = resolve));
    const original = (repo[method] as (...args: unknown[]) => Promise<unknown>).bind(repo);
    (repo as unknown as Record<K, unknown>)[method] = async (...args: unknown[]) => {
      arrive(await backendOf(args[0] as PrismaTransactionClient));
      await gate;
      return original(...args);
    };
    return { repo, reached, release };
  };

  /**
   * A fresh repository that records the backend of its write transaction as the transaction
   * begins, before the writer asks for any lock: the backend the tested writer waits on.
   */
  const traced = () => {
    const repo = new OrganizationRepository(prisma);
    let backend: number | undefined;
    const original = repo.transaction.bind(repo);
    repo.transaction = <T>(fn: (tx: PrismaTransactionClient) => Promise<T>) =>
      original(async (tx) => {
        backend = await backendOf(tx);
        return fn(tx);
      });
    return { repo, backend: () => backend };
  };

  /**
   * Resolves once the tested writer's own backend waits on a lock the held writer's backend holds
   * — `pg_blocking_pids` of the one names the other — or once `writer` has settled without
   * waiting, which is the race the barrier was set up to expose. Any other session waiting on a
   * lock is not either of them, and releases nothing.
   */
  const untilBlockedOrSettled = async (
    writer: Promise<unknown>,
    waiter: () => number | undefined,
    holder: number,
    timeoutMs = 10_000,
  ) => {
    let settled = false;
    void writer.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (settled) return 'settled';
      const backend = waiter();
      if (backend !== undefined) {
        const [{ blockers }] = await prisma.client.$queryRaw<{ blockers: number[] }[]>`
          SELECT pg_blocking_pids(${backend}::int) AS blockers
        `;
        if (blockers.includes(holder)) return 'blocked';
      }
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
    const seeding = runSeed(seed.repo, child);
    seeding.catch(() => undefined);
    const holder = await seed.reached;
    const visibleWhileHeld = await row(child.id);

    const suspender = traced();
    const suspension = operator(() =>
      serviceWith(suspender.repo).changeStatus(parent.id, {
        status: 'SUSPENDED',
        reason: 'seed race',
      }),
    );
    suspension.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(suspension, suspender.backend, holder);
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
    const holder = await held.reached;

    const seeder = traced();
    const seeding = runSeed(seeder.repo, child);
    seeding.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(seeding, seeder.backend, holder);
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
    const holder = await held.reached;

    const seeder = traced();
    const seeding = runSeed(seeder.repo, child);
    seeding.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(seeding, seeder.backend, holder);
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

  it('a seed is held to the depth limit by the rule the service applies', async () => {
    const root = await create();
    const mid = await create(root.id);
    const deep = await create(mid.id);

    // At the limit: placed, like a create.
    const atLimit = seedRow(mid.id);
    expect(await runSeed(repository, atLimit, 2)).toMatchObject({ depth: 2 });

    // One past it: refused with exactly the refusal `create` gives, and nothing written.
    const tooDeep = seedRow(deep.id);
    const seedError = await errorOf(runSeed(repository, tooDeep, 2));
    const createError = await errorOf(
      operator(() =>
        serviceWith(repository, 2).create({
          name: 'سازمان بیش از حد ژرف',
          type: 'GOVERNMENT',
          metadata: {},
          parentId: deep.id,
        } as never),
      ),
    );
    expect(seedError.internalContext).toEqual(createError.internalContext);
    expect(seedError.internalContext).toMatchObject({
      rule: 'HIERARCHY_TOO_DEEP',
      maxDepth: 2,
      resultingDepth: 3,
      parentDepth: 2,
    });
    expect(await row(tooDeep.id)).toBeNull();
  });

  it('a seed of a child while a move deepens its parent to the limit waits, then refuses it', async () => {
    const from = await create();
    const to = await create();
    const mid = await create(to.id);
    const parent = await create(from.id);
    const child = seedRow(parent.id);

    // The move is legal (the parent lands at depth 2, the limit); the child would be at 3.
    const held = gated('rewriteSubtreePath');
    const move = operator(() =>
      serviceWith(held.repo, 2).move(parent.id, { parentId: mid.id, reason: 'seed race' }),
    );
    move.catch(() => undefined);
    const holder = await held.reached;

    const seeder = traced();
    const seeding = runSeed(seeder.repo, child, 2);
    seeding.catch(() => undefined);
    let second: string;
    try {
      second = await untilBlockedOrSettled(seeding, seeder.backend, holder);
    } finally {
      held.release();
    }

    await move;
    const error = await errorOf(seeding);
    expect(second).toBe('blocked');
    expect(error.internalContext).toMatchObject({
      rule: 'HIERARCHY_TOO_DEEP',
      maxDepth: 2,
      resultingDepth: 3,
      parentDepth: 2,
    });
    expect(await row(child.id)).toBeNull();
    expect((await row(parent.id))?.depth).toBe(2);
  });

  it('a second run converges the name, and keeps the path and a cascaded status', async () => {
    const root = await create();
    const parent = await create(root.id);
    const child = seedRow(parent.id);
    const first = await runSeed(repository, child);

    await operator(() =>
      serviceWith().changeStatus(parent.id, { status: 'SUSPENDED', reason: 'stopped' }),
    );
    expect((await row(child.id))?.status).toBe('SUSPENDED');

    // A re-seed of a development database after an operator suspended a branch is not refused:
    // nothing is created ACTIVE, and the existing row keeps the status the cascade gave it.
    const second = await runSeed(repository, { ...child, name: 'دهیاری بذر دوم' });
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
    await runSeed(repository, underActive);
    expect(await repository.getPath(underActive.id)).toBe(
      [root.id, active.id, underActive.id].map(toLabel).join('.'),
    );

    const underStopped = await unplaced(stopped.id);
    const error = await errorOf(runSeed(repository, underStopped));
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
