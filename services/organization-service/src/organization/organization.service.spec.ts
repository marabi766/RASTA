import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { OrganizationService } from './organization.service';
import { toLabel, type OrganizationRepository } from './organization.repository';
import { ORGANIZATION_EVENTS } from './events';

/**
 * Organization service behaviour, with the repository stubbed.
 *
 * The cases that matter here are the ones where a mistake is a security or
 * integrity defect: subtree visibility, hierarchy cycles, and who may create a
 * root or set governance policy.
 */

const PROVINCE = 'ORG-PROVINCE-YAZD';
const COUNTY = 'ORG-COUNTY-YAZD';
const DEH1 = 'ORG-DEH-0001';
const DEH2 = 'ORG-DEH-0002';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: DEH1,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['ORGANIZATION_ADMIN'],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

const unionContext = (o: Partial<RequestContext> = {}) =>
  context({ organizationId: 'ORG-UNION-YAZD', roles: ['UNION_ADMIN'], ...o });

function orgRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    externalCode: null,
    name: `org ${id}`,
    shortName: null,
    type: 'DEHYARI',
    status: 'ACTIVE',
    parentId: COUNTY,
    depth: 2,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    version: 1,
    ...overrides,
  };
}

interface Harness {
  service: OrganizationService;
  repository: jest.Mocked<OrganizationRepository>;
  enqueued: Array<{ eventName: string; payload: unknown }>;
  tx: {
    organization: Record<string, jest.Mock>;
    organizationPolicy: Record<string, jest.Mock>;
    organizationContact: Record<string, jest.Mock>;
  };
}

/**
 * `ancestry` describes the real seeded tree, so `isAncestorOf` answers the way
 * PostgreSQL would rather than however a test happens to stub it.
 */
const ANCESTRY: Record<string, string[]> = {
  [PROVINCE]: [PROVINCE, 'ORG-UNION-YAZD', COUNTY, DEH1, DEH2],
  [COUNTY]: [COUNTY, DEH1, DEH2],
  [DEH1]: [DEH1],
  [DEH2]: [DEH2],
  'ORG-UNION-YAZD': ['ORG-UNION-YAZD'],
};

/** Parent of each seeded node; the chain the lock query would return. */
const PARENT: Record<string, string | null> = {
  [PROVINCE]: null,
  'ORG-UNION-YAZD': PROVINCE,
  [COUNTY]: PROVINCE,
  [DEH1]: COUNTY,
  [DEH2]: COUNTY,
};

/**
 * `id` and its ancestors root-first, as `lockAncestorChain` returns them.
 * `statuses` overrides the default ACTIVE per node.
 */
function chainOf(
  id: string,
  statuses: Record<string, string> = {},
  includeSelf = true,
): Array<{ id: string; status: string; depth: number; path: string }> {
  const ids: string[] = [];
  for (let node: string | null = id; node; node = PARENT[node] ?? null) ids.unshift(node);
  const rows = ids.map((node, index) => ({
    id: node,
    status: statuses[node] ?? 'ACTIVE',
    depth: index,
    path: ids
      .slice(0, index + 1)
      .map(toLabel)
      .join('.'),
  }));
  return includeSelf ? rows : rows.slice(0, -1);
}

function harness(
  overrides: Partial<jest.Mocked<OrganizationRepository>> = {},
  options: { maxDepth?: number; policySetterRoles?: string[] } = {},
): Harness {
  const enqueued: Array<{ eventName: string; payload: unknown }> = [];

  const tx = {
    organization: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    organizationPolicy: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    organizationLocation: { create: jest.fn() },
    organizationContact: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(async () => []),
    },
  };

  const repository = {
    client: tx,
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    enqueueEvent: jest.fn(async (_tx: unknown, input: { eventName: string; payload: unknown }) => {
      enqueued.push({ eventName: input.eventName, payload: input.payload });
      return 'evt-1';
    }),
    findById: jest.fn(),
    findDetailById: jest.fn(),
    findByExternalCode: jest.fn(async () => null),
    findChildren: jest.fn(async () => []),
    findAncestors: jest.fn(async () => []),
    findSubtree: jest.fn(async () => []),
    isAncestorOf: jest.fn(
      async (ancestor: string, descendant: string) =>
        (ANCESTRY[ancestor] ?? []).includes(descendant) && ancestor !== descendant,
    ),
    getPath: jest.fn(async (id: string) => toLabel(id)),
    setPath: jest.fn(async () => ({ path: 'p', depth: 1 })),
    rewriteSubtreePath: jest.fn(async () => 3),
    readLocationPoints: jest.fn(async () => new Map()),
    list: jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    findNearby: jest.fn(async () => []),
    setLocationPoint: jest.fn(),
    lockHierarchy: jest.fn(async () => undefined),
    lockPolicyKey: jest.fn(async () => undefined),
    lockContactKind: jest.fn(async () => undefined),
    lockAncestorChain: jest.fn(async (_tx: unknown, id: string, o: { includeSelf: boolean }) =>
      chainOf(id, {}, o.includeSelf),
    ),
    lockForUpdate: jest.fn(async (_tx: unknown, id: string) => {
      const self = chainOf(id).at(-1);
      return self
        ? { id, status: self.status, depth: self.depth, parent_id: PARENT[id], path: self.path }
        : null;
    }),
    deepestDepthUnder: jest.fn(async (_tx: unknown, path: string) => path.split('.').length - 1),
    statusesUnder: jest.fn(async () => ['ACTIVE']),
    compareAndSetStatus: jest.fn(async () => 1),
    cascadeStatus: jest.fn(async () => []),
    ...overrides,
  } as unknown as jest.Mocked<OrganizationRepository>;

  const service = new OrganizationService(repository, {
    maxDepth: options.maxDepth ?? 8,
    policySetterRoles: options.policySetterRoles ?? ['SYSTEM_ADMIN', 'UNION_ADMIN'],
  });
  return { service, repository, enqueued, tx };
}

