import { RastaError } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  HIERARCHY_LOCK_KEY,
  OrganizationRepository,
  toLabel,
} from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { OrganizationView } from '../src/organization/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma } from './helpers';

/**
 * Hierarchy integrity against a real PostgreSQL: the checks whose failure
 * modes are concurrency, lock order and SQL, which a stubbed repository
 * cannot show.
 *
 * Every test builds its own tree under a fresh root, so nothing depends on
 * seed data, on test order or on rows another run left behind.
 */
describe('organization hierarchy integrity', () => {
  let prisma: PrismaService;
  let repository: OrganizationRepository;

  const OPERATOR_ORG = 'ORG-ITEST-OPERATOR';
  const POLICY_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'];

  const serviceWith = (maxDepth = 8, repo: OrganizationRepository = repository) =>
    new OrganizationService(repo, { maxDepth, policySetterRoles: POLICY_ROLES });

  const operator = <T>(fn: () => Promise<T>): Promise<T> =>
    asActor({ organizationId: OPERATOR_ORG, roles: ['SYSTEM_ADMIN'] }, fn);

  const adminOf = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
    asActor({ organizationId, roles: ['ORGANIZATION_ADMIN'] }, fn);

  let counter = 0;
  const create = (
    service: OrganizationService,
    parentId?: string,
    location?: { latitude: number; longitude: number },
  ): Promise<OrganizationView> =>
    operator(() =>
      service.create({
        name: `سازمان آزمون ${++counter}`,
        type: 'DEHYARI',
        metadata: {},
        ...(parentId ? { parentId } : {}),
        ...(location ? { location: { kind: 'PRIMARY', coordinate: location } } : {}),
      } as never),
    );

  const row = (id: string) => prisma.client.organization.findFirstOrThrow({ where: { id } });

  const pathOf = async (id: string) => repository.getPath(id);

  const errorOf = async (promise: Promise<unknown>): Promise<RastaError> => {
    const outcome = await promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(RastaError);
    return outcome as RastaError;
  };

  /** Resolves after `ms`; used only to observe that something is still blocked. */
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Holds a transaction open until `release()` is called. `body` runs first
   * inside it — typically a status change or a lock the test wants others to
   * queue behind.
   */
  const holdTransaction = async (
    body: (tx: Parameters<Parameters<PrismaService['transaction']>[0]>[0]) => Promise<void>,
  ) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const done = prisma.client.$transaction(
      async (tx) => {
        await body(tx);
        ready();
        await released;
      },
      { timeout: 20_000 },
    );
    await isReady;
    return { release, done };
  };

  /** Tracks whether a promise has settled, without awaiting it. */
  const track = <T>(promise: Promise<T>) => {
    const state = { settled: false };
    const settled = promise.finally(() => (state.settled = true));
    settled.catch(() => undefined);
    return { state, promise: settled };
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    // Warm the engine outside any interactive transaction's 5s budget.
    await prisma.client.$queryRawUnsafe('SELECT 1');
    repository = new OrganizationRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // =========================================================================
  // (a) nearby — tenant isolation
  // =========================================================================

  describe('GET /nearby is scoped to the visible subtree', () => {
    // A coordinate unique to this run, so rows other runs left nearby do not
    // enter the result.
    const here = {
      latitude: 26 + Math.random() * 8,
      longitude: 46 + Math.random() * 12,
    };
    const near = (metres: number) => ({
      latitude: here.latitude + metres / 111_000,
      longitude: here.longitude,
    });
    const query = { ...here, radiusMeters: 2_000, limit: 100 };

    let root: OrganizationView;
    let tenantA: OrganizationView;
    let tenantAChild: OrganizationView;
    let tenantB: OrganizationView;

    beforeAll(async () => {
      const service = serviceWith();
      root = await create(service, undefined, near(10));
      tenantA = await create(service, root.id, near(20));
      tenantAChild = await create(service, tenantA.id, near(30));
      tenantB = await create(service, root.id, near(40));
    });

    const idsFor = async (fn: () => Promise<Array<{ id: string }>>) =>
      new Set((await fn()).map((result) => result.id));

    it('tenant A sees its own subtree and nothing of tenant B', async () => {
      const service = serviceWith();
      const ids = await idsFor(() => adminOf(tenantA.id, () => service.nearby(query)));

      expect(ids).toEqual(new Set([tenantA.id, tenantAChild.id]));
      expect(ids.has(tenantB.id)).toBe(false);
      // Nor its own parent: visibility flows downward only.
      expect(ids.has(root.id)).toBe(false);
    });

    it('tenant B sees only itself', async () => {
      const service = serviceWith();
      const ids = await idsFor(() => adminOf(tenantB.id, () => service.nearby(query)));

      expect(ids).toEqual(new Set([tenantB.id]));
    });

    it('a leaf sees only itself', async () => {
      const service = serviceWith();
      const ids = await idsFor(() => adminOf(tenantAChild.id, () => service.nearby(query)));

      expect(ids).toEqual(new Set([tenantAChild.id]));
    });

    it('a platform operator sees the whole tree', async () => {
      const service = serviceWith();
      const ids = await idsFor(() => operator(() => service.nearby(query)));

      expect(ids).toEqual(new Set([root.id, tenantA.id, tenantAChild.id, tenantB.id]));
    });

    it('the limit applies after the subtree filter, not before it', async () => {
      // Tenant B's row is the farthest; with limit 1 tenant A must still get
      // its own nearest row, not an empty page after filtering someone else's.
      const service = serviceWith();
      const results = await adminOf(tenantA.id, () => service.nearby({ ...query, limit: 1 }));

      expect(results.map((result) => result.id)).toEqual([tenantA.id]);
    });
  });

  // =========================================================================
  // (b) move — depth of the deepest descendant, and cycles under concurrency
  // =========================================================================

  describe('move enforces maxDepth for the whole moved subtree', () => {
    it('refuses a move that pushes a descendant past the limit, and changes nothing', async () => {
      const service = serviceWith(3);
      const moving = await create(service); // depth 0
      const movingChild = await create(service, moving.id); // depth 1
      const target = await create(service); // 0
      const targetChild = await create(service, target.id); // 1
      const targetGrandchild = await create(service, targetChild.id); // 2

      const before = await pathOf(movingChild.id);

      // `moving` would land at 3 — within the limit — but its child at 4.
      const error = await errorOf(
        operator(() => service.move(moving.id, { parentId: targetGrandchild.id, reason: 'deep' })),
      );

      expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(error.internalContext).toMatchObject({
        rule: 'HIERARCHY_TOO_DEEP',
        resultingDepth: 4,
      });
      expect(await pathOf(movingChild.id)).toBe(before);
      expect((await row(moving.id)).parentId).toBeNull();
    });

    it('allows the same subtree where its deepest node lands exactly at the limit', async () => {
      const service = serviceWith(3);
      const moving = await create(service);
      const movingChild = await create(service, moving.id);
      const target = await create(service);
      const targetChild = await create(service, target.id);

      await operator(() => service.move(moving.id, { parentId: targetChild.id, reason: 'fits' }));

      expect((await row(movingChild.id)).depth).toBe(3);
      expect(await pathOf(movingChild.id)).toBe(
        [target.id, targetChild.id, moving.id, movingChild.id].map(toLabel).join('.'),
      );
    });
  });

  describe('move cannot create a cycle, even concurrently', () => {
    /** Walks `parentId` upwards; throws if it does not reach a root. */
    const assertAcyclic = async (ids: string[]) => {
      for (const id of ids) {
        const seen = new Set<string>();
        let current: string | null = id;
        while (current) {
          if (seen.has(current)) throw new Error(`cycle through ${current}`);
          seen.add(current);
          current = (await row(current)).parentId;
        }
        // The derived path must agree with the parentId chain it indexes.
        const organization = await row(id);
        const expected = organization.parentId
          ? `${await pathOf(organization.parentId)}.${toLabel(id)}`
          : toLabel(id);
        expect(await pathOf(id)).toBe(expected);
      }
    };

    it.each([1, 2, 3, 4, 5])(
      'opposite concurrent moves: exactly one succeeds (round %i)',
      async () => {
        // A beneath a child of B, while B moves beneath a child of A. Checked
        // one at a time against the tree as it was, both pass — and together
        // they detach A and B into a ring.
        const service = serviceWith();
        const root = await create(service);
        const a = await create(service, root.id);
        const b = await create(service, root.id);
        const aChild = await create(service, a.id);
        const bChild = await create(service, b.id);

        const outcomes = await Promise.allSettled([
          operator(() => service.move(a.id, { parentId: bChild.id, reason: 'race one' })),
          operator(() => service.move(b.id, { parentId: aChild.id, reason: 'race two' })),
        ]);

        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0]?.reason as RastaError).internalContext).toMatchObject({
          rule: 'CYCLE_DETECTED',
        });

        await assertAcyclic([a.id, b.id, aChild.id, bChild.id]);
      },
    );

    it('a move waits for the hierarchy lock held by another structural write', async () => {
      const service = serviceWith();
      const root = await create(service);
      const moving = await create(service);

      const holder = await holdTransaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_KEY}::bigint)`;
      });

      const move = track(
        operator(() => service.move(moving.id, { parentId: root.id, reason: 'queued' })),
      );
      await pause(500);
      expect(move.state.settled).toBe(false);

      holder.release();
      await holder.done;
      await move.promise;
      expect((await row(moving.id)).parentId).toBe(root.id);
    });
  });

  // =========================================================================
  // (c) L3-06 — nothing ACTIVE beneath a stopped ancestor
  // =========================================================================

  describe('no ACTIVE organization beneath a suspended or deactivated ancestor', () => {
    it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
      'refuses to create beneath a %s parent',
      async (status) => {
        const service = serviceWith();
        const root = await create(service);
        const parent = await create(service, root.id);
        await operator(() => service.changeStatus(parent.id, { status, reason: 'stopped' }));

        const childrenBefore = await prisma.client.organization.count({
          where: { parentId: parent.id },
        });
        const error = await errorOf(create(service, parent.id));

        expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(error.internalContext).toMatchObject({
          rule: 'ANCESTOR_NOT_ACTIVE',
          ancestorId: parent.id,
        });
        expect(await prisma.client.organization.count({ where: { parentId: parent.id } })).toBe(
          childrenBefore,
        );
      },
    );

    it('refuses to create beneath an active parent whose grandparent is suspended', async () => {
      // Only reachable if the parent was reactivated around the cascade — the
      // hole (c) closes — so the state is built directly.
      const service = serviceWith();
      const grandparent = await create(service);
      const parent = await create(service, grandparent.id);
      await prisma.client.organization.update({
        where: { id: grandparent.id },
        data: { status: 'SUSPENDED' },
      });

      const error = await errorOf(create(service, parent.id));
      expect(error.internalContext).toMatchObject({ ancestorId: grandparent.id });
    });

    it('refuses to reactivate beneath a suspended ancestor', async () => {
      const service = serviceWith();
      const root = await create(service);
      const parent = await create(service, root.id);
      const child = await create(service, parent.id);
      await operator(() => service.changeStatus(parent.id, { status: 'SUSPENDED', reason: 'x' }));
      expect((await row(child.id)).status).toBe('SUSPENDED');

      const error = await errorOf(
        operator(() => service.changeStatus(child.id, { status: 'ACTIVE', reason: 'try' })),
      );

      expect(error.internalContext).toMatchObject({ rule: 'ANCESTOR_NOT_ACTIVE' });
      expect((await row(child.id)).status).toBe('SUSPENDED');
    });

    it('a create racing an uncommitted suspension of its parent waits, then refuses', async () => {
      const service = serviceWith();
      const root = await create(service);
      const parent = await create(service, root.id);

      // The suspension has written but not committed. Without a lock on the
      // parent, the create would read ACTIVE and commit a child the cascade
      // never saw.
      const suspension = await holdTransaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE organization SET status = 'SUSPENDED' WHERE id = ${parent.id}
        `;
      });

      const creating = track(create(service, parent.id));
      await pause(500);
      expect(creating.state.settled).toBe(false);

      suspension.release();
      await suspension.done;

      const error = await errorOf(creating.promise);
      expect(error.internalContext).toMatchObject({
        rule: 'ANCESTOR_NOT_ACTIVE',
        ancestorId: parent.id,
      });
    });

    it('a reactivation racing an uncommitted suspension of an ancestor waits, then refuses', async () => {
      const service = serviceWith();
      const root = await create(service);
      const parent = await create(service, root.id);
      const child = await create(service, parent.id);
      await operator(() => service.changeStatus(child.id, { status: 'SUSPENDED', reason: 'own' }));

      const suspension = await holdTransaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE organization SET status = 'SUSPENDED' WHERE id = ${root.id}
        `;
      });

      const reactivating = track(
        operator(() => service.changeStatus(child.id, { status: 'ACTIVE', reason: 'cleared' })),
      );
      await pause(500);
      expect(reactivating.state.settled).toBe(false);

      suspension.release();
      await suspension.done;

      const error = await errorOf(reactivating.promise);
      expect(error.internalContext).toMatchObject({ ancestorId: root.id });
      expect((await row(child.id)).status).toBe('SUSPENDED');
    });

    it('concurrent creates and a suspension never leave an ACTIVE child beneath it', async () => {
      const service = serviceWith();
      const root = await create(service);
      const parent = await create(service, root.id);

      await Promise.allSettled([
        create(service, parent.id),
        create(service, parent.id),
        operator(() => service.changeStatus(parent.id, { status: 'SUSPENDED', reason: 'race' })),
        create(service, parent.id),
        create(service, parent.id),
      ]);

      expect((await row(parent.id)).status).toBe('SUSPENDED');
      const active = await prisma.client.organization.count({
        where: { parentId: parent.id, status: 'ACTIVE' },
      });
      expect(active).toBe(0);
    });

    it('refuses to move an active subtree beneath a suspended organization', async () => {
      const service = serviceWith();
      const stopped = await create(service);
      const moving = await create(service);
      await operator(() => service.changeStatus(stopped.id, { status: 'SUSPENDED', reason: 'x' }));

      const error = await errorOf(
        operator(() => service.move(moving.id, { parentId: stopped.id, reason: 'hide it' })),
      );

      expect(error.internalContext).toMatchObject({ rule: 'ANCESTOR_NOT_ACTIVE' });
      expect((await row(moving.id)).parentId).toBeNull();
    });
  });

  // =========================================================================
  // (d) L3-07 — compare-and-set on status
  // =========================================================================

  describe('status changes are compare-and-set', () => {
    it('a write computed from a stale read fails with a conflict and revives nothing', async () => {
      const service = serviceWith();
      const organization = await create(service);
      await operator(() =>
        service.changeStatus(organization.id, { status: 'DEACTIVATED', reason: 'closed' }),
      );

      // A repository whose read is one step behind the database: the request
      // decided from SUSPENDED, but the row is DEACTIVATED by the time it
      // writes. Before the fix, the update matched on id alone and revived it.
      const stale = new OrganizationRepository(prisma);
      const realFind = stale.findById.bind(stale);
      stale.findById = async (id: string) => {
        const current = await realFind(id);
        return current ? { ...current, status: 'SUSPENDED' as never } : current;
      };

      const statusEventsBefore = await prisma.client.outboxMessage.count({
        where: { aggregateId: organization.id, eventName: 'ORGANIZATION_STATUS_CHANGED' },
      });

      const error = await errorOf(
        operator(() =>
          serviceWith(8, stale).changeStatus(organization.id, {
            status: 'ACTIVE',
            reason: 'stale',
          }),
        ),
      );

      expect(error.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(error.status).toBe(409);
      expect((await row(organization.id)).status).toBe('DEACTIVATED');
      expect(
        await prisma.client.outboxMessage.count({
          where: { aggregateId: organization.id, eventName: 'ORGANIZATION_STATUS_CHANGED' },
        }),
      ).toBe(statusEventsBefore);
    });

    it('of two concurrent changes from the same status, exactly one wins', async () => {
      const service = serviceWith();
      const organization = await create(service);
      await operator(() =>
        service.changeStatus(organization.id, { status: 'SUSPENDED', reason: 'first' }),
      );

      const outcomes = await Promise.allSettled([
        operator(() =>
          service.changeStatus(organization.id, { status: 'DEACTIVATED', reason: 'close' }),
        ),
        operator(() => service.changeStatus(organization.id, { status: 'ACTIVE', reason: 'back' })),
      ]);

      const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const loser = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect((loser?.reason as RastaError).code).toBe('OPTIMISTIC_LOCK_FAILED');

      const final = (await row(organization.id)).status;
      expect(final).toBe((winners[0] as PromiseFulfilledResult<OrganizationView>).value.status);
    });

    it('a cascading suspension leaves a deactivated descendant deactivated', async () => {
      const service = serviceWith();
      const parent = await create(service);
      const closed = await create(service, parent.id);
      const open = await create(service, parent.id);
      await operator(() =>
        service.changeStatus(closed.id, { status: 'DEACTIVATED', reason: 'closed' }),
      );

      await operator(() =>
        service.changeStatus(parent.id, { status: 'SUSPENDED', reason: 'investigation' }),
      );

      expect((await row(closed.id)).status).toBe('DEACTIVATED');
      expect((await row(open.id)).status).toBe('SUSPENDED');

      const event = await prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: parent.id, eventName: 'ORGANIZATION_STATUS_CHANGED' },
        orderBy: { createdAt: 'desc' },
      });
      const payload = (event.payload as { payload: { affectedIds: string[] } }).payload;
      // Consumers apply the new status to every id listed; listing the
      // deactivated child would un-deactivate it in their replicas.
      expect(new Set(payload.affectedIds)).toEqual(new Set([parent.id, open.id]));
    });
  });

  // =========================================================================
  // (e) contacts leave an audit record
  // =========================================================================

  describe('contact changes are recorded', () => {
    it('writes ORGANIZATION_CONTACT_CHANGED in the same transaction, without personal data', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const first = await adminOf(organization.id, () =>
        service.addContact(organization.id, {
          kind: 'FINANCIAL',
          displayName: 'امور مالی',
          phone: '09120000009',
          isPrimary: true,
        }),
      );
      const second = await adminOf(organization.id, () =>
        service.addContact(organization.id, {
          kind: 'FINANCIAL',
          displayName: 'امور مالی تازه',
          email: 'finance@example.test',
          isPrimary: true,
        }),
      );

      const rows = await prisma.client.outboxMessage.findMany({
        where: { aggregateId: organization.id, eventName: 'ORGANIZATION_CONTACT_CHANGED' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);

      const envelopes = rows.map(
        (outbox) =>
          outbox.payload as {
            payload: Record<string, unknown>;
            actor?: { id?: string };
          },
      );
      expect(envelopes[0]?.payload).toMatchObject({ contactId: first.id, demotedContactIds: [] });
      expect(envelopes[1]?.payload).toMatchObject({
        contactId: second.id,
        demotedContactIds: [first.id],
        hasEmail: true,
        hasPhone: false,
      });

      const serialized = JSON.stringify(rows.map((outbox) => outbox.payload));
      expect(serialized).not.toContain('09120000009');
      expect(serialized).not.toContain('finance@example.test');
      expect(serialized).not.toContain('امور مالی');
    });
  });

  // =========================================================================
  // (f) governance policy validity
  // =========================================================================

  describe('governance policy', () => {
    it('refuses an already-expired replacement and keeps the value in force', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const key = `sample.itest_${ulid().toLowerCase()}`;

      const current = await operator(() =>
        service.setPolicy(organization.id, {
          key,
          value: 1,
          inheritable: true,
          description: 'sample in force',
        }),
      );

      const error = await errorOf(
        operator(() =>
          service.setPolicy(organization.id, {
            key,
            value: 2,
            inheritable: true,
            description: 'already expired',
            effectiveTo: '2001-01-01T00:00:00.000Z',
          }),
        ),
      );
      expect(error.internalContext).toMatchObject({ rule: 'POLICY_ALREADY_EXPIRED' });

      const rows = await prisma.client.organizationPolicy.findMany({
        where: { organizationId: organization.id, key },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(current.id);
      expect(rows[0]?.effectiveTo).toBeNull();

      const effective = await operator(() => service.effectivePolicies(organization.id));
      expect(effective.find((policy) => policy.key === key)?.value).toBe(1);
    });
  });
});
