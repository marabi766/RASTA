import {
  createTenantGuardExtension,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import {
  TENANT_SCOPED_MODELS,
  type ExtendedPrismaClient,
  type PrismaService,
} from '../prisma/prisma.service';
import { SupplierRepository } from './supplier.repository';
import { asOperatorOf, asOwner, OTHER_ORG, SUPPLIER_ORG } from './service-fakes';

/**
 * The writes a platform operator makes about **somebody else's** supplier.
 *
 * ## Why this suite exists separately from the service suites
 *
 * `qualification.service.spec.ts` and `suspension.service.spec.ts` inject the
 * in-memory `FakeRepository`, so the real repository — and therefore the tenant
 * guard the real client carries — never runs in them. That is the right trade
 * for testing the *order of the checks*, and it is exactly why they cannot see
 * this: the guard rewrites the query after the service has finished deciding,
 * and it rewrites it with the **caller's** organization.
 *
 * Deciding is the one thing in this service done by somebody from another
 * tenant, and `assertCanDecideAbout` guarantees it: a platform operator from the
 * supplier's own organization is refused outright. So on every path that reaches
 * the three methods below, the row's `organizationId` is by construction not the
 * caller's, and a guard that scopes them to the caller matches nothing.
 *
 * ## What this suite is not
 *
 * It does not touch PostgreSQL and does not pretend to. It asserts only what a
 * JavaScript client extension does to the arguments before they leave the
 * process — a property of `@rasta/nest-common` and of this file's call shapes,
 * not of the database. Whether the resulting statement finds its row, whether
 * the two writes commit atomically, and whether `ux_suspension_open` refuses a
 * second episode remain integration questions, asserted in
 * `test/supplier-lifecycle.int-spec.ts` and unrun.
 */

/** Prisma delegate name → model name, as the generated client pairs them. */
const MODEL_OF: Readonly<Record<string, string>> = {
  supplier: 'Supplier',
  supplierCapability: 'SupplierCapability',
  qualification: 'Qualification',
  qualificationEvidence: 'QualificationEvidence',
  suspension: 'Suspension',
  outboxMessage: 'OutboxMessage',
};

const OPERATIONS = [
  'create',
  'createMany',
  'findUnique',
  'findFirst',
  'findMany',
  'update',
  'updateMany',
  'count',
  'deleteMany',
] as const;

const DEFAULT_REPLY: Readonly<Record<string, unknown>> = {
  create: {},
  createMany: { count: 1 },
  findUnique: null,
  findFirst: null,
  findMany: [],
  update: {},
  updateMany: { count: 1 },
  count: 0,
  deleteMany: { count: 0 },
};

interface RecordedCall {
  model: string;
  operation: string;
  args: Record<string, unknown>;
}

/**
 * A client that runs **the real tenant guard** and records what reaches the
 * driver.
 *
 * The extension is the platform's own, built from this service's own
 * `TENANT_SCOPED_MODELS`, so a model quietly dropped from that list would change
 * these results. Only the driver underneath is a stand-in, and it does nothing
 * but record.
 */
function guardedClient(replies: Readonly<Record<string, unknown>> = {}): {
  tx: ExtendedPrismaClient;
  calls: RecordedCall[];
} {
  const guard = createTenantGuardExtension({ scopedModels: TENANT_SCOPED_MODELS });
  const calls: RecordedCall[] = [];
  const client: Record<string, Record<string, unknown>> = {};

  for (const [delegate, model] of Object.entries(MODEL_OF)) {
    const operations: Record<string, unknown> = {};

    for (const operation of OPERATIONS) {
      operations[operation] = (args: Record<string, unknown> = {}) =>
        guard.query.$allModels.$allOperations({
          model,
          operation,
          args,
          query: async (finalArgs: Record<string, unknown>) => {
            calls.push({ model, operation, args: finalArgs });
            return replies[`${delegate}.${operation}`] ?? DEFAULT_REPLY[operation];
          },
        });
    }

    client[delegate] = operations;
  }

  return { tx: client as unknown as ExtendedPrismaClient, calls };
}

function signatures(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => `${call.model}.${call.operation}`);
}

/**
 * A platform operator belonging to no organization at all.
 *
 * `SYSTEM_ADMIN` acting platform-wide is exactly this: `AuthGuard` resolves no
 * tenant when the token carries none, and `getOrganizationId()` then throws a
 * raw `Error` — a 500 rather than a refusal. A decision path that reaches the
 * tenant guard therefore fails differently for this operator than for one who
 * happens to belong somewhere, which is a difference no product rule asks for.
 */
function asPlatformOperator<T>(fn: () => T): T {
  return runWithContext(
    {
      requestId: 'req-1',
      correlationId: 'corr-1',
      authType: 'USER',
      userId: 'USR_PLATFORM',
      roles: ['SYSTEM_ADMIN'],
      startedAt: 0,
    } as RequestContext,
    fn,
  );
}

const repository = new SupplierRepository({} as PrismaService);

const A_DECISION = {
  qualificationId: 'QLF_1',
  state: 'APPROVED',
  decidedBy: 'USR_OPERATOR',
  decidedAt: new Date('2026-03-01T00:00:00.000Z'),
  decidedCorrelationId: 'corr-1',
  decisionNote: null,
} as const;

describe('the guarded client this suite runs against', () => {
  it('really does apply the tenant guard, so the expectations below are not vacuous', async () => {
    const { tx, calls } = guardedClient();

    await asOwner(() =>
      (
        tx as unknown as { supplier: { findMany: (args: object) => Promise<unknown> } }
      ).supplier.findMany({ where: { status: 'ACTIVE' } }),
    );

    expect(calls[0]?.args.where).toEqual({ status: 'ACTIVE', organizationId: SUPPLIER_ORG });
  });
});