// ---------------------------------------------------------------------------

describe('subtree visibility', () => {
  it('lets an organization read itself', async () => {
    const h = harness();
    h.repository.findDetailById.mockResolvedValue({
      ...orgRow(DEH1),
      locations: [],
      contacts: [],
      childCount: 0,
    } as never);

    const result = await runWithContext(context(), () => h.service.get(DEH1));
    expect(result.id).toBe(DEH1);
  });

  it('returns 404 - not 403 - for a sibling', async () => {
    // 403 would confirm the sibling exists, letting an attacker enumerate
    // other organizations by identifier.
    const h = harness();

    const error = await runWithContext(context(), () =>
      h.service.get(DEH2).catch((e: unknown) => e),
    );

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe('NOT_FOUND');
    expect((error as RastaError).status).toBe(404);
  });

  it('returns 404 for an ancestor', async () => {
    // Read access flows downward only. A dehyari has no business reading the
    // county it belongs to.
    const h = harness();

    const error = await runWithContext(context(), () =>
      h.service.get(COUNTY).catch((e: unknown) => e),
    );

    expect((error as RastaError).code).toBe('NOT_FOUND');
  });

  it('lets a parent read its descendant', async () => {
    const h = harness();
    h.repository.findDetailById.mockResolvedValue({
      ...orgRow(DEH1),
      locations: [],
      contacts: [],
      childCount: 0,
    } as never);

    const result = await runWithContext(context({ organizationId: COUNTY }), () =>
      h.service.get(DEH1),
    );

    expect(result.id).toBe(DEH1);
  });

  it('lets a platform operator read anything', async () => {
    const h = harness();
    h.repository.findDetailById.mockResolvedValue({
      ...orgRow(DEH2),
      locations: [],
      contacts: [],
      childCount: 0,
    } as never);

    const result = await runWithContext(unionContext(), () => h.service.get(DEH2));
    expect(result.id).toBe(DEH2);
  });

  it('scopes a list to the caller subtree', async () => {
    const h = harness();
    await runWithContext(context(), () =>
      h.service.list({ limit: 25, cursor: undefined } as never),
    );

    // A non-operator must always be passed a root to restrict against; null
    // here would mean "show everything".
    expect(h.repository.list).toHaveBeenCalledWith(expect.anything(), DEH1);
  });

  it('does not restrict a list for a platform operator', async () => {
    const h = harness();
    await runWithContext(unionContext(), () =>
      h.service.list({ limit: 25, cursor: undefined } as never),
    );

    expect(h.repository.list).toHaveBeenCalledWith(expect.anything(), null);
  });
});

