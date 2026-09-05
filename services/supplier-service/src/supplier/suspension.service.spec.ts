import { isRastaError } from '@rasta/nest-common';
import { SuspensionService } from './suspension.service';
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
 * Suspension and reinstatement, at the service level.
 *
 * The two properties worth proving here are the ones a state-machine test
 * cannot: that a suspension **withholds** a qualification rather than revoking
 * it, and that reinstating restores exactly what was approved before with no
 * new decision. Both are what make suspension reversible without a reviewer
 * having to re-approve anything.
 */

function harness(supplier: FakeSupplier = aSupplier()) {
  const prisma = new FakePrisma();
  const repository = new FakeRepository();
  const events = new FakeEvents(prisma);
  repository.add(supplier);

  return {
    prisma,
    repository,
    supplier,
    service: new SuspensionService(
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
});

// ---------------------------------------------------------------------------

describe('who may suspend', () => {
  it('lets a platform operator from another organization suspend', async () => {
    const h = harness();

    const suspended = await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'Two buyers reported undelivered orders' }),
    );

    expect(suspended.status).toBe('SUSPENDED');
    expect(suspended.suspensions[0].open).toBe(true);
  });

  it('refuses the supplier suspending itself', async () => {
    const h = harness();

    expect(
      await codeOf(() => asOwner(() => h.service.suspend('SUP_1', { reason: 'A stated reason' }))),
    ).toBe('FORBIDDEN');
    expect(h.supplier.status).toBe('ACTIVE');
  });

  it.each(['UNION_ADMIN', 'SYSTEM_ADMIN'])(
    'refuses a %s belonging to the supplier organization',
    async (role) => {
      const h = harness();

      expect(
        await codeOf(() =>
          asRole(SUPPLIER_ORG, [role], () =>
            h.service.suspend('SUP_1', { reason: 'A stated reason' }),
          ),
        ),
      ).toBe('FORBIDDEN');
      expect(h.supplier.status).toBe('ACTIVE');
    },
  );

  it('refuses the oversight role', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asRole(OTHER_ORG, ['AUDITOR'], () =>
          h.service.suspend('SUP_1', { reason: 'A stated reason' }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('answers 404 for an unknown supplier', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () => h.service.suspend('SUP_NOPE', { reason: 'A stated reason' })),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('SUPPLIER_SUSPENDED', () => {
  it('is published in the same transaction as the status change', async () => {
    const h = harness();

    await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'Two buyers reported undelivered orders' }),
    );

    expect(h.prisma.committed).toHaveLength(1);
    const event = h.prisma.committed[0];
    expect(event.eventName).toBe('SUPPLIER_SUSPENDED');
    expect(event.payload.supplierId).toBe('SUP_1');
    expect(event.payload.reason).toBe('Two buyers reported undelivered orders');
  });

  it('carries `until` as null — a suspension runs until an explicit reinstatement', async () => {
    const h = harness();

    await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'A stated reason for the record' }),
    );

    expect(h.prisma.committed[0].payload.until).toBeNull();
  });

  it('publishes nothing when the suspension loses its race', async () => {
    const h = harness();
    h.repository.raceOn = 'suspend';

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () =>
          h.service.suspend('SUP_1', { reason: 'A stated reason for the record' }),
        ),
      ),
    ).toBe('BUSINESS_RULE_VIOLATION');
    expect(h.prisma.committed).toEqual([]);
  });
});

describe('suspension withholds, it does not revoke', () => {
  it('empties qualifiedFor while leaving the approval row intact', async () => {
    const h = harness(aSupplier({ qualifications: [APPROVED] }));

    const suspended = await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'A stated reason for the record' }),
    );

    expect(suspended.qualifiedFor).toEqual([]);
    // The decision that was made is still the decision that was made.
    expect(suspended.qualifications[0].state).toBe('APPROVED');
    expect(suspended.qualifications[0].decidedBy).toBe('USR_OPERATOR');
    expect(suspended.qualifications[0].current).toBe(false);
  });

  it('restores the approval on reinstatement with no new decision', async () => {
    const h = harness(aSupplier({ qualifications: [APPROVED] }));

    await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'A stated reason for the record' }),
    );

    const reinstated = await asOperatorOf(OTHER_ORG, () =>
      h.service.reinstate('SUP_1', { reason: 'The orders were delivered late, not never' }),
    );

    expect(reinstated.status).toBe('ACTIVE');
    expect(reinstated.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
    expect(reinstated.qualifications[0].current).toBe(true);
    // Nobody approved anything a second time.
    expect(reinstated.qualifications[0].decidedAt).toBe(APPROVED.decidedAt?.toISOString());
  });
});

describe('reinstating', () => {
  async function suspended() {
    const h = harness(aSupplier({ qualifications: [APPROVED] }));
    await asOperatorOf(OTHER_ORG, () =>
      h.service.suspend('SUP_1', { reason: 'A stated reason for the record' }),
    );
    h.prisma.committed.length = 0;
    return h;
  }

  it('stamps the episode rather than deleting it', async () => {
    // A reinstatement that removed the row would erase the record of who
    // suspended the supplier and why — the question an audit actually asks.
    const h = await suspended();

    const reinstated = await asOperatorOf(OTHER_ORG, () =>
      h.service.reinstate('SUP_1', { reason: 'The orders were delivered late, not never' }),
    );

    expect(reinstated.suspensions).toHaveLength(1);
    expect(reinstated.suspensions[0].open).toBe(false);
    expect(reinstated.suspensions[0].suspendedBy).toBe('USR_OPERATOR');
    expect(reinstated.suspensions[0].reinstatementNote).toBe(
      'The orders were delivered late, not never',
    );
  });

  it('publishes nothing — the platform catalogue names no SUPPLIER_REINSTATED', async () => {
    // A consumer that hid this supplier on SUPPLIER_SUSPENDED has no event
    // telling it to stop and must re-read the service. Asserted so the gap is
    // visible in the suite rather than only in a comment.
    const h = await suspended();

    await asOperatorOf(OTHER_ORG, () =>
      h.service.reinstate('SUP_1', { reason: 'The orders were delivered late, not never' }),
    );

    expect(h.prisma.committed).toEqual([]);
  });

  it('refuses the supplier reinstating itself', async () => {
    const h = await suspended();

    expect(
      await codeOf(() =>
        asOwner(() => h.service.reinstate('SUP_1', { reason: 'Lifting my own suspension' })),
      ),
    ).toBe('FORBIDDEN');
    expect(h.supplier.status).toBe('SUSPENDED');
  });

  it('refuses reinstating a supplier that is not suspended', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () =>
          h.service.reinstate('SUP_1', { reason: 'Nothing to lift here at all' }),
        ),
      ),
    ).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refuses suspending a supplier that is already suspended', async () => {
    const h = await suspended();

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () =>
          h.service.suspend('SUP_1', { reason: 'A second stated reason' }),
        ),
      ),
    ).toBe('BUSINESS_RULE_VIOLATION');
  });
});
