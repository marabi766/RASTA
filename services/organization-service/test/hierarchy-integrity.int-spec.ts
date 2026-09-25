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

  // =========================================================================
  // Post-merge review of #101
  // =========================================================================

  /**
   * Inside `tx`: exactly what `move` writes — the hierarchy lock, the rewritten
   * subtree paths and the new parent — without committing. Lets a test hold a
   * move open at the point where the races below happened.
   */
  /**
   * Runs `during` while `holder` is still open, then always releases it. A
   * failed expectation inside would otherwise leave the holder's locks in place
   * and every later test queued behind them.
   */
  const whileHeld = async (
    holder: { release: () => void; done: Promise<unknown> },
    during: () => Promise<unknown>,
  ) => {
    try {
      await during();
    } finally {
      holder.release();
      await holder.done;
    }
  };

  const writeMove = async (
    tx: Parameters<Parameters<PrismaService['transaction']>[0]>[0],
    id: string,
    newParentId: string,
  ) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_KEY}::bigint)`;
    const oldPath = await repository.getPath(id, tx);
    const parentPath = await repository.getPath(newParentId, tx);
    if (!oldPath || !parentPath) throw new Error('test tree is missing a path');
    await repository.rewriteSubtreePath(tx, oldPath, `${parentPath}.${toLabel(id)}`);
    await tx.organization.update({ where: { id }, data: { parentId: newParentId } });
  };

  describe('reactivation cannot race a move beneath a suspended parent', () => {
    it('waits for the uncommitted move, then reads the new ancestors and refuses', async () => {
      const service = serviceWith();
      const activeParent = await create(service);
      const stoppedParent = await create(service);
      const child = await create(service, activeParent.id);
      await operator(() => service.changeStatus(child.id, { status: 'SUSPENDED', reason: 'own' }));
      await operator(() =>
        service.changeStatus(stoppedParent.id, { status: 'SUSPENDED', reason: 'stopped' }),
      );

      // A suspended organization may move beneath a suspended one; the move
      // has written and not yet committed.
      const move = await holdTransaction((tx) => writeMove(tx, child.id, stoppedParent.id));

      const reactivating = track(
        operator(() => service.changeStatus(child.id, { status: 'ACTIVE', reason: 'cleared' })),
      );
      await whileHeld(move, async () => {
        await pause(500);
        expect(reactivating.state.settled).toBe(false);
      });

      // Before the fix the reactivation had share-locked the old, ACTIVE chain,
      // and its compare-and-set woke after the move and set the child ACTIVE
      // beneath the suspended parent.
      const error = await errorOf(reactivating.promise);
      expect(error.internalContext).toMatchObject({
        rule: 'ANCESTOR_NOT_ACTIVE',
        ancestorId: stoppedParent.id,
      });
      expect((await row(child.id)).status).toBe('SUSPENDED');
      expect((await row(child.id)).parentId).toBe(stoppedParent.id);
    });
  });

  describe('a write is authorized against the tree after any in-flight move', () => {
    let service: OrganizationService;
    let tenantA: OrganizationView;
    let tenantB: OrganizationView;

    beforeEach(async () => {
      service = new OrganizationService(repository, {
        maxDepth: 8,
        policySetterRoles: ['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'],
      });
      const root = await create(service);
      tenantA = await create(service, root.id);
      tenantB = await create(service, root.id);
    });

    it('create: the parent moves to another tenant while the create waits — nothing lands there', async () => {
      const parent = await create(service, tenantA.id);
      const move = await holdTransaction((tx) => writeMove(tx, parent.id, tenantB.id));

      const creating = track(
        adminOf(tenantA.id, () =>
          service.create({ name: 'جا مانده', type: 'DEHYARI', metadata: {}, parentId: parent.id }),
        ),
      );
      await whileHeld(move, async () => {
        await pause(500);
        expect(creating.state.settled).toBe(false);
      });

      const error = await errorOf(creating.promise);
      expect(error.code).toBe('NOT_FOUND');
      expect(await prisma.client.organization.count({ where: { parentId: parent.id } })).toBe(0);
    });

    it('setPolicy: a non-operator setter waits for the move, then is refused', async () => {
      const target = await create(service, tenantA.id);
      const key = `sample.itest_${ulid().toLowerCase()}`;
      const move = await holdTransaction((tx) => writeMove(tx, target.id, tenantB.id));

      const setting = track(
        adminOf(tenantA.id, () =>
          service.setPolicy(target.id, { key, value: 1, inheritable: true, description: 'd' }),
        ),
      );
      await whileHeld(move, async () => {
        await pause(500);
        expect(setting.state.settled).toBe(false);
      });

      expect((await errorOf(setting.promise)).code).toBe('NOT_FOUND');
      expect(
        await prisma.client.organizationPolicy.count({ where: { organizationId: target.id } }),
      ).toBe(0);
    });

    it('update: same', async () => {
      const target = await create(service, tenantA.id);
      const move = await holdTransaction((tx) => writeMove(tx, target.id, tenantB.id));

      const updating = track(adminOf(tenantA.id, () => service.update(target.id, { name: 'x' })));
      await whileHeld(move, async () => {
        await pause(500);
        expect(updating.state.settled).toBe(false);
      });

      expect((await errorOf(updating.promise)).code).toBe('NOT_FOUND');
      expect((await row(target.id)).name).toBe(target.name);
    });

    it('a write inside the caller subtree still succeeds after waiting', async () => {
      const target = await create(service, tenantA.id);
      const elsewhere = await create(service, tenantB.id);
      const unrelated = await create(service);
      // A move of something else holds the lock; the write waits, then proceeds.
      const move = await holdTransaction((tx) => writeMove(tx, elsewhere.id, unrelated.id));

      const updating = track(adminOf(tenantA.id, () => service.update(target.id, { name: 'ok' })));
      await whileHeld(move, () => pause(300));

      expect((await updating.promise).name).toBe('ok');
    });
  });

  describe('list: visibility, filters and paging in one statement', () => {
    let service: OrganizationService;
    let root: OrganizationView;
    let tenantA: OrganizationView;
    let tenantB: OrganizationView;
    const children: OrganizationView[] = [];
    const tag = `LIST${ulid().slice(-6)}`;

    beforeAll(async () => {
      service = serviceWith();
      root = await create(service);
      tenantA = await create(service, root.id);
      tenantB = await create(service, root.id);
      for (const name of [`${tag} الف`, `${tag} ب`, `${tag} 100%`, `${tag} ج`]) {
        children.push(
          await operator(() =>
            service.create({ name, type: 'DEHYARI', metadata: {}, parentId: tenantA.id }),
          ),
        );
      }
      await operator(() =>
        service.create({
          name: `${tag} other`,
          type: 'DEHYARI',
          metadata: {},
          parentId: tenantB.id,
        }),
      );
    });

    const listAs = (who: string | null, query: Record<string, unknown>) =>
      (who ? (fn: () => Promise<unknown>) => adminOf(who, fn) : operator)(() =>
        service.list({ limit: 50, ...query } as never),
      ) as Promise<{ items: OrganizationView[]; nextCursor: string | null; hasMore: boolean }>;

    it('a tenant sees its own subtree and none of the other tenant', async () => {
      const { items } = await listAs(tenantA.id, { q: tag });
      expect(new Set(items.map((item) => item.id))).toEqual(new Set(children.map((c) => c.id)));
    });

    it('a platform operator sees both tenants', async () => {
      const { items } = await listAs(null, { q: tag });
      expect(items).toHaveLength(5);
    });

    it('q matches case-insensitively, and % is a literal character', async () => {
      expect((await listAs(tenantA.id, { q: tag.toLowerCase() })).items).toHaveLength(4);
      const percent = await listAs(tenantA.id, { q: '100%' });
      expect(percent.items.map((item) => item.name)).toEqual([`${tag} 100%`]);
    });

    it('parentId and status filter; the row maps to the public view', async () => {
      const { items } = await listAs(null, { parentId: tenantB.id, status: 'ACTIVE' });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ parentId: tenantB.id, status: 'ACTIVE', type: 'DEHYARI' });
      expect(typeof items[0]?.createdAt).toBe('string');
    });

    it('pages by cursor with the limit applied after the visibility filter', async () => {
      const first = await listAs(tenantA.id, { q: tag, limit: 3 });
      expect(first.items).toHaveLength(3);
      expect(first.hasMore).toBe(true);
      const second = await listAs(tenantA.id, { q: tag, limit: 3, cursor: first.nextCursor });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      const all = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(all)).toEqual(new Set(children.map((c) => c.id)));
    });
  });

  describe('ancestors stop at the caller visible root', () => {
    it('a tenant sees the chain from itself down, never the root above it', async () => {
      const service = serviceWith();
      const root = await create(service);
      const tenant = await create(service, root.id);
      const child = await create(service, tenant.id);
      const grandchild = await create(service, child.id);

      const asTenant = await adminOf(tenant.id, () => service.ancestors(grandchild.id));
      expect(asTenant.map((item) => item.id)).toEqual([tenant.id, child.id]);

      expect(await adminOf(tenant.id, () => service.ancestors(tenant.id))).toEqual([]);

      const asOperator = await operator(() => service.ancestors(grandchild.id));
      expect(asOperator.map((item) => item.id)).toEqual([root.id, tenant.id, child.id]);
    });
  });

  describe('policy timeline: one value per instant', () => {
    const periods = async (organizationId: string, key: string) =>
      prisma.client.organizationPolicy.findMany({
        where: { organizationId, key },
        orderBy: { effectiveFrom: 'asc' },
      });

    it('concurrent immediate replacements leave exactly one open-ended value', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const key = `sample.itest_${ulid().toLowerCase()}`;

      const outcomes = await Promise.allSettled(
        [1, 2, 3, 4, 5].map((value) =>
          operator(() =>
            service.setPolicy(organization.id, { key, value, inheritable: true, description: 'r' }),
          ),
        ),
      );

      // Every writer succeeds: each waits for the one before it and replaces
      // its value. Without the per-key lock, writers collided on the database
      // constraint and failed; before the constraint, they all "succeeded" and
      // left several open-ended values.
      expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(5).fill('fulfilled'));
      const rows = await periods(organization.id, key);
      expect(rows).toHaveLength(5);
      expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
      for (const r of rows) {
        if (r.effectiveTo)
          expect(r.effectiveTo.getTime()).toBeGreaterThan(r.effectiveFrom.getTime());
      }
      // Consecutive periods meet without overlapping.
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1]?.effectiveTo?.getTime()).toBeLessThanOrEqual(
          rows[i]?.effectiveFrom.getTime() ?? 0,
        );
      }
    });

    it('an immediate replacement of a scheduled value is refused; one that ends before it is accepted', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const key = `sample.itest_${ulid().toLowerCase()}`;
      const scheduledFrom = new Date(Date.now() + 7 * 86_400_000);
      const set = (value: number, extra: Record<string, string> = {}) =>
        operator(() =>
          service.setPolicy(organization.id, {
            key,
            value,
            inheritable: true,
            description: 'd',
            ...extra,
          }),
        );

      await set(1);
      await set(2, { effectiveFrom: scheduledFrom.toISOString() });

      const error = await errorOf(set(3));
      expect(error.internalContext).toMatchObject({ rule: 'POLICY_SCHEDULE_CONFLICT' });

      await set(4, { effectiveTo: scheduledFrom.toISOString() });

      const rows = await periods(organization.id, key);
      expect(rows.map((r) => r.value)).toEqual([1, 4, 2]);
      expect(rows[1]?.effectiveTo?.getTime()).toBe(scheduledFrom.getTime());
      expect(rows[2]?.effectiveFrom.getTime()).toBe(scheduledFrom.getTime());
      expect(rows[2]?.effectiveTo).toBeNull();
      const effective = await operator(() => service.effectivePolicies(organization.id));
      expect(effective.find((policy) => policy.key === key)?.value).toBe(4);
    });

    it('the database refuses an overlapping or inverted period written around the service', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const key = `sample.itest_${ulid().toLowerCase()}`;
      await operator(() =>
        service.setPolicy(organization.id, { key, value: 1, inheritable: true, description: 'd' }),
      );
      const insert = (from: Date, to: Date | null) =>
        prisma.client.organizationPolicy.create({
          data: {
            id: `POL_${ulid()}`,
            organizationId: organization.id,
            key,
            value: 9,
            effectiveFrom: from,
            effectiveTo: to,
            createdBy: 'itest',
            updatedBy: 'itest',
          },
        });

      await expect(insert(new Date(Date.now() + 60_000), null)).rejects.toThrow(
        /ex_policy_no_overlap/,
      );
      await expect(insert(new Date(2001, 1, 2), new Date(2001, 1, 1))).rejects.toThrow(
        /ck_policy_effective_range/,
      );
    });
  });

  describe('one primary contact per kind', () => {
    it('concurrent primary adds leave exactly one primary, and each demotes the one before', async () => {
      const service = serviceWith();
      const organization = await create(service);

      const outcomes = await Promise.allSettled(
        [1, 2, 3, 4, 5].map((n) =>
          adminOf(organization.id, () =>
            service.addContact(organization.id, {
              kind: 'EMERGENCY',
              displayName: `contact ${n}`,
              phone: `0912000000${n}`,
              isPrimary: true,
            }),
          ),
        ),
      );

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      const primaries = await prisma.client.organizationContact.count({
        where: { organizationId: organization.id, kind: 'EMERGENCY', isPrimary: true },
      });
      expect(primaries).toBe(1);
    });

    it('the database refuses a second primary written around the service', async () => {
      const service = serviceWith();
      const organization = await create(service);
      await adminOf(organization.id, () =>
        service.addContact(organization.id, {
          kind: 'TECHNICAL',
          displayName: 'first',
          phone: '09120000001',
          isPrimary: true,
        }),
      );

      await expect(
        prisma.client.organizationContact.create({
          data: {
            id: `CNT_${ulid()}`,
            organizationId: organization.id,
            kind: 'TECHNICAL',
            displayName: 'second',
            phone: '09120000002',
            isPrimary: true,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // =========================================================================
  // Review round 1 on #111: reads answer from one tree
  // =========================================================================

  describe('a read checks visibility and reads its data from the same tree', () => {
    /**
     * root ─ tenantA ─ x ─ y
     *      └ b0 ─ tenantB          (tenantB one level deeper than tenantA)
     *
     * tenantB holds an inheritable policy tenantA does not. The repository
     * below commits a real move of x beneath tenantB right after the visibility
     * check for x has passed — before the read that follows it. Answered from
     * one tree, the read is the one the caller was allowed: x under tenantA.
     */
    const build = async () => {
      const service = serviceWith();
      const root = await create(service);
      const tenantA = await create(service, root.id);
      const b0 = await create(service, root.id);
      const tenantB = await create(service, b0.id);
      const x = await create(service, tenantA.id);
      const y = await create(service, x.id);
      const key = `sample.itest_${ulid().toLowerCase()}`;
      await operator(() =>
        service.setPolicy(tenantA.id, {
          key,
          value: 'tenant A value',
          inheritable: true,
          description: 'A',
        }),
      );
      await operator(() =>
        service.setPolicy(tenantB.id, {
          key,
          value: 'tenant B value',
          inheritable: true,
          description: 'B governance, not for tenant A',
        }),
      );
      return { service, tenantA, tenantB, x, y, key };
    };

    /** A service whose first visibility check is followed by a committed move. */
    const racing = (move: () => Promise<unknown>) => {
      const repo = new OrganizationRepository(prisma);
      const check = repo.isAncestorOf.bind(repo);
      let fired = false;
      repo.isAncestorOf = async (...args: Parameters<typeof check>) => {
        const allowed = await check(...args);
        if (!fired) {
          fired = true;
          await move();
        }
        return allowed;
      };
      return serviceWith(8, repo);
    };

    it('effectivePolicies: never returns the new parent inherited governance', async () => {
      const { service, tenantA, tenantB, x, key } = await build();
      const reader = racing(() =>
        operator(() => service.move(x.id, { parentId: tenantB.id, reason: 'race' })),
      );

      const policies = await adminOf(tenantA.id, () => reader.effectivePolicies(x.id));

      const value = policies.find((policy) => policy.key === key);
      expect(value).toMatchObject({ value: 'tenant A value', inheritedFrom: tenantA.id });
      expect(JSON.stringify(policies)).not.toContain('B governance');
      // The move did commit; the read simply answered from before it.
      expect((await row(x.id)).parentId).toBe(tenantB.id);
    });

    it('get: returns x as it was when the caller was allowed to see it', async () => {
      const { service, tenantA, tenantB, x } = await build();
      const reader = racing(() =>
        operator(() => service.move(x.id, { parentId: tenantB.id, reason: 'race' })),
      );

      const view = await adminOf(tenantA.id, () => reader.get(x.id));

      expect(view.parentId).toBe(tenantA.id);
      expect(view.depth).toBe(2);
      expect(view.path).toBe(await pathOf(tenantA.id).then((p) => `${p}.${toLabel(x.id)}`));
    });

    it('children: the child is read at the depth it had under tenant A', async () => {
      const { service, tenantA, tenantB, x, y } = await build();
      const reader = racing(() =>
        operator(() => service.move(x.id, { parentId: tenantB.id, reason: 'race' })),
      );

      const rows = await adminOf(tenantA.id, () => reader.children(x.id));

      expect(rows.map((r) => [r.id, r.depth])).toEqual([[y.id, 3]]);
    });

    it('subtree: every row is read at its depth under tenant A', async () => {
      const { service, tenantA, tenantB, x, y } = await build();
      const reader = racing(() =>
        operator(() => service.move(x.id, { parentId: tenantB.id, reason: 'race' })),
      );

      const rows = await adminOf(tenantA.id, () => reader.subtree(x.id));

      expect(rows.map((r) => [r.id, r.depth])).toEqual([
        [x.id, 2],
        [y.id, 3],
      ]);
    });

    it('ancestors: the chain is the one the check was made against', async () => {
      const { service, tenantA, tenantB, x } = await build();
      const reader = racing(() =>
        operator(() => service.move(x.id, { parentId: tenantB.id, reason: 'race' })),
      );

      const chain = await adminOf(tenantA.id, () => reader.ancestors(x.id));

      expect(chain.map((r) => r.id)).toEqual([tenantA.id]);
    });
  });

  describe('a dated policy that expires while it waits for the per-key lock', () => {
    it('is refused after the lock, and nothing is written', async () => {
      const service = serviceWith();
      const organization = await create(service);
      const key = `sample.itest_${ulid().toLowerCase()}`;
      const effectiveTo = new Date(Date.now() + 1_500);

      // Another writer of the same key holds the lock past that end date.
      const holder = await holdTransaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${`policy:${organization.id}`}), hashtext(${key}))
        `;
      });
      const setting = track(
        operator(() =>
          service.setPolicy(organization.id, {
            key,
            value: 1,
            inheritable: true,
            description: 'expires while queued',
            // Explicitly dated: the start is given, so nothing re-reads the
            // clock for it after the lock.
            effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
            effectiveTo: effectiveTo.toISOString(),
          }),
        ),
      );
      await whileHeld(holder, async () => {
        await pause(2_000);
        expect(setting.state.settled).toBe(false);
      });

      const error = await errorOf(setting.promise);
      expect(error.internalContext).toMatchObject({ rule: 'POLICY_ALREADY_EXPIRED' });
      expect(
        await prisma.client.organizationPolicy.count({
          where: { organizationId: organization.id, key },
        }),
      ).toBe(0);
    });
  });
});