describe('hierarchy integrity', () => {
  it('refuses to make an organization its own parent', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY) as never);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.move(COUNTY, { parentId: COUNTY, reason: 'nonsense' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('refuses to move an organization beneath its own descendant', async () => {
    // The check that matters. Without it the subtree detaches into a ring that
    // no subtree query reaches and no ancestor walk terminates on.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE, { depth: 0 }) as never);

    const error = await runWithContext(unionContext(), () =>
      h.service.move(PROVINCE, { parentId: DEH1, reason: 'cycle attempt' }).catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).message).toMatch(/descendant/i);
  });

  it('allows a legitimate move and rewrites the subtree once', async () => {
    const h = harness();
    h.repository.findById.mockImplementation(async (id: string) => orgRow(id) as never);
    (
      h.repository.client as unknown as { organization: { update: jest.Mock } }
    ).organization.update.mockResolvedValue(orgRow(DEH2, { parentId: PROVINCE }));

    await runWithContext(unionContext(), () =>
      h.service.move(DEH2, { parentId: PROVINCE, reason: 'county dissolved' }),
    );

    // One statement for the whole subtree: a row-by-row rewrite would leave
    // the tree inconsistent if it failed partway.
    expect(h.repository.rewriteSubtreePath).toHaveBeenCalledTimes(1);
    expect(h.enqueued.map((e) => e.eventName)).toContain(ORGANIZATION_EVENTS.ORGANIZATION_MOVED);
  });

  it('refuses a move by a non-operator, even within their own subtree', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);

    await expect(
      runWithContext(context({ organizationId: COUNTY }), () =>
        h.service.move(DEH1, { parentId: PROVINCE, reason: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('creation', () => {
  it('refuses a root organization from a non-operator', async () => {
    // A root sits outside every existing subtree, so allowing this would let
    // any organization create a branch nothing can scope.
    const h = harness();

    await expect(
      runWithContext(context(), () =>
        h.service.create({ name: 'شهرداری تازه', type: 'MUNICIPALITY', metadata: {} } as never),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces the depth limit', async () => {
    // DEH1 is at depth 2, so its child would be at 3.
    const h = harness({}, { maxDepth: 2 });

    const error = await runWithContext(unionContext(), () =>
      h.service
        .create({ name: 'خیلی عمیق', type: 'DEHYARI', parentId: DEH1, metadata: {} } as never)
        .catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).message).toMatch(/2 levels/);
  });

  it('emits ORGANIZATION_CREATED inside the same transaction as the insert', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY, { depth: 1 }) as never);
    (
      h.repository.client as unknown as { organization: { create: jest.Mock } }
    ).organization.create.mockResolvedValue(orgRow('ORG_NEW'));

    await runWithContext(unionContext(), () =>
      h.service.create({
        name: 'دهیاری تازه',
        type: 'DEHYARI',
        parentId: COUNTY,
        metadata: {},
      } as never),
    );

    expect(h.repository.transaction).toHaveBeenCalledTimes(1);
    expect(h.enqueued.map((e) => e.eventName)).toEqual([ORGANIZATION_EVENTS.ORGANIZATION_CREATED]);
  });
});

describe('governance policy', () => {
  it('refuses a policy change from a role that is not configured to set one', async () => {
    // Policies decide who may approve what, so this stays restricted even
    // inside your own subtree (ADR-023). Which roles may is configuration.
    const h = harness();

    await expect(
      runWithContext(context(), () =>
        h.service.setPolicy(DEH1, {
          key: 'approval.project.required',
          value: false,
          inheritable: true,
          description: 'trying to disable my own approvals',
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE', status: 403 });
  });

  it('closes the previous value rather than overwriting it', async () => {
    // A governance decision taken last year must stay reconstructible.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE, { depth: 0 }) as never);
    const client = h.repository.client as unknown as {
      organizationPolicy: { create: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
    };
    // The value in force: began at the epoch, open-ended.
    client.organizationPolicy.findMany.mockResolvedValue([
      { id: 'POL_0', effectiveFrom: new Date(0), effectiveTo: null },
    ]);
    client.organizationPolicy.create.mockResolvedValue({
      id: 'POL_1',
      key: 'approval.project.required',
      value: false,
      inheritable: true,
      description: 'd',
      effectiveFrom: new Date(0),
      effectiveTo: null,
    });

    await runWithContext(unionContext(), () =>
      h.service.setPolicy(PROVINCE, {
        key: 'approval.project.required',
        value: false,
        inheritable: true,
        description: 'revised after legal review',
      } as never),
    );

    expect(client.organizationPolicy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['POL_0'] } },
        data: expect.objectContaining({ effectiveTo: expect.any(Date) }),
      }),
    );
    expect(h.enqueued.map((e) => e.eventName)).toContain(
      ORGANIZATION_EVENTS.ORGANIZATION_POLICY_CHANGED,
    );
  });
});

describe('status changes', () => {
  it('cascades suspension to the subtree read inside the transaction', async () => {
    // Leaving a dehyari active beneath a suspended parent would let it keep
    // transacting through an organization that is meant to be stopped.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY, { depth: 1 }) as never);
    h.repository.cascadeStatus.mockResolvedValue([DEH1, DEH2]);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(COUNTY, { status: 'SUSPENDED' }));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(COUNTY, { status: 'SUSPENDED', reason: 'under investigation' }),
    );

    expect(h.repository.cascadeStatus).toHaveBeenCalledWith(
      expect.anything(),
      COUNTY,
      toLabel(COUNTY),
      'SUSPENDED',
      expect.any(String),
    );
    // The subtree is not read before the transaction any more: a child created
    // between that read and the update would have been left ACTIVE.
    expect(h.repository.findSubtree).not.toHaveBeenCalled();

    const event = h.enqueued.find(
      (e) => e.eventName === ORGANIZATION_EVENTS.ORGANIZATION_STATUS_CHANGED,
    );
    expect((event?.payload as { affectedIds: string[] }).affectedIds).toEqual([COUNTY, DEH1, DEH2]);
  });

  it('does not cascade a return to ACTIVE', async () => {
    // Reactivating a parent must not silently reactivate children that were
    // suspended for their own separate reasons.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY, { status: 'SUSPENDED' }) as never);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(COUNTY));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(COUNTY, { status: 'ACTIVE', reason: 'cleared' }),
    );

    expect(h.repository.cascadeStatus).not.toHaveBeenCalled();
    expect(h.repository.compareAndSetStatus).toHaveBeenCalledWith(
      expect.anything(),
      COUNTY,
      'SUSPENDED',
      'ACTIVE',
      expect.any(String),
    );
  });

  it('refuses to revive a deactivated organization', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'DEACTIVATED' }) as never);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'oops' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(h.repository.compareAndSetStatus).not.toHaveBeenCalled();
  });

  // L3-07 — a stale read must not become a write
  it('compares and sets against the status it read', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }) as never);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(DEH1));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'cleared' }),
    );

    // Matching on the expected status is what makes a concurrent
    // deactivation win: the update then matches no row.
    expect(h.repository.compareAndSetStatus).toHaveBeenCalledWith(
      expect.anything(),
      DEH1,
      'SUSPENDED',
      'ACTIVE',
      expect.any(String),
    );
  });

  it('fails with a conflict, and writes nothing else, when the row changed underneath', async () => {
    // The read said SUSPENDED; by the time of the write someone deactivated
    // it. Zero rows updated must surface as a conflict, not as success.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }) as never);
    h.repository.compareAndSetStatus.mockResolvedValue(0);

    const error = await runWithContext(unionContext(), () =>
      h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'stale' }).catch((e) => e),
    );

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe('OPTIMISTIC_LOCK_FAILED');
    expect((error as RastaError).status).toBe(409);
    expect(h.repository.cascadeStatus).not.toHaveBeenCalled();
    expect(h.enqueued).toEqual([]);
  });

  it('also conflicts on a stale cascading change, before touching the subtree', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY) as never);
    h.repository.compareAndSetStatus.mockResolvedValue(0);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.changeStatus(COUNTY, { status: 'SUSPENDED', reason: 'stale' }),
      ),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    expect(h.repository.cascadeStatus).not.toHaveBeenCalled();
  });

  // L3-06 — reactivation beneath a stopped ancestor
  it.each(['SUSPENDED', 'DEACTIVATED'])(
    'refuses to reactivate beneath a %s ancestor',
    async (ancestorStatus) => {
      const h = harness();
      h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }) as never);
      h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
        chainOf(id, { [PROVINCE]: ancestorStatus }, o.includeSelf),
      );

      const error = await runWithContext(unionContext(), () =>
        h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'cleared' }).catch((e) => e),
      );

      expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
      expect((error as RastaError).internalContext).toMatchObject({
        rule: 'ANCESTOR_NOT_ACTIVE',
        ancestorId: PROVINCE,
      });
      expect(h.repository.compareAndSetStatus).not.toHaveBeenCalled();
    },
  );

  it('checks ancestors only, never share-locking the row it is about to update', async () => {
    // Share-then-upgrade on the same row is how two concurrent reactivations
    // deadlock; the compare-and-set takes that row's lock itself.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }) as never);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(DEH1));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'cleared' }),
    );

    expect(h.repository.lockAncestorChain).toHaveBeenCalledWith(expect.anything(), DEH1, {
      includeSelf: false,
    });
  });

  it('does not check ancestors for a suspension', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
      chainOf(id, { [COUNTY]: 'SUSPENDED' }, o.includeSelf),
    );
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }));

    await expect(
      runWithContext(unionContext(), () =>
        h.service.changeStatus(DEH1, { status: 'SUSPENDED', reason: 'own reasons' }),
      ),
    ).resolves.toMatchObject({ status: 'SUSPENDED' });
  });
});

