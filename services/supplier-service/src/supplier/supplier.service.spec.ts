import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { SupplierService } from './supplier.service';
import {
  aQualification,
  aSupplier,
  asOperatorOf,
  asOwner,
  asRole,
  FakeEvents,
  FakePrisma,
  FakeRepository,
  OTHER_ORG,
  SUPPLIER_ORG,
  type FakeSupplier,
} from './service-fakes';

/**
 * Registration and the two directory queries.
 *
 * The directory is the only place this service deliberately crosses a tenant
 * boundary, so the assertions that matter most here are about what a stranger
 * gets back rather than whether they get anything: the projection, and the fact
 * that a suspended supplier is filtered out in the query rather than in the page.
 */

function harness(seed: FakeSupplier[] = []) {
  const prisma = new FakePrisma();
  const repository = new FakeRepository();
  const events = new FakeEvents(prisma);
  for (const supplier of seed) repository.add(supplier);

  return {
    prisma,
    repository,
    service: new SupplierService(
      prisma.asPrismaService(),
      repository.asRepository(),
      events.asEventPublisher(),
    ),
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isRastaError(error)) return error.code;
    return `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

const APPROVED = aQualification({
  state: 'APPROVED',
  decidedBy: 'USR_OPERATOR',
  decidedAt: new Date('2026-03-01T00:00:00.000Z'),
  decisionNote: 'Called the referee listed on the licence',
  evidence: [{ documentId: 'DOC_PRIVATE', label: 'Trade licence' }],
});

// ---------------------------------------------------------------------------

describe('registering', () => {
  it('takes the organization from the token, never from the body', async () => {
    const h = harness();

    const supplier = await asOwner(() =>
      h.service.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );

    expect(supplier.organizationId).toBe(SUPPLIER_ORG);
    expect(supplier.registeredBy).toBe('USR_OWNER');
  });

  it('grants nothing — a new profile is qualified for nothing', async () => {
    const h = harness();

    const supplier = await asOwner(() =>
      h.service.register({
        displayName: 'A workshop',
        capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
      }),
    );

    expect(supplier.capabilities).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE']);
    expect(supplier.qualifiedFor).toEqual([]);
    expect(supplier.qualifications).toEqual([]);
  });

  it('publishes SUPPLIER_REGISTERED in the same transaction', async () => {
    const h = harness();

    const supplier = await asOwner(() =>
      h.service.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );

    expect(h.prisma.committed).toHaveLength(1);
    const event = h.prisma.committed[0];
    expect(event.eventName).toBe('SUPPLIER_REGISTERED');
    expect(event.aggregateId).toBe(supplier.id);
    // Claimed, not qualified — and the payload names the field that way.
    expect(event.payload.capabilities).toEqual(['WORKSHOP_SERVICE']);
    expect(event.payload).not.toHaveProperty('qualifiedFor');
  });

  it('answers 409 for a second profile, and publishes nothing', async () => {
    // A 409 rather than returning the existing row: quietly handing back a
    // profile somebody else in the organization created would hide that the
    // second registration did nothing.
    const h = harness();
    await asOwner(() =>
      h.service.register({ displayName: 'First', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    h.prisma.committed.length = 0;

    expect(
      await codeOf(() =>
        asOwner(() =>
          h.service.register({ displayName: 'Second', capabilities: ['GOODS_SUPPLY'] }),
        ),
      ),
    ).toBe('ALREADY_EXISTS');
    expect(h.prisma.committed).toEqual([]);
  });

  it('refuses a platform operator registering a supplier', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () =>
          h.service.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses a token that names no user', async () => {
    const h = harness();

    const withoutUser = () =>
      runWithContext(
        {
          requestId: 'req-1',
          correlationId: 'corr-1',
          authType: 'USER',
          roles: ['SUPPLIER'],
          organizationId: SUPPLIER_ORG,
          startedAt: 0,
        } as RequestContext,
        () => h.service.register({ displayName: 'A workshop', capabilities: ['GOODS_SUPPLY'] }),
      );

    expect(await codeOf(withoutUser)).toBe('FORBIDDEN');
  });
});

describe('reading one profile', () => {
  const seeded = () => harness([aSupplier({ qualifications: [APPROVED] })]);

  it('gives the owning organization the private record', async () => {
    const h = seeded();

    const supplier = await asOwner(() => h.service.get('SUP_1'));

    expect(supplier.qualifications[0].decisionNote).toContain('referee');
    expect(supplier.qualifications[0].evidence[0].documentId).toBe('DOC_PRIVATE');
  });

  it('gives a platform operator the private record, in order to review it', async () => {
    const h = seeded();

    await expect(asOperatorOf(OTHER_ORG, () => h.service.get('SUP_1'))).resolves.toMatchObject({
      id: 'SUP_1',
    });
  });

  it('answers 404 for another tenant', async () => {
    const h = seeded();

    expect(await codeOf(() => asRole(OTHER_ORG, ['SUPPLIER'], () => h.service.get('SUP_1')))).toBe(
      'NOT_FOUND',
    );
  });

  it('answers 404 for an id that does not exist, in the same shape', async () => {
    // So a stranger cannot tell "missing" from "not yours" by comparing the two.
    const h = seeded();

    expect(await codeOf(() => asOwner(() => h.service.get('SUP_NOPE')))).toBe('NOT_FOUND');
  });

  it('refuses the oversight role', async () => {
    const h = seeded();

    expect(
      await codeOf(() => asRole(SUPPLIER_ORG, ['AUDITOR'], () => h.service.get('SUP_1'))),
    ).toBe('FORBIDDEN');
  });
});

describe('the directory', () => {
  function seeded() {
    return harness([
      aSupplier({ id: 'SUP_1', organizationId: SUPPLIER_ORG, qualifications: [APPROVED] }),
      aSupplier({
        id: 'SUP_2',
        organizationId: 'ORG-SECOND',
        displayName: 'A goods supplier',
        capabilities: [{ capability: 'GOODS_SUPPLY' }],
        qualifications: [],
      }),
    ]);
  }

  it('lets a caller from another organization find a supplier', async () => {
    const h = seeded();

    const page = await asRole(OTHER_ORG, ['PROCUREMENT_USER'], () =>
      h.service.search({ limit: 25 }),
    );

    expect(page.items.map((item) => item.id).sort()).toEqual(['SUP_1', 'SUP_2']);
  });

  it('returns the catalogue-safe projection and nothing more', async () => {
    const h = seeded();

    const page = await asRole(OTHER_ORG, ['PROCUREMENT_USER'], () =>
      h.service.search({ limit: 25 }),
    );
    const serialised = JSON.stringify(page.items);

    expect(serialised).not.toContain('DOC_PRIVATE');
    expect(serialised).not.toContain('referee');
    expect(serialised).not.toContain('USR_OPERATOR');
    expect(serialised).not.toContain('QLF_1');
  });

  it('refuses a role with no reason to browse it', async () => {
    const h = seeded();

    expect(
      await codeOf(() => asRole(OTHER_ORG, ['DRIVER'], () => h.service.search({ limit: 25 }))),
    ).toBe('FORBIDDEN');
  });

  it('refuses the oversight role', async () => {
    const h = seeded();

    expect(
      await codeOf(() => asRole(OTHER_ORG, ['AUDITOR'], () => h.service.search({ limit: 25 }))),
    ).toBe('FORBIDDEN');
  });

  it('filters by claimed capability', async () => {
    const h = seeded();

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.search({ capability: 'GOODS_SUPPLY', limit: 25 }),
    );

    expect(page.items.map((item) => item.id)).toEqual(['SUP_2']);
  });

  it('pages with a cursor rather than an offset', async () => {
    // The set grows, and an offset silently skips or duplicates rows when it
    // does (packages/contracts pagination).
    const h = seeded();

    const first = await asOperatorOf(OTHER_ORG, () => h.service.search({ limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('SUP_1');

    const second = await asOperatorOf(OTHER_ORG, () =>
      h.service.search({ limit: 1, cursor: first.nextCursor as string }),
    );
    expect(second.items.map((item) => item.id)).toEqual(['SUP_2']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});

describe('ListQualifiedFor', () => {
  function seeded(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    return harness([aSupplier({ status, qualifications: [APPROVED] })]);
  }

  it('returns a supplier with a current approval', async () => {
    const h = seeded();

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 }),
    );

    expect(page.items.map((item) => item.id)).toEqual(['SUP_1']);
    expect(page.items[0].qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
  });

  it('excludes a suspended supplier', async () => {
    // Filtered in the query, before pagination — filtering the page afterwards
    // would return short pages and, past the first, drop rows entirely.
    const h = seeded('SUSPENDED');

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 }),
    );

    expect(page.items).toEqual([]);
  });

  it('excludes a supplier whose submission is still awaiting a decision', async () => {
    const h = harness([aSupplier({ qualifications: [aQualification()] })]);

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 }),
    );

    expect(page.items).toEqual([]);
  });

  it('excludes a supplier that was rejected', async () => {
    const h = harness([
      aSupplier({
        qualifications: [
          aQualification({
            state: 'REJECTED',
            decidedBy: 'USR_OPERATOR',
            decidedAt: new Date('2026-03-01T00:00:00.000Z'),
          }),
        ],
      }),
    ]);

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 }),
    );

    expect(page.items).toEqual([]);
  });

  it('carries no private material to the caller', async () => {
    const h = seeded();

    const page = await asOperatorOf(OTHER_ORG, () =>
      h.service.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 }),
    );

    expect(JSON.stringify(page.items)).not.toContain('DOC_PRIVATE');
  });
});
