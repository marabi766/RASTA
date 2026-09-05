import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { PrismaService, ExtendedPrismaClient } from '../prisma/prisma.service';
import type { EventPublisher } from '../events/publisher';
import type { SupplierRepository } from './supplier.repository';
import type { SupplierCapability } from './capabilities';
import type { QualificationStateName } from './qualification.state-machine';
import type { SupplierStatusName } from './suspension.state-machine';

/**
 * In-memory stand-ins for the three collaborators the domain services take.
 *
 * ## Why these exist rather than a mocking library
 *
 * The behaviour worth testing without a database is the **order of the checks**:
 * that a decision is refused for the caller's organization before anything is
 * written, that a lost race publishes nothing, that a rejection's private note
 * never reaches the payload. All three are properties of the service, not of
 * Prisma, and a mock configured per test would let a service that skipped a
 * check still pass by returning whatever the test happened to stub.
 *
 * So {@link FakeRepository} holds real state and answers from it, and
 * {@link FakePrisma} models the one property of a transaction these services
 * depend on: **an exception discards everything written inside it**, events
 * included. Without that, "a lost race publishes nothing" would be asserted
 * against a fake that could not have rolled anything back.
 *
 * This file is not a `.spec.ts` because two suites use it. It carries no
 * assertions and nothing outside `src/supplier/*.spec.ts` imports it.
 */

export interface FakeQualification {
  id: string;
  supplierId: string;
  organizationId: string;
  capability: SupplierCapability;
  state: QualificationStateName;
  statement: string | null;
  submittedBy: string;
  submittedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  evidence: { documentId: string; label: string | null }[];
}

export interface FakeSupplier {
  id: string;
  organizationId: string;
  displayName: string;
  status: SupplierStatusName;
  registeredBy: string;
  registeredAt: Date;
  capabilities: { capability: SupplierCapability }[];
  qualifications: FakeQualification[];
  suspensions: {
    id: string;
    reason: string;
    suspendedBy: string;
    suspendedAt: Date;
    reinstatedBy: string | null;
    reinstatedAt: Date | null;
    reinstatementNote: string | null;
  }[];
}

export interface EnqueuedEvent {
  eventName: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}

/**
 * A transaction that actually rolls back.
 *
 * The events buffer is the point: `enqueue` appends to a pending list, and only
 * a transaction that returns normally moves that list into `committed`. A
 * service that threw after enqueuing — which is exactly what a lost race does —
 * leaves `committed` untouched, and the assertion "publishes nothing" means
 * something.
 */
export class FakePrisma {
  readonly committed: EnqueuedEvent[] = [];
  pending: EnqueuedEvent[] = [];

  async transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    this.pending = [];
    try {
      const result = await fn({} as ExtendedPrismaClient);
      this.committed.push(...this.pending);
      return result;
    } finally {
      this.pending = [];
    }
  }

  asPrismaService(): PrismaService {
    return this as unknown as PrismaService;
  }
}

export class FakeEvents {
  constructor(private readonly prisma: FakePrisma) {}

  async enqueue(_tx: ExtendedPrismaClient, input: EnqueuedEvent): Promise<void> {
    this.prisma.pending.push(input);
  }

  asEventPublisher(): EventPublisher {
    return this as unknown as EventPublisher;
  }
}

/**
 * A repository backed by a plain array.
 *
 * `recordDecision`, `openSuspension` and `closeSuspension` reproduce the
 * conditional predicates the real ones use — `state: 'SUBMITTED'`,
 * `status: 'ACTIVE'`, `status: 'SUSPENDED'` — because those predicates are what
 * decides a race, and a fake that ignored them would make the race tests
 * vacuous. `raceOn` forces the losing side without needing two processes.
 */
export class FakeRepository {
  readonly suppliers: FakeSupplier[] = [];
  /** Set to make the next matching conditional write behave as the loser. */
  raceOn: 'decision' | 'suspend' | 'reinstate' | null = null;