// (a) — a radius search is not a way around the tree
describe('nearby visibility', () => {
  const query = { latitude: 31.9, longitude: 54.4, radiusMeters: 50_000, limit: 25 };

  it('restricts a non-operator to their own subtree', async () => {
    const h = harness();
    await runWithContext(context({ organizationId: COUNTY }), () => h.service.nearby(query));

    // Null here would mean "the whole country", which is exactly the leak.
    expect(h.repository.findNearby).toHaveBeenCalledWith(query, COUNTY);
  });

  it('does not restrict a platform operator', async () => {
    const h = harness();
    await runWithContext(unionContext(), () => h.service.nearby(query));

    expect(h.repository.findNearby).toHaveBeenCalledWith(query, null);
  });

  it('refuses a caller with no organization context rather than showing everything', async () => {
    const h = harness();
    await expect(
      runWithContext(context({ organizationId: undefined as never }), () =>
        h.service.nearby(query),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.repository.findNearby).not.toHaveBeenCalled();
  });

  it('refuses a caller whose organization this service does not know', async () => {
    const h = harness({ getPath: jest.fn(async () => null) } as never);
    await expect(
      runWithContext(context({ organizationId: 'ORG-GHOST' }), () => h.service.nearby(query)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.repository.findNearby).not.toHaveBeenCalled();
  });
});

// (b) — move: depth of the whole subtree, and checks under the hierarchy lock
describe('move integrity', () => {
  it('checks the depth of the deepest descendant, not just the moved root', async () => {
    // COUNTY (depth 1) has leaves at depth 2. Moved beneath DEH2 (depth 2) the
    // county lands at 3 and its leaves at 4, so a limit of 3 must refuse it
    // even though the county alone would fit.
    const h = harness({}, { maxDepth: 3 });
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
      id === 'ORG-UNION-YAZD'
        ? chainOf('ORG-UNION-YAZD', {}, o.includeSelf).map((row) => ({ ...row, depth: 2 }))
        : chainOf(id, {}, o.includeSelf),
    );
    h.repository.deepestDepthUnder.mockResolvedValue(2);

    const error = await runWithContext(unionContext(), () =>
      h.service.move(COUNTY, { parentId: 'ORG-UNION-YAZD', reason: 'too deep' }).catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).internalContext).toMatchObject({
      rule: 'HIERARCHY_TOO_DEEP',
      resultingDepth: 4,
    });
    expect(h.repository.rewriteSubtreePath).not.toHaveBeenCalled();
  });

  it('allows a move whose deepest descendant lands exactly at the limit', async () => {
    const h = harness({}, { maxDepth: 3 });
    h.repository.deepestDepthUnder.mockResolvedValue(2);
    h.tx.organization.update.mockResolvedValue(orgRow(COUNTY, { parentId: 'ORG-UNION-YAZD' }));

    // UNION is at depth 1: county lands at 2, its leaves at 3.
    await runWithContext(unionContext(), () =>
      h.service.move(COUNTY, { parentId: 'ORG-UNION-YAZD', reason: 'fits' }),
    );
    expect(h.repository.rewriteSubtreePath).toHaveBeenCalledTimes(1);
  });

  it('takes the hierarchy lock before reading any path it checks', async () => {
    const h = harness();
    const order: string[] = [];
    h.repository.lockHierarchy.mockImplementation(async () => void order.push('lock'));
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) => {
      order.push('chain');
      return chainOf(id, {}, o.includeSelf);
    });
    h.repository.lockForUpdate.mockImplementation(async (_tx, id) => {
      order.push('row');
      const self = chainOf(id).at(-1)!;
      return { id, status: 'ACTIVE', depth: self.depth, parent_id: PARENT[id], path: self.path };
    });
    h.tx.organization.update.mockResolvedValue(orgRow(DEH2, { parentId: PROVINCE }));

    await runWithContext(unionContext(), () =>
      h.service.move(DEH2, { parentId: PROVINCE, reason: 'order' }),
    );

    // Parent chain before the moved row: the order a concurrent cascade takes.
    expect(order).toEqual(['lock', 'chain', 'row']);
    expect(h.repository.isAncestorOf).not.toHaveBeenCalled();
  });

  it('detects the cycle from the chain read under the lock', async () => {
    // What a concurrent move would have produced: DEH2 now sits under COUNTY's
    // chain in a way the pre-lock tree did not show.
    const h = harness();
    h.repository.lockAncestorChain.mockResolvedValue([
      ...chainOf(DEH2),
      { id: 'ORG-UNION-YAZD', status: 'ACTIVE', depth: 3, path: 'x' },
    ]);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.move(DEH2, { parentId: 'ORG-UNION-YAZD', reason: 'ring' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(h.repository.rewriteSubtreePath).not.toHaveBeenCalled();
  });

  it('refuses to move an active subtree beneath a suspended organization', async () => {
    const h = harness();
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
      chainOf(id, { 'ORG-UNION-YAZD': 'SUSPENDED' }, o.includeSelf),
    );

    const error = await runWithContext(unionContext(), () =>
      h.service.move(DEH2, { parentId: 'ORG-UNION-YAZD', reason: 'x' }).catch((e) => e),
    );

    expect((error as RastaError).internalContext).toMatchObject({ rule: 'ANCESTOR_NOT_ACTIVE' });
    expect(h.repository.rewriteSubtreePath).not.toHaveBeenCalled();
  });

  it('allows moving a subtree with nothing active beneath a suspended organization', async () => {
    const h = harness();
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
      chainOf(id, { 'ORG-UNION-YAZD': 'SUSPENDED' }, o.includeSelf),
    );
    h.repository.statusesUnder.mockResolvedValue(['SUSPENDED', 'DEACTIVATED']);
    h.tx.organization.update.mockResolvedValue(orgRow(DEH2));

    await runWithContext(unionContext(), () =>
      h.service.move(DEH2, { parentId: 'ORG-UNION-YAZD', reason: 'x' }),
    );
    expect(h.repository.rewriteSubtreePath).toHaveBeenCalledTimes(1);
  });

  it('reports the previous parent read under the lock', async () => {
    const h = harness();
    h.tx.organization.update.mockResolvedValue(orgRow(DEH2, { parentId: PROVINCE }));

    await runWithContext(unionContext(), () =>
      h.service.move(DEH2, { parentId: PROVINCE, reason: 'x' }),
    );

    const event = h.enqueued.find((e) => e.eventName === ORGANIZATION_EVENTS.ORGANIZATION_MOVED);
    expect(event?.payload).toMatchObject({ previousParentId: COUNTY, newParentId: PROVINCE });
  });
});