describe('recording a qualification decision', () => {
  it('matches the qualification itself, not one the deciding operator happens to own', async () => {
    const { tx, calls } = guardedClient();

    const changed = await asOperatorOf(OTHER_ORG, () => repository.recordDecision(tx, A_DECISION));

    expect(changed).toBe(1);
    // No `organizationId` in the predicate. The qualification belongs to the
    // supplier, and `assertCanDecideAbout` has already refused every caller who
    // does.
    expect(calls[0]?.args.where).toEqual({ id: 'QLF_1', state: 'SUBMITTED' });
  });

  it('does not require the deciding operator to belong to any organization', async () => {
    const { tx } = guardedClient();

    await expect(asPlatformOperator(() => repository.recordDecision(tx, A_DECISION))).resolves.toBe(
      1,
    );
  });
});

describe('opening a suspension episode', () => {
  const AN_EPISODE = {
    id: 'SSP_1',
    supplierId: 'SUP_1',
    organizationId: SUPPLIER_ORG,
    reason: 'Repeated failure to deliver against accepted orders',
    suspendedBy: 'USR_OPERATOR',
    suspendedCorrelationId: 'corr-1',
  } as const;

  it('flips the suspended supplier and stamps the episode with the supplier organization', async () => {
    const { tx, calls } = guardedClient();

    const opened = await asOperatorOf(OTHER_ORG, () => repository.openSuspension(tx, AN_EPISODE));

    expect(opened).toBe(1);
    expect(signatures(calls)).toEqual(['Supplier.updateMany', 'Suspension.create']);
    expect(calls[0]?.args.where).toEqual({ id: 'SUP_1', status: 'ACTIVE' });
    // The episode belongs to the supplier that was suspended, never to the
    // operator who suspended it: that is what keeps the history readable as the
    // supplier's own record.
    expect(calls[1]?.args.data).toMatchObject({ organizationId: SUPPLIER_ORG });
  });

  it('does not require the suspending operator to belong to any organization', async () => {
    const { tx } = guardedClient();

    await expect(asPlatformOperator(() => repository.openSuspension(tx, AN_EPISODE))).resolves.toBe(
      1,
    );
  });
});

describe('closing a suspension episode', () => {
  const A_REINSTATEMENT = {
    supplierId: 'SUP_1',
    reinstatedBy: 'USR_OPERATOR',
    reinstatedAt: new Date('2026-04-01T00:00:00.000Z'),
    reinstatedCorrelationId: 'corr-1',
    reinstatementNote: 'The delivery failures were resolved',
  } as const;

  it('finds and stamps the supplier open episode rather than one in the operator tenant', async () => {
    const { tx, calls } = guardedClient({ 'suspension.findFirst': { id: 'SSP_1' } });

    const result = await asOperatorOf(OTHER_ORG, () =>
      repository.closeSuspension(tx, A_REINSTATEMENT),
    );

    expect(result).toEqual({ changed: 1, suspensionId: 'SSP_1' });
    expect(signatures(calls)).toEqual([
      'Supplier.updateMany',
      'Suspension.findFirst',
      'Suspension.updateMany',
    ]);
    expect(calls[0]?.args.where).toEqual({ id: 'SUP_1', status: 'SUSPENDED' });
    expect(calls[1]?.args.where).toEqual({ supplierId: 'SUP_1', reinstatedAt: null });
    expect(calls[2]?.args.where).toEqual({ id: 'SSP_1', reinstatedAt: null });
  });

  it('does not require the reinstating operator to belong to any organization', async () => {
    const { tx } = guardedClient({ 'suspension.findFirst': { id: 'SSP_1' } });

    await expect(
      asPlatformOperator(() => repository.closeSuspension(tx, A_REINSTATEMENT)),
    ).resolves.toEqual({ changed: 1, suspensionId: 'SSP_1' });
  });
});

describe('the writes a supplier makes about itself', () => {
  it('stays scoped: registration is stamped with the registering organization', async () => {
    const { tx, calls } = guardedClient();

    await asOwner(() =>
      repository.createSupplier(tx, {
        id: 'SUP_1',
        organizationId: SUPPLIER_ORG,
        displayName: 'A workshop',
        registeredBy: 'USR_OWNER',
        registeredCorrelationId: 'corr-1',
        capabilities: [{ id: 'SCP_1', capability: 'WORKSHOP_SERVICE' }],
      }),
    );

    expect(signatures(calls)).toEqual(['Supplier.create', 'SupplierCapability.createMany']);
    expect(calls[0]?.args.data).toMatchObject({ organizationId: SUPPLIER_ORG });
  });

  it('refuses a registration written for another organization', async () => {
    const { tx } = guardedClient();

    // The guard, not this service, is what makes this impossible. Asserted here
    // so the crossings the deciding side needs cannot be widened to the supplier
    // side without a test noticing.
    await expect(
      asOperatorOf(OTHER_ORG, () =>
        repository.createSupplier(tx, {
          id: 'SUP_1',
          organizationId: SUPPLIER_ORG,
          displayName: 'A workshop',
          registeredBy: 'USR_OPERATOR',
          registeredCorrelationId: 'corr-1',
          capabilities: [],
        }),
      ),
    ).rejects.toThrow(/Cross-tenant writes are never implicit/);
  });
});
