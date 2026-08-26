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

function harness(overrides: Partial<jest.Mocked<OrganizationRepository>> = {}): Harness {
  const enqueued: Array<{ eventName: string; payload: unknown }> = [];

  const tx = {
    organization: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    organizationPolicy: { create: jest.fn(), updateMany: jest.fn() },
    organizationLocation: { create: jest.fn() },
    organizationContact: { create: jest.fn(), updateMany: jest.fn() },
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
    idsUnderPath: jest.fn(async () => []),
    findNearby: jest.fn(async () => []),
    setLocationPoint: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<OrganizationRepository>;

  return { service: new OrganizationService(repository, 8), repository, enqueued };
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

    // A non-operator must always be passed a root path to restrict against;
    // null here would mean "show everything".
    expect(h.repository.list).toHaveBeenCalledWith(expect.anything(), toLabel(DEH1));
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
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(DEH1, { depth: 8 }) as never);

    const error = await runWithContext(unionContext(), () =>
      h.service
        .create({ name: 'خیلی عمیق', type: 'DEHYARI', parentId: DEH1, metadata: {} } as never)
        .catch((e) => e),
    );

    expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((error as RastaError).message).toMatch(/8 levels/);
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
  it('refuses a policy change from a non-operator', async () => {
    // Policies decide who may approve what, so this stays an operator action
    // even inside your own subtree (ADR-023).
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
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('closes the previous value rather than overwriting it', async () => {
    // A governance decision taken last year must stay reconstructible.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(PROVINCE, { depth: 0 }) as never);
    const client = h.repository.client as unknown as {
      organizationPolicy: { create: jest.Mock; updateMany: jest.Mock };
    };
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
      expect.objectContaining({ where: expect.objectContaining({ effectiveTo: null }) }),
    );
    expect(h.enqueued.map((e) => e.eventName)).toContain(
      ORGANIZATION_EVENTS.ORGANIZATION_POLICY_CHANGED,
    );
  });
});

describe('status changes', () => {
  it('cascades suspension to the whole subtree', async () => {
    // Leaving a dehyari active beneath a suspended parent would let it keep
    // transacting through an organization that is meant to be stopped.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY, { depth: 1 }) as never);
    h.repository.findSubtree.mockResolvedValue([
      { id: COUNTY },
      { id: DEH1 },
      { id: DEH2 },
    ] as never);
    const client = h.repository.client as unknown as {
      organization: { updateMany: jest.Mock; findFirstOrThrow: jest.Mock };
    };
    client.organization.findFirstOrThrow.mockResolvedValue(orgRow(COUNTY, { status: 'SUSPENDED' }));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(COUNTY, { status: 'SUSPENDED', reason: 'under investigation' }),
    );

    expect(client.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [COUNTY, DEH1, DEH2] } }),
      }),
    );

    const event = h.enqueued.find(
      (e) => e.eventName === ORGANIZATION_EVENTS.ORGANIZATION_STATUS_CHANGED,
    );
    expect((event?.payload as { affectedIds: string[] }).affectedIds).toHaveLength(3);
  });

  it('does not cascade a return to ACTIVE', async () => {
    // Reactivating a parent must not silently reactivate children that were
    // suspended for their own separate reasons.
    const h = harness();
    h.repository.findById.mockResolvedValue(orgRow(COUNTY, { status: 'SUSPENDED' }) as never);
    const client = h.repository.client as unknown as {
      organization: { updateMany: jest.Mock; findFirstOrThrow: jest.Mock };
    };
    client.organization.findFirstOrThrow.mockResolvedValue(orgRow(COUNTY));

    await runWithContext(unionContext(), () =>
      h.service.changeStatus(COUNTY, { status: 'ACTIVE', reason: 'cleared' }),
    );

    expect(h.repository.findSubtree).not.toHaveBeenCalled();
    expect(client.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [COUNTY] } }) }),
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