// (c) — creation beneath a stopped ancestor
describe('creation beneath a stopped ancestor', () => {
  it.each([
    ['the parent is suspended', { [COUNTY]: 'SUSPENDED' }, COUNTY],
    ['the parent is deactivated', { [COUNTY]: 'DEACTIVATED' }, COUNTY],
    ['a grandparent is suspended', { [PROVINCE]: 'SUSPENDED' }, PROVINCE],
  ])('refuses when %s', async (_label, statuses, blockingId) => {
    const h = harness();
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) =>
      chainOf(id, statuses, o.includeSelf),
    );

    const error = await runWithContext(unionContext(), () =>
      h.service
        .create({ name: 'دهیاری تازه', type: 'DEHYARI', parentId: COUNTY, metadata: {} } as never)
        .catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).internalContext).toMatchObject({
      rule: 'ANCESTOR_NOT_ACTIVE',
      ancestorId: blockingId,
    });
    expect(h.tx.organization.create).not.toHaveBeenCalled();
    expect(h.enqueued).toEqual([]);
  });

  it('reads the parent chain under the hierarchy lock, inside the transaction', async () => {
    const h = harness();
    const order: string[] = [];
    h.repository.transaction.mockImplementation(async (fn) => {
      order.push('begin');
      return fn(h.tx as never);
    });
    h.repository.lockHierarchy.mockImplementation(async () => void order.push('lock'));
    h.repository.lockAncestorChain.mockImplementation(async (_tx, id, o) => {
      order.push('chain');
      return chainOf(id, {}, o.includeSelf);
    });
    h.tx.organization.create.mockResolvedValue(orgRow('ORG_NEW'));

    await runWithContext(unionContext(), () =>
      h.service.create({
        name: 'دهیاری تازه',
        type: 'DEHYARI',
        parentId: COUNTY,
        metadata: {},
      } as never),
    );

    expect(order).toEqual(['begin', 'lock', 'chain']);
    expect(h.repository.setPath).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      [PROVINCE, COUNTY].map(toLabel).join('.'),
    );
  });

  it('answers 404 for a parent that does not exist', async () => {
    const h = harness();
    h.repository.lockAncestorChain.mockResolvedValue([]);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.create({
          name: 'دهیاری تازه',
          type: 'DEHYARI',
          parentId: 'ORG-NOPE',
          metadata: {},
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// (e) — contact changes are state changes
describe('contacts', () => {
  const contact = {
    kind: 'FINANCIAL' as const,
    displayName: 'امور مالی',
    phone: '09120000009',
    email: 'finance@example.test',
    isPrimary: true,
  };

  it('emits ORGANIZATION_CONTACT_CHANGED in the same transaction as the insert', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.create.mockResolvedValue({ id: 'CNT_1', ...contact });

    await runWithContext(context(), () => h.service.addContact(DEH1, contact));

    expect(h.repository.transaction).toHaveBeenCalledTimes(1);
    expect(h.enqueued.map((e) => e.eventName)).toEqual([
      ORGANIZATION_EVENTS.ORGANIZATION_CONTACT_CHANGED,
    ]);
  });

  it('carries no phone number, email or name', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.create.mockResolvedValue({ id: 'CNT_1', ...contact });

    await runWithContext(context(), () => h.service.addContact(DEH1, contact));

    const serialized = JSON.stringify(h.enqueued[0]?.payload);
    expect(serialized).not.toContain(contact.phone);
    expect(serialized).not.toContain(contact.email);
    expect(serialized).not.toContain(contact.displayName);
    expect(h.enqueued[0]?.payload).toMatchObject({
      organizationId: DEH1,
      change: 'ADDED',
      kind: 'FINANCIAL',
      isPrimary: true,
      hasPhone: true,
      hasEmail: true,
    });
  });

  it('names the incumbent primary it demoted', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.findMany.mockResolvedValue([{ id: 'CNT_OLD' }]);
    h.tx.organizationContact.create.mockResolvedValue({ id: 'CNT_1', ...contact });

    await runWithContext(context(), () => h.service.addContact(DEH1, contact));

    expect(h.tx.organizationContact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['CNT_OLD'] } },
      data: { isPrimary: false },
    });
    expect(h.enqueued[0]?.payload).toMatchObject({ demotedContactIds: ['CNT_OLD'] });
  });

  it('emits nothing when the caller may not write the organization', async () => {
    const h = harness();
    await expect(
      runWithContext(context(), () => h.service.addContact(DEH2, contact)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.enqueued).toEqual([]);
  });
});