  add(supplier: FakeSupplier): FakeSupplier {
    this.suppliers.push(supplier);
    return supplier;
  }

  async findSupplier(id: string) {
    return this.suppliers.find((row) => row.id === id) ?? null;
  }

  async findSupplierByOrganization(organizationId: string) {
    return this.suppliers.find((row) => row.organizationId === organizationId) ?? null;
  }

  async findQualification(id: string) {
    for (const supplier of this.suppliers) {
      const found = supplier.qualifications.find((row) => row.id === id);
      if (found) return found;
    }
    return null;
  }

  async findQualificationsFor(supplierId: string, capability: SupplierCapability) {
    const supplier = this.suppliers.find((row) => row.id === supplierId);
    return (supplier?.qualifications ?? [])
      .filter((row) => row.capability === capability)
      .map((row) => ({ id: row.id, state: row.state }));
  }

  /**
   * Reproduces the one behaviour the real one has that a test depends on: the
   * unique organization index. A second profile for one organization raises the
   * same Prisma `P2002` the database would, so the service's `isUniqueViolation`
   * branch is exercised rather than assumed.
   */
  async createSupplier(
    _tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      displayName: string;
      registeredBy: string;
      capabilities: { capability: SupplierCapability }[];
    },
  ): Promise<void> {
    if (this.suppliers.some((row) => row.organizationId === input.organizationId)) {
      throw Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: 'supplier_organization_id_key' },
      });
    }

    this.suppliers.push({
      id: input.id,
      organizationId: input.organizationId,
      displayName: input.displayName,
      status: 'ACTIVE',
      registeredBy: input.registeredBy,
      registeredAt: new Date(),
      capabilities: input.capabilities.map((row) => ({ capability: row.capability })),
      qualifications: [],
      suspensions: [],
    });
  }

  /**
   * The directory, filtered the way the real query filters.
   *
   * `qualifiedFor` implies `status: 'ACTIVE'` here exactly as it does in SQL —
   * without that, "a suspended supplier is excluded before pagination" would be
   * asserted against a fake that never excluded anything.
   */
  async searchDirectory(filter: {
    capability?: SupplierCapability;
    qualifiedFor?: SupplierCapability;
    status?: SupplierStatusName;
    cursor?: string;
    limit: number;
  }) {
    const status = filter.qualifiedFor ? 'ACTIVE' : filter.status;

    return this.suppliers
      .filter((row) => (status ? row.status === status : true))
      .filter((row) =>
        filter.capability
          ? row.capabilities.some((cap) => cap.capability === filter.capability)
          : true,
      )
      .filter((row) =>
        filter.qualifiedFor
          ? row.qualifications.some(
              (q) => q.capability === filter.qualifiedFor && q.state === 'APPROVED',
            )
          : true,
      )
      .filter((row) => (filter.cursor ? row.id > filter.cursor : true))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, filter.limit + 1);
  }

  async createQualification(
    _tx: ExtendedPrismaClient,
    input: {
      id: string;
      supplierId: string;
      organizationId: string;
      capability: SupplierCapability;
      statement: string | null;
      submittedBy: string;
      evidence: { documentId: string; label: string | null }[];
    },
  ): Promise<void> {
    const supplier = this.suppliers.find((row) => row.id === input.supplierId);
    supplier?.qualifications.push({
      id: input.id,
      supplierId: input.supplierId,
      organizationId: input.organizationId,
      capability: input.capability,
      state: 'SUBMITTED',
      statement: input.statement,
      submittedBy: input.submittedBy,
      submittedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      evidence: input.evidence.map((item) => ({
        documentId: item.documentId,
        label: item.label,
      })),
    });
  }

  async recordDecision(
    _tx: ExtendedPrismaClient,
    input: {
      qualificationId: string;
      state: Exclude<QualificationStateName, 'SUBMITTED'>;
      decidedBy: string;
      decidedAt: Date;
      decisionNote: string | null;
    },
  ): Promise<number> {
    if (this.raceOn === 'decision') return 0;

    const row = await this.findQualification(input.qualificationId);
    // The real predicate. Only a SUBMITTED row is updated.
    if (!row || row.state !== 'SUBMITTED') return 0;

    row.state = input.state;
    row.decidedBy = input.decidedBy;
    row.decidedAt = input.decidedAt;
    row.decisionNote = input.decisionNote;
    return 1;
  }

  async openSuspension(
    _tx: ExtendedPrismaClient,
    input: {
      id: string;
      supplierId: string;
      reason: string;
      suspendedBy: string;
    },
  ): Promise<number> {
    if (this.raceOn === 'suspend') return 0;

    const supplier = this.suppliers.find((row) => row.id === input.supplierId);
    if (!supplier || supplier.status !== 'ACTIVE') return 0;

    supplier.status = 'SUSPENDED';
    supplier.suspensions.unshift({
      id: input.id,
      reason: input.reason,
      suspendedBy: input.suspendedBy,
      suspendedAt: new Date(),
      reinstatedBy: null,
      reinstatedAt: null,
      reinstatementNote: null,
    });
    return 1;
  }

  async closeSuspension(
    _tx: ExtendedPrismaClient,
    input: {
      supplierId: string;
      reinstatedBy: string;
      reinstatedAt: Date;
      reinstatementNote: string;
    },
  ): Promise<{ changed: number; suspensionId: string | null }> {
    if (this.raceOn === 'reinstate') return { changed: 0, suspensionId: null };

    const supplier = this.suppliers.find((row) => row.id === input.supplierId);
    if (!supplier || supplier.status !== 'SUSPENDED') return { changed: 0, suspensionId: null };

    const open = supplier.suspensions.find((row) => row.reinstatedAt === null);
    if (!open) return { changed: 0, suspensionId: null };

    supplier.status = 'ACTIVE';
    open.reinstatedBy = input.reinstatedBy;
    open.reinstatedAt = input.reinstatedAt;
    open.reinstatementNote = input.reinstatementNote;
    return { changed: 1, suspensionId: open.id };
  }

  asRepository(): SupplierRepository {
    return this as unknown as SupplierRepository;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const SUPPLIER_ORG = 'ORG-SUPPLIER';
export const OTHER_ORG = 'ORG-OTHER';

export function aSupplier(overrides: Partial<FakeSupplier> = {}): FakeSupplier {
  return {
    id: 'SUP_1',
    organizationId: SUPPLIER_ORG,
    displayName: 'A workshop',
    status: 'ACTIVE',
    registeredBy: 'USR_OWNER',
    registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    capabilities: [{ capability: 'WORKSHOP_SERVICE' }],
    qualifications: [],
    suspensions: [],
    ...overrides,
  };
}

export function aQualification(overrides: Partial<FakeQualification> = {}): FakeQualification {
  return {
    id: 'QLF_1',
    supplierId: 'SUP_1',
    organizationId: SUPPLIER_ORG,
    capability: 'WORKSHOP_SERVICE',
    state: 'SUBMITTED',
    statement: null,
    submittedBy: 'USR_OWNER',
    submittedAt: new Date('2026-02-01T00:00:00.000Z'),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    evidence: [],
    ...overrides,
  };
}

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    ...overrides,
  } as RequestContext;
}

/** Runs `fn` as a platform operator belonging to `organizationId`. */
export function asOperatorOf<T>(organizationId: string, fn: () => T): T {
  return runWithContext(
    context({ organizationId, userId: 'USR_OPERATOR', roles: ['UNION_ADMIN'] }),
    fn,
  );
}

/** Runs `fn` as the supplier's own organization. */
export function asOwner<T>(fn: () => T, roles: string[] = ['SUPPLIER']): T {
  return runWithContext(context({ organizationId: SUPPLIER_ORG, userId: 'USR_OWNER', roles }), fn);
}

export function asRole<T>(organizationId: string, roles: string[], fn: () => T): T {
  return runWithContext(context({ organizationId, userId: 'USR_ACTOR', roles }), fn);
}
