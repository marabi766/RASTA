import { OrganizationRepository, toLabel } from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { OrganizationView } from '../src/organization/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma } from './helpers';

/**
 * A move and a cascading status change must take row locks in one order.
 *
 * `move(M)` rewrites the paths of M's whole subtree in one UPDATE, which locks
 * rows in whatever order the scan visits them. `changeStatus(D, SUSPENDED)`
 * locks D by compare-and-set and then locks D's descendants. With D beneath M
 * and E beneath D, a scan that reaches E before D gives the cycle
 *
 *   move: holds E, waits D          suspension: holds D, waits E
 *
 * which PostgreSQL resolves by aborting one of two valid requests (40P01).
 *
 * The interleaving is forced, not raced: the suspension is held between its
 * compare-and-set and its cascade, the move is let run until PostgreSQL reports
 * it blocked on a lock, and only then is the suspension released. The one thing
 * the test cannot dictate is the scan order inside the move's UPDATE, so it
 * arranges the heap (some child E physically before D) and asserts that it did.
 */
describe('hierarchy-changing writes take row locks in one order', () => {
  let prisma: PrismaService;
  let repository: OrganizationRepository;

  const OPERATOR_ORG = 'ORG-ITEST-OPERATOR';

  const serviceWith = (repo: OrganizationRepository = repository) =>
    new OrganizationService(repo, { maxDepth: 8, policySetterRoles: ['SYSTEM_ADMIN'] });

  const operator = <T>(fn: () => Promise<T>): Promise<T> =>
    asActor({ organizationId: OPERATOR_ORG, roles: ['SYSTEM_ADMIN'] }, fn);

  let counter = 0;
  const create = (service: OrganizationService, parentId?: string): Promise<OrganizationView> =>
    operator(() =>
      service.create({
        name: `سازمان ترتیب قفل ${++counter}`,
        type: 'DEHYARI',
        metadata: {},
        ...(parentId ? { parentId } : {}),
      } as never),
    );

  const row = (id: string) => prisma.client.organization.findFirstOrThrow({ where: { id } });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Position of a row in the heap, as [page, line pointer]. */
  const heapPosition = async (id: string): Promise<[number, number]> => {
    const rows = await prisma.client.$queryRaw<{ ctid: string }[]>`
      SELECT ctid::text AS ctid FROM organization WHERE id = ${id}
    `;
    const match = /\((\d+),(\d+)\)/.exec(rows[0]?.ctid ?? '');
    if (!match) throw new Error(`no ctid for ${id}`);
    return [Number(match[1]), Number(match[2])];
  };

  const isBefore = (a: [number, number], b: [number, number]) =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  /**
   * Rewrites `later` until its current tuple sits after at least one of
   * `earlier`. An UPDATE writes a new tuple version; a sequential scan visits
   * tuples in heap order. One child ahead of D is all the cycle needs: the move
   * locks it, then waits on D.
   */
  const placeAfterSome = async (earlier: string[], later: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const position = await heapPosition(later);
      const positions = await Promise.all(earlier.map(heapPosition));
      if (positions.some((candidate) => isBefore(candidate, position))) return true;
      await prisma.client
        .$executeRaw`UPDATE organization SET updated_by = updated_by WHERE id = ${later}`;
    }
    return false;
  };

  /**
   * Resolves once PostgreSQL reports a backend blocked on a lock in a statement
   * of the hierarchy writers: the move's path rewrite, or its advisory lock.
   */
  const untilWriterBlocked = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await prisma.client.$queryRaw<{ query: string }[]>`
        SELECT query FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query LIKE '%UPDATE organization%SET path%' OR query LIKE '%pg_advisory_xact_lock%')
      `;
      if (waiting.length > 0) return;
      await sleep(25);
    }
    throw new Error('the move never blocked on a lock');
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

  /**
   * M ─ D ─ {E1..E12}, and a separate root P to move M beneath. The suspension of D is
   * held after its compare-and-set; the move runs until it is blocked; then the
   * suspension is released and both are awaited.
   */
  const interleave = async () => {
    const setup = serviceWith();
    const p = await create(setup);

    // Several children: which of them the scan reaches first is not ours to
    // choose, but one of them ahead of D is enough. Where free space puts D
    // before every child, build the subtree again from fresh rows.
    const build = async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const m = await create(setup);
        const d = await create(setup, m.id);
        const children: OrganizationView[] = [];
        for (let i = 0; i < 12; i += 1) children.push(await create(setup, d.id));
        if (
          await placeAfterSome(
            children.map((child) => child.id),
            d.id,
          )
        ) {
          return { m, d, children };
        }
      }
      throw new Error('could not place D after any of its children in the heap');
    };
    const { m, d, children } = await build();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedCascade!: () => void;
    const suspended = new Promise<void>((resolve) => (reachedCascade = resolve));

    const gated = new OrganizationRepository(prisma);
    const cascade = gated.cascadeStatus.bind(gated);
    gated.cascadeStatus = async (...args: Parameters<typeof cascade>) => {
      reachedCascade();
      await gate;
      return cascade(...args);
    };

    const suspension = operator(() =>
      serviceWith(gated).changeStatus(d.id, { status: 'SUSPENDED', reason: 'lock order' }),
    );
    suspension.catch(() => undefined);
    // Reached the cascade: whatever the suspension locks before it, it holds now.
    await suspended;

    const move = operator(() => serviceWith().move(m.id, { parentId: p.id, reason: 'lock order' }));
    move.catch(() => undefined);
    try {
      await untilWriterBlocked();
    } finally {
      release();
    }

    const outcomes = await Promise.allSettled([suspension, move]);
    return { p, m, d, children, outcomes };
  };

  it('a move and a cascading suspension that overlap both commit; neither is aborted', async () => {
    const { p, m, d, children, outcomes } = await interleave();

    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome) => outcome.reason as { code?: string; meta?: unknown; message?: string });
    // 40P01 is PostgreSQL's deadlock_detected.
    expect(failures.map((failure) => JSON.stringify(failure.meta ?? failure.message))).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    // Whichever order they were serialised in, the result is one coherent tree.
    const dPath = [p, m, d].map((org) => toLabel(org.id)).join('.');
    expect(await repository.getPath(m.id)).toBe(`${toLabel(p.id)}.${toLabel(m.id)}`);
    expect(await repository.getPath(d.id)).toBe(dPath);
    expect((await row(m.id)).parentId).toBe(p.id);
    expect((await row(m.id)).status).toBe('ACTIVE');
    expect((await row(d.id)).status).toBe('SUSPENDED');
    for (const child of children) {
      expect(await repository.getPath(child.id)).toBe(`${dPath}.${toLabel(child.id)}`);
      expect((await row(child.id)).status).toBe('SUSPENDED');
    }
  });
});
