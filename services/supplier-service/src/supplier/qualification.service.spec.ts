import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { QualificationService } from './qualification.service';
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
} from './service-fakes';

/**
 * Qualification submission and decision, at the service level.
 *
 * `access.spec.ts` proves the individual checks. This proves the service
 * **applies** them, in the right order, before anything is written — which is a
 * different claim, and the one that would actually break if somebody wired a
 * command to the wrong gate.
 *
 * It also proves the two properties that only exist at this level: that the
 * reviewer's private note never reaches the event payload, and that a lost race
 * publishes nothing.
 */

function harness(supplier = aSupplier()) {
  const prisma = new FakePrisma();
  const repository = new FakeRepository();
  const events = new FakeEvents(prisma);
  repository.add(supplier);

  return {
    prisma,
    repository,
    supplier,
    service: new QualificationService(
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

// ---------------------------------------------------------------------------

describe('submitting', () => {
  it('lets the supplier organization submit for itself', async () => {
    const h = harness();

    const submitted = await asOwner(() =>
      h.service.submit('SUP_1', {
        capability: 'WORKSHOP_SERVICE',
        evidence: [{ documentId: 'DOC_1', label: 'Trade licence' }],
      }),
    );

    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.current).toBe(false);
    expect(submitted.evidence[0].documentId).toBe('DOC_1');
  });

  it('publishes nothing — a submission is not a platform fact', async () => {
    // Publishing one would put an organization's in-progress application on a
    // topic every service on the platform reads.
    const h = harness();

    await asOwner(() =>
      h.service.submit('SUP_1', { capability: 'WORKSHOP_SERVICE', evidence: [] }),
    );

    expect(h.prisma.committed).toEqual([]);
  });

  it('refuses a submission from another organization with 404', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asRole(OTHER_ORG, ['SUPPLIER'], () =>
          h.service.submit('SUP_1', { capability: 'WORKSHOP_SERVICE', evidence: [] }),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses a platform operator submitting on the supplier behalf', async () => {
    // The submitter would be the person who approves it, and the self-approval
    // check further down would have nothing left to catch.
    const h = harness();

    expect(
      await codeOf(() =>
        asOperatorOf(OTHER_ORG, () =>
          h.service.submit('SUP_1', { capability: 'WORKSHOP_SERVICE', evidence: [] }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses a second submission while one awaits a decision', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    expect(
      await codeOf(() =>
        asOwner(() => h.service.submit('SUP_1', { capability: 'WORKSHOP_SERVICE', evidence: [] })),
      ),
    ).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refuses a submission for an unknown supplier with 404', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asOwner(() => h.service.submit('SUP_NOPE', { capability: 'GOODS_SUPPLY', evidence: [] })),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('a supplier can never decide its own case', () => {
  it('refuses the supplier organization approving itself', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    expect(await codeOf(() => asOwner(() => h.service.approve('SUP_1', 'QLF_1', {})))).toBe(
      'FORBIDDEN',
    );
  });

  it.each(['UNION_ADMIN', 'SYSTEM_ADMIN'])(
    'refuses a %s who belongs to the supplier organization',
    async (role) => {
      // The case only the row can catch. This person holds a real operator role
      // and really belongs to the supplier's organization, so every role check
      // they face passes.
      const h = harness(aSupplier({ qualifications: [aQualification()] }));

      expect(
        await codeOf(() =>
          asRole(SUPPLIER_ORG, [role], () => h.service.approve('SUP_1', 'QLF_1', {})),
        ),
      ).toBe('FORBIDDEN');
    },
  );

  it('writes nothing and publishes nothing when it refuses', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    await codeOf(() => asOwner(() => h.service.approve('SUP_1', 'QLF_1', {})));

    expect(h.supplier.qualifications[0].state).toBe('SUBMITTED');
    expect(h.supplier.qualifications[0].decidedBy).toBeNull();
    expect(h.prisma.committed).toEqual([]);
  });

  it('refuses the supplier rejecting its own submission too', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    expect(
      await codeOf(() =>
        asOwner(
          () => h.service.reject('SUP_1', 'QLF_1', { reason: 'A convenient refusal' }),
          ['ORGANIZATION_ADMIN'],
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('approving', () => {
  it('records the decision and publishes SUPPLIER_QUALIFIED', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    const approved = await asOperatorOf(OTHER_ORG, () =>
      h.service.approve('SUP_1', 'QLF_1', { note: 'Called the referee listed on the licence' }),
    );

    expect(approved.state).toBe('APPROVED');
    expect(approved.current).toBe(true);
    expect(approved.decidedBy).toBe('USR_OPERATOR');
    expect(approved.decidedAt).toBeTruthy();

    expect(h.prisma.committed).toHaveLength(1);
    const event = h.prisma.committed[0];
    expect(event.eventName).toBe('SUPPLIER_QUALIFIED');
    // The aggregate is the qualification; the stream is the supplier.
    expect(event.aggregateId).toBe('QLF_1');
    expect(event.payload.supplierId).toBe('SUP_1');
    expect(event.payload.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
  });

  it("never publishes the reviewer's private note", async () => {
    // It is written for the platform's own record, and a seven-day log every
    // service reads is not where it belongs.
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    await asOperatorOf(OTHER_ORG, () =>
      h.service.approve('SUP_1', 'QLF_1', { note: 'Called the referee listed on the licence' }),
    );

    expect(JSON.stringify(h.prisma.committed)).not.toContain('referee');
  });

  it('never publishes an evidence document identifier', async () => {
    const h = harness(
      aSupplier({
        qualifications: [
          aQualification({ evidence: [{ documentId: 'DOC_PRIVATE', label: 'Licence' }] }),
        ],
      }),
    );

    await asOperatorOf(OTHER_ORG, () => h.service.approve('SUP_1', 'QLF_1', {}));

    expect(JSON.stringify(h.prisma.committed)).not.toContain('DOC_PRIVATE');
  });

  it('refuses re-deciding a decided qualification, and publishes nothing', async () => {
    const h = harness(
      aSupplier({
        qualifications: [
          aQualification({
            state: 'REJECTED',
            decidedBy: 'USR_OPERATOR',
            decidedAt: new Date('2026-03-01T00:00:00.000Z'),
          }),
        ],
      }),
    );

    expect(
      await codeOf(() => asOperatorOf(OTHER_ORG, () => h.service.approve('SUP_1', 'QLF_1', {}))),
    ).toBe('BUSINESS_RULE_VIOLATION');
    expect(h.prisma.committed).toEqual([]);
  });

  it("refuses deciding a qualification through another supplier's id", async () => {
    // Otherwise a caller could slip past the self-judgement check by naming an
    // unrelated profile in the path while acting on this qualification.
    const h = harness(aSupplier({ qualifications: [aQualification()] }));
    h.repository.add(aSupplier({ id: 'SUP_2', organizationId: OTHER_ORG, qualifications: [] }));

    expect(
      await codeOf(() =>
        asRole('ORG-THIRD', ['UNION_ADMIN'], () => h.service.approve('SUP_2', 'QLF_1', {})),
      ),
    ).toBe('NOT_FOUND');
  });

  it('publishes nothing when the decision loses its race', async () => {
    // `recordDecision` returns zero, the service throws inside the transaction,
    // and the event rolls back with it.
    const h = harness(aSupplier({ qualifications: [aQualification()] }));
    h.repository.raceOn = 'decision';

    expect(
      await codeOf(() => asOperatorOf(OTHER_ORG, () => h.service.approve('SUP_1', 'QLF_1', {}))),
    ).toBe('BUSINESS_RULE_VIOLATION');
    expect(h.prisma.committed).toEqual([]);
  });

  it('refuses a caller whose token names no user, and writes nothing', async () => {
    // Every mutation records an actor (AGENTS.md S-06) and the database refuses
    // a blank one, so a request that cannot name a human is refused here with an
    // explanation rather than at the constraint with a driver error.
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    const withoutUser = () =>
      runWithContext(
        {
          requestId: 'req-1',
          correlationId: 'corr-1',
          authType: 'USER',
          roles: ['UNION_ADMIN'],
          organizationId: OTHER_ORG,
          startedAt: 0,
        } as RequestContext,
        () => h.service.approve('SUP_1', 'QLF_1', {}),
      );

    expect(await codeOf(withoutUser)).toBe('FORBIDDEN');
    expect(h.supplier.qualifications[0].state).toBe('SUBMITTED');
    expect(h.prisma.committed).toEqual([]);
  });
});

describe('rejecting', () => {
  it('publishes the stated reason so the supplier can act on it', async () => {
    const h = harness(aSupplier({ qualifications: [aQualification()] }));

    const rejected = await asOperatorOf(OTHER_ORG, () =>
      h.service.reject('SUP_1', 'QLF_1', {
        reason: 'The submission named no capability evidence',
        note: 'Third attempt from this organization',
      }),
    );

    expect(rejected.state).toBe('REJECTED');
    expect(rejected.current).toBe(false);

    const event = h.prisma.committed[0];
    expect(event.eventName).toBe('SUPPLIER_REJECTED');
    expect(event.payload.reason).toBe('The submission named no capability evidence');
    expect(event.payload.rejectedFor).toEqual(['WORKSHOP_SERVICE']);
    // The private note is not the published reason.
    expect(JSON.stringify(event)).not.toContain('Third attempt');
  });
});

describe('the review queue', () => {
  it('is refused to a supplier-side caller', async () => {
    const h = harness();

    expect(
      await codeOf(() => asOwner(() => h.service.reviewQueue({ state: 'SUBMITTED', limit: 25 }))),
    ).toBe('FORBIDDEN');
  });

  it('is refused to the oversight role', async () => {
    const h = harness();

    expect(
      await codeOf(() =>
        asRole(OTHER_ORG, ['AUDITOR'], () =>
          h.service.reviewQueue({ state: 'SUBMITTED', limit: 25 }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});