// (f) — who may set policy is configuration; an expired replacement is refused
describe('governance policy authority and validity', () => {
  const policy = {
    key: 'approval.project.required',
    value: true,
    inheritable: true,
    description: 'sample pending legal review',
  };

  const withPolicyRow = (h: Harness) =>
    h.tx.organizationPolicy.create.mockResolvedValue({
      id: 'POL_1',
      ...policy,
      effectiveFrom: new Date(0),
      effectiveTo: null,
    });

  it('honours SYSTEM_ADMIN even when the list does not name it', async () => {
    const h = harness({}, { policySetterRoles: ['UNION_ADMIN'] });
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    withPolicyRow(h);

    await expect(
      runWithContext(context({ roles: ['SYSTEM_ADMIN'] }), () =>
        h.service.setPolicy(PROVINCE, policy as never),
      ),
    ).resolves.toMatchObject({ key: policy.key });
  });

  it('admits exactly the configured roles', async () => {
    const h = harness({}, { policySetterRoles: ['SYSTEM_ADMIN'] });
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    withPolicyRow(h);

    // UNION_ADMIN was hard-coded in; configured out, it is refused.
    await expect(
      runWithContext(unionContext(), () => h.service.setPolicy(PROVINCE, policy as never)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    await expect(
      runWithContext(context({ roles: ['SYSTEM_ADMIN'] }), () =>
        h.service.setPolicy(PROVINCE, policy as never),
      ),
    ).resolves.toMatchObject({ key: policy.key });
  });

  it('confines a configured non-operator role to its own subtree', async () => {
    const h = harness({}, { policySetterRoles: ['ORGANIZATION_ADMIN'] });
    h.repository.findById.mockImplementation(async (id: string) => orgRow(id) as never);
    withPolicyRow(h);

    await expect(
      runWithContext(context(), () => h.service.setPolicy(DEH1, policy as never)),
    ).resolves.toMatchObject({ key: policy.key });

    await expect(
      runWithContext(context(), () => h.service.setPolicy(COUNTY, policy as never)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['an end date in the past', { effectiveTo: '2000-01-01T00:00:00.000Z' }],
    [
      'a backdated window that has already closed',
      { effectiveFrom: '2000-01-01T00:00:00.000Z', effectiveTo: '2001-01-01T00:00:00.000Z' },
    ],
  ])('refuses a replacement with %s, and closes nothing', async (_label, dates) => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);

    const error = await runWithContext(unionContext(), () =>
      h.service.setPolicy(PROVINCE, { ...policy, ...dates } as never).catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).internalContext).toMatchObject({
      rule: 'POLICY_ALREADY_EXPIRED',
    });
    // The value in force must survive a refused replacement.
    expect(h.tx.organizationPolicy.updateMany).not.toHaveBeenCalled();
    expect(h.enqueued).toEqual([]);
  });

  it('refuses an end date before a future start', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    const inAYear = new Date(Date.now() + 365 * 86_400_000);
    const inAMonth = new Date(Date.now() + 30 * 86_400_000);

    await expect(
      runWithContext(unionContext(), () =>
        h.service.setPolicy(PROVINCE, {
          ...policy,
          effectiveFrom: inAYear.toISOString(),
          effectiveTo: inAMonth.toISOString(),
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('accepts a future end date and stores it', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    withPolicyRow(h);
    const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString();

    await runWithContext(unionContext(), () =>
      h.service.setPolicy(PROVINCE, { ...policy, effectiveTo: inAYear } as never),
    );

    expect(h.tx.organizationPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ effectiveTo: new Date(inAYear) }),
      }),
    );
  });
});

describe('toLabel', () => {
  it('converts hyphenated identifiers into legal ltree labels', () => {
    // ltree permits only [A-Za-z0-9_], and our seed identifiers contain
    // hyphens. Without this, every path insert fails at the database.
    expect(toLabel('ORG-DEH-0001')).toBe('ORG_DEH_0001');
  });

  it('leaves an already-legal identifier untouched', () => {
    expect(toLabel('ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toBe('ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2');
  });
});

// ---------------------------------------------------------------------------
// Post-merge review of #101: authorization, locks and timelines inside the
// transaction
// ---------------------------------------------------------------------------

describe('reactivation reads the tree under the hierarchy lock', () => {
  it('takes the hierarchy lock before it reads the ancestor chain', async () => {
    // A move of this organization that has written but not committed holds
    // the hierarchy lock. Reading the chain first share-locked the *old*
    // ancestors, and the move then committed it beneath a suspended parent.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }) as never);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(DEH1));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(DEH1, { status: 'ACTIVE', reason: 'cleared' }),
    );

    const lockOrder = h.repository.lockHierarchy.mock.invocationCallOrder[0] ?? Infinity;
    const chainOrder = h.repository.lockAncestorChain.mock.invocationCallOrder[0] ?? -Infinity;
    const casOrder = h.repository.compareAndSetStatus.mock.invocationCallOrder[0] ?? -Infinity;
    expect(lockOrder).toBeLessThan(chainOrder);
    expect(chainOrder).toBeLessThan(casOrder);
  });

  it('a suspension takes no hierarchy lock — it reads no ancestors', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organization.findFirstOrThrow.mockResolvedValue(orgRow(DEH1, { status: 'SUSPENDED' }));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(DEH1, { status: 'SUSPENDED', reason: 'x' }),
    );

    expect(h.repository.lockHierarchy).not.toHaveBeenCalled();
  });
});

describe('writes are authorized inside the transaction, after the hierarchy lock', () => {
  /**
   * The tree as the pre-transaction check saw it: DEH1 beneath COUNTY. Inside
   * the transaction, after the lock, a move has committed and DEH1 is no
   * longer beneath COUNTY.
   */
  const movedAwayAfterFirstCheck = (h: Harness) => {
    let calls = 0;
    h.repository.isAncestorOf.mockImplementation(async () => ++calls === 1);
  };

  it('create: refuses when the locked chain no longer contains the caller', async () => {
    const h = harness();
    // The early check passes (DEH1 is beneath COUNTY), but the chain read under
    // the lock shows DEH1 moved beneath the union's other branch.
    h.repository.lockAncestorChain.mockResolvedValue([
      { id: PROVINCE, status: 'ACTIVE', depth: 0, path: toLabel(PROVINCE) },
      { id: 'ORG-UNION-YAZD', status: 'ACTIVE', depth: 1, path: 'x' },
      { id: DEH1, status: 'ACTIVE', depth: 2, path: 'y' },
    ]);

    const error = await runWithContext(context({ organizationId: COUNTY }), () =>
      h.service
        .create({ name: 'n', type: 'DEHYARI', metadata: {}, parentId: DEH1 } as never)
        .catch((e: unknown) => e),
    );

    expect((error as RastaError).code).toBe('NOT_FOUND');
    expect(h.tx.organization.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'update',
      (h: Harness) => h.service.update(DEH1, { name: 'renamed' } as never),
      (h: Harness) => h.tx.organization.update,
    ],
    [
      'setPolicy',
      (h: Harness) =>
        h.service.setPolicy(DEH1, {
          key: 'approval.project.required',
          value: true,
          inheritable: true,
          description: 'd',
        } as never),
      (h: Harness) => h.tx.organizationPolicy.create,
    ],
    [
      'addLocation',
      (h: Harness) => h.service.addLocation(DEH1, { kind: 'PRIMARY' } as never),
      (h: Harness) =>
        (h.tx as unknown as { organizationLocation: { create: jest.Mock } }).organizationLocation
          .create,
    ],
    [
      'addContact',
      (h: Harness) =>
        h.service.addContact(DEH1, {
          kind: 'FINANCIAL',
          displayName: 'd',
          phone: '09120000000',
          isPrimary: true,
        } as never),
      (h: Harness) => h.tx.organizationContact.create,
    ],
  ])(
    '%s: refuses when a move committed between the early check and the lock',
    async (_, act, write) => {
      const h = harness({}, { policySetterRoles: ['ORGANIZATION_ADMIN'] });
      h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
      movedAwayAfterFirstCheck(h);

      const error = await runWithContext(context({ organizationId: COUNTY }), () =>
        act(h).catch((e: unknown) => e),
      );

      expect((error as RastaError).code).toBe('NOT_FOUND');
      expect(write(h)).not.toHaveBeenCalled();
      // The second, authoritative check ran inside the transaction, after the lock.
      const lockOrder = h.repository.lockHierarchy.mock.invocationCallOrder[0] ?? Infinity;
      const checkOrder = h.repository.isAncestorOf.mock.invocationCallOrder[1] ?? -Infinity;
      expect(lockOrder).toBeLessThan(checkOrder);
      expect(h.repository.isAncestorOf.mock.calls[1]?.[2]).toBe(h.tx);
    },
  );

  it('a platform operator takes no hierarchy lock for an ordinary write', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organization.update.mockResolvedValue(orgRow(DEH1));

    await runWithContext(unionContext(), () => h.service.update(DEH1, { name: 'n' } as never));

    expect(h.repository.lockHierarchy).not.toHaveBeenCalled();
  });
});

describe('ancestors stop at the caller visible root', () => {
  it('passes the caller organization for a non-operator', async () => {
    const h = harness();
    await runWithContext(context({ organizationId: COUNTY }), () => h.service.ancestors(DEH1));
    expect(h.repository.findAncestors).toHaveBeenCalledWith(DEH1, COUNTY);
  });

  it('passes null — the whole chain — for a platform operator', async () => {
    const h = harness();
    await runWithContext(unionContext(), () => h.service.ancestors(DEH1));
    expect(h.repository.findAncestors).toHaveBeenCalledWith(DEH1, null);
  });
});

describe('policy timeline', () => {
  const setImmediate = (h: Harness) =>
    runWithContext(unionContext(), () =>
      h.service.setPolicy(PROVINCE, {
        key: 'approval.project.required',
        value: true,
        inheritable: true,
        description: 'd',
      } as never),
    );

  it('serialises on (organization, key) before reading the timeline', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    h.tx.organizationPolicy.create.mockResolvedValue({
      id: 'POL_1',
      key: 'k',
      value: true,
      inheritable: true,
      description: 'd',
      effectiveFrom: new Date(),
      effectiveTo: null,
    });

    await setImmediate(h);

    expect(h.repository.lockPolicyKey).toHaveBeenCalledWith(
      h.tx,
      PROVINCE,
      'approval.project.required',
    );
    expect(h.repository.lockPolicyKey.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.organizationPolicy.findMany.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });

  it('refuses to close a value that has not taken effect yet, and writes nothing', async () => {
    // Closing a value scheduled for next month at "now" ended it before it
    // began — effective_to < effective_from — and left two values in force.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    const scheduledFrom = new Date(Date.now() + 30 * 86_400_000);
    h.tx.organizationPolicy.findMany.mockResolvedValue([
      { id: 'POL_NOW', effectiveFrom: new Date(0), effectiveTo: scheduledFrom },
      { id: 'POL_NEXT', effectiveFrom: scheduledFrom, effectiveTo: null },
    ]);

    const error = await setImmediate(h).catch((e: unknown) => e);

    expect((error as RastaError).internalContext).toMatchObject({
      rule: 'POLICY_SCHEDULE_CONFLICT',
      scheduledPolicyId: 'POL_NEXT',
    });
    expect(h.tx.organizationPolicy.updateMany).not.toHaveBeenCalled();
    expect(h.tx.organizationPolicy.create).not.toHaveBeenCalled();
  });

  it('a database constraint violation becomes a retryable conflict, not a 500', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE) as never);
    h.tx.organizationPolicy.create.mockRejectedValue(
      new Error('conflicting key value violates exclusion constraint "ex_policy_no_overlap"'),
    );

    const error = await setImmediate(h).catch((e: unknown) => e);

    expect((error as RastaError).code).toBe('OPTIMISTIC_LOCK_FAILED');
    expect((error as RastaError).status).toBe(409);
  });
});

describe('primary contact', () => {
  const add = (h: Harness, isPrimary: boolean) =>
    runWithContext(context(), () =>
      h.service.addContact(DEH1, {
        kind: 'FINANCIAL',
        displayName: 'd',
        phone: '09120000000',
        isPrimary,
      } as never),
    );

  it('locks (organization, kind) before it reads the incumbent', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.create.mockResolvedValue({ id: 'CNT_1' });

    await add(h, true);

    expect(h.repository.lockContactKind).toHaveBeenCalledWith(h.tx, DEH1, 'FINANCIAL');
    expect(h.repository.lockContactKind.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.organizationContact.findMany.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });

  it('a non-primary contact takes no lock', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.create.mockResolvedValue({ id: 'CNT_1' });

    await add(h, false);

    expect(h.repository.lockContactKind).not.toHaveBeenCalled();
  });

  it('the partial unique index firing becomes a retryable conflict', async () => {
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1) as never);
    h.tx.organizationContact.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: 'ux_contact_primary_per_kind' },
      }),
    );

    const error = await add(h, true).catch((e: unknown) => e);

    expect((error as RastaError).code).toBe('OPTIMISTIC_LOCK_FAILED');
  });
});
