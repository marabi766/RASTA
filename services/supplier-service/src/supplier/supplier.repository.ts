import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { SupplierCapability } from './capabilities';
import type { QualificationStateName } from './qualification.state-machine';
import type { SupplierStatusName } from './suspension.state-machine';

/**
 * Every read and write of this service's own tables.
 *
 * ## Where the tenant guard is crossed, and why
 *
 * Each crossing carries a written reason, and they fall into three kinds:
 *
 *   **id lookups.** A row has to be located *before* anybody can decide whether
 *   the caller may see it. A scoped read would return `null` for another
 *   tenant's supplier, which sounds safe and is subtly wrong: the service could
 *   then never distinguish "does not exist" from "belongs to someone else", and
 *   the object-level check in `access.ts` would have nothing to check. So the
 *   row is located unscoped and handed straight to a check that answers `404`
 *   either way (AGENTS.md A-04's written-reason exception).
 *
 *   **the directory.** `SearchSuppliers` and `ListQualifiedFor` cross tenants by
 *   design — an open list is the point (`docs/04` § 4.10) — and the review queue
 *   crosses them because a platform reviewer has no tenant of the supplier's.
 *   These are contained by the projection (`views.ts`) and by the role checks in
 *   `access.ts`, not by the query.
 *
 *   **the three decision writes.** `recordDecision`, `openSuspension` and
 *   `closeSuspension` are the only writes in this service made by somebody from
 *   another organization, and they are that by rule rather than by accident:
 *   `assertCanDecideAbout` refuses a platform operator who belongs to the
 *   supplier's own organization, so on every path that reaches them the row's
 *   `organizationId` is guaranteed **not** to be the caller's. Left scoped, the
 *   guard would rewrite each predicate with the deciding operator's tenant and
 *   match nothing — every approval and every suspension would answer "somebody
 *   else decided this first", and a `SYSTEM_ADMIN` acting platform-wide, who has
 *   no tenant at all, would get a 500 from `getOrganizationId()` instead.
 *   `supplier.repository.spec.ts` holds each of these open.
 *
 *   What contains them is the object-level check the service has already made,
 *   not the query: every one of the three is reached only after
 *   `assertCanDecideAbout` has passed on the located supplier row, and each
 *   matches on a primary key or on the `supplierId` that check was made against.
 *
 * Nothing else crosses. The supplier-side writes — registration, capability
 * declaration, a qualification submission and its evidence — stay scoped, so the
 * guard both stamps them with the registering organization and refuses one
 * written for anybody else's.
 */

/**
 * Everything the detail and directory projections read, in one shape.
 *
 * `satisfies` rather than `as const`: the latter makes the `orderBy` arrays
 * readonly, and Prisma's generated input types require mutable ones. This still
 * narrows `'asc'` to `SortOrder` and still fails compilation on a field name
 * that does not exist.
 *
 * Every list is ordered by a tiebreaker as well as its timestamp. `submittedAt`
 * alone is not a total order — it is `timestamp(3)`, and two submissions in one
 * millisecond would render in an arbitrary order that changes between reads.
 */
const SUPPLIER_INCLUDE = {
  capabilities: { select: { capability: true } },
  qualifications: {
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    include: {
      evidence: {
        orderBy: [{ attachedAt: 'asc' }, { id: 'asc' }],
        select: { documentId: true, label: true },
      },
    },
  },
  suspensions: { orderBy: [{ suspendedAt: 'desc' }, { id: 'desc' }] },
} satisfies Prisma.SupplierInclude;

export interface CreateSupplierInput {
  id: string;
  organizationId: string;
  displayName: string;
  registeredBy: string;
  registeredCorrelationId: string;
  capabilities: { id: string; capability: SupplierCapability }[];
}

export interface CreateQualificationInput {
  id: string;
  supplierId: string;
  organizationId: string;
  capability: SupplierCapability;
  statement: string | null;
  submittedBy: string;
  submittedCorrelationId: string;
  evidence: { id: string; documentId: string; label: string | null }[];
}

export interface DirectoryFilter {
  capability?: SupplierCapability;
  qualifiedFor?: SupplierCapability;
  status?: SupplierStatusName;
  cursor?: string;
  limit: number;
}

export interface ReviewQueueFilter {
  state: QualificationStateName;
  capability?: SupplierCapability;
  cursor?: string;
  limit: number;
}

@Injectable()
export class SupplierRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- writes ---------------------------------------------------------------

  /**
   * Creates the profile and its claimed capabilities together.
   *
   * `createMany` for the capabilities rather than a nested create, so the unique
   * index refuses a duplicate as one statement rather than N.
   */
  async createSupplier(tx: ExtendedPrismaClient, input: CreateSupplierInput): Promise<void> {
    await tx.supplier.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        displayName: input.displayName,
        registeredBy: input.registeredBy,
        registeredCorrelationId: input.registeredCorrelationId,
      },
    });

    await tx.supplierCapability.createMany({
      data: input.capabilities.map((row) => ({
        id: row.id,
        supplierId: input.id,
        organizationId: input.organizationId,
        capability: row.capability,
        declaredBy: input.registeredBy,
      })),
    });
  }

  async createQualification(
    tx: ExtendedPrismaClient,
    input: CreateQualificationInput,
  ): Promise<void> {
    await tx.qualification.create({
      data: {
        id: input.id,
        supplierId: input.supplierId,
        organizationId: input.organizationId,
        capability: input.capability,
        statement: input.statement,
        submittedBy: input.submittedBy,
        submittedCorrelationId: input.submittedCorrelationId,
      },
    });

    if (input.evidence.length > 0) {
      await tx.qualificationEvidence.createMany({
        data: input.evidence.map((row) => ({
          id: row.id,
          qualificationId: input.id,
          organizationId: input.organizationId,
          documentId: row.documentId,
          label: row.label,
          attachedBy: input.submittedBy,
        })),
      });
    }
  }

  /**
   * Records a decision, exactly once.
   *
   * The `state: 'SUBMITTED'` predicate is the concurrency control: two reviewers
   * deciding the same submission race here, and the loser updates zero rows. The
   * caller turns that into a refusal, which rolls the whole transaction back
   * including its event — so a lost race publishes nothing.
   *
   * Returns the number of rows changed rather than the row, because "did I win"
   * is the only question the caller has at this point.
   *
   * Unscoped: the decider is a platform operator from another organization by
   * rule (`assertCanDecideAbout`), so scoping this to the caller's tenant would
   * make every decision lose its own race. The qualification is addressed by
   * primary key and the caller has already been checked against the supplier
   * that owns it.
   */
  async recordDecision(
    tx: ExtendedPrismaClient,
    input: {
      qualificationId: string;
      state: Exclude<QualificationStateName, 'SUBMITTED'>;
      decidedBy: string;
      decidedAt: Date;
      decidedCorrelationId: string;
      decisionNote: string | null;
    },
  ): Promise<number> {
    const changed = await runUnscoped(
      'a qualification is decided by a platform operator from another organization, ' +
        'after assertCanDecideAbout has checked the caller against the supplier that owns it',
      () =>
        tx.qualification.updateMany({
          where: { id: input.qualificationId, state: 'SUBMITTED' },
          data: {
            state: input.state,
            decidedBy: input.decidedBy,
            decidedAt: input.decidedAt,
            decidedCorrelationId: input.decidedCorrelationId,
            decisionNote: input.decisionNote,
          },
        }),
    );

    return changed.count;
  }

  /**
   * Opens a suspension episode and flips the denormalised status together.
   *
   * The `status: 'ACTIVE'` predicate makes the pair atomic against a concurrent
   * suspension: only one caller can move the supplier out of `ACTIVE`, so only
   * one episode is ever opened. `ux_suspension_open` is the backstop underneath.
   *
   * Unscoped for both statements, and the episode is stamped with the
   * **supplier's** organization rather than the operator's — a suspension is the
   * supplier's own record, and a guard acting for the caller would either match
   * no supplier or refuse the episode outright as an implicit cross-tenant
   * write.
   */
  async openSuspension(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      supplierId: string;
      organizationId: string;
      reason: string;
      suspendedBy: string;
      suspendedCorrelationId: string;
    },
  ): Promise<number> {
    const reason =
      'a supplier is suspended by a platform operator from another organization, ' +
      'after assertCanDecideAbout has checked the caller against this supplier';

    const changed = await runUnscoped(reason, () =>
      tx.supplier.updateMany({
        where: { id: input.supplierId, status: 'ACTIVE' },
        data: { status: 'SUSPENDED' },
      }),
    );

    if (changed.count === 0) return 0;

    await runUnscoped(reason, () =>
      tx.suspension.create({
        data: {
          id: input.id,
          supplierId: input.supplierId,
          organizationId: input.organizationId,
          reason: input.reason,
          suspendedBy: input.suspendedBy,
          suspendedCorrelationId: input.suspendedCorrelationId,
        },
      }),
    );

    return changed.count;
  }

  /**
   * Closes the open episode and returns the supplier to `ACTIVE`.
   *
   * The episode is **stamped, never deleted**: "no destructive cascade may erase
   * suspension history" applies to the ordinary path too, and a reinstatement
   * that removed the row would erase exactly the record somebody will later ask
   * about.
   *
   * Unscoped for the same reason `openSuspension` is: the operator lifting the
   * suspension belongs to another organization by rule, and the episode being
   * closed is the supplier's.
   */
  async closeSuspension(
    tx: ExtendedPrismaClient,
    input: {
      supplierId: string;
      reinstatedBy: string;
      reinstatedAt: Date;
      reinstatedCorrelationId: string;
      reinstatementNote: string;
    },
  ): Promise<{ changed: number; suspensionId: string | null }> {
    const reason =
      'a suspension is lifted by a platform operator from another organization, ' +
      'after assertCanDecideAbout has checked the caller against this supplier';

    const changed = await runUnscoped(reason, () =>
      tx.supplier.updateMany({
        where: { id: input.supplierId, status: 'SUSPENDED' },
        data: { status: 'ACTIVE' },
      }),
    );

    if (changed.count === 0) return { changed: 0, suspensionId: null };

    const open = await runUnscoped(reason, () =>
      tx.suspension.findFirst({
        where: { supplierId: input.supplierId, reinstatedAt: null },
        orderBy: { suspendedAt: 'desc' },
      }),
    );

    if (!open) return { changed: 0, suspensionId: null };

    await runUnscoped(reason, () =>
      tx.suspension.updateMany({
        where: { id: open.id, reinstatedAt: null },
        data: {
          reinstatedBy: input.reinstatedBy,
          reinstatedAt: input.reinstatedAt,
          reinstatedCorrelationId: input.reinstatedCorrelationId,
          reinstatementNote: input.reinstatementNote,
        },
      }),
    );

    return { changed: 1, suspensionId: open.id };
  }

  // -- reads ----------------------------------------------------------------

  /**
   * Locates a supplier by id, without a tenant scope.
   *
   * The caller checks ownership immediately, and that check answers `404` for
   * another tenant's profile — so a stranger cannot learn that an id exists.
   * Locating it scoped instead would collapse "missing" and "somebody else's"
   * into one answer before anybody could tell them apart.
   */
  async findSupplier(id: string) {
    return runUnscoped('a supplier is located before its owner is checked', () =>
      this.prisma.client.supplier.findUnique({ where: { id }, include: SUPPLIER_INCLUDE }),
    );
  }

  /** The same, by organization — used to refuse a second profile. */
  async findSupplierByOrganization(organizationId: string) {
    return runUnscoped('a duplicate registration is detected before the tenant is trusted', () =>
      this.prisma.client.supplier.findUnique({
        where: { organizationId },
        include: SUPPLIER_INCLUDE,
      }),
    );
  }

  async findQualification(id: string) {
    return runUnscoped('a qualification is located before its supplier is checked', () =>
      this.prisma.client.qualification.findUnique({
        where: { id },
        include: { evidence: { select: { documentId: true, label: true } } },
      }),
    );
  }

  /** The qualifications already recorded for one capability of one supplier. */
  async findQualificationsFor(supplierId: string, capability: SupplierCapability) {
    return runUnscoped(
      'reached only through a supplier row whose owner has already been checked',
      () =>
        this.prisma.client.qualification.findMany({
          where: { supplierId, capability },
          select: { id: true, state: true },
        }),
    );
  }

  /**
   * The public directory. Cross-tenant by design.
   *
   * Keyset pagination on `(id)` rather than an offset: the set grows, and an
   * offset silently skips or duplicates rows when it does
   * (`packages/contracts/src/common/pagination.ts`).
   *
   * `qualifiedFor` filters on an approved qualification **and** an unsuspended
   * supplier, in the query, so the "a suspended supplier cannot be returned as
   * currently qualified" rule is enforced before pagination rather than after —
   * filtering a page afterwards would return short pages and eventually drop
   * rows entirely.
   *
   * `qualifiedFor` therefore *implies* `status: ACTIVE`. The contradictory
   * combination — `?status=SUSPENDED&qualifiedFor=WORKSHOP_SERVICE` — cannot
   * arrive here: `searchSuppliersQuerySchema` refuses it with a 400 that says
   * why, rather than letting one filter silently overwrite the other and answer
   * a question nobody asked.
   */
  async searchDirectory(filter: DirectoryFilter) {
    const status = filter.qualifiedFor
      ? { status: 'ACTIVE' as const }
      : filter.status
        ? { status: filter.status }
        : {};

    return runUnscoped(
      'the supplier directory is an explicitly cross-tenant catalogue (docs/04 § 4.10); ' +
        'the projection in views.ts carries catalogue-safe fields only',
      () =>
        this.prisma.client.supplier.findMany({
          where: {
            ...status,
            ...(filter.capability
              ? { capabilities: { some: { capability: filter.capability } } }
              : {}),
            ...(filter.qualifiedFor
              ? {
                  qualifications: { some: { capability: filter.qualifiedFor, state: 'APPROVED' } },
                }
              : {}),
            ...(filter.cursor ? { id: { gt: filter.cursor } } : {}),
          },
          include: SUPPLIER_INCLUDE,
          orderBy: { id: 'asc' },
          take: filter.limit + 1,
        }),
    );
  }

  /**
   * The platform review queue. Cross-tenant, and platform-only by `access.ts`.
   *
   * It returns the private qualification view, evidence identifiers included,
   * which is why the role check in front of it is the narrow one.
   */
  async listForReview(filter: ReviewQueueFilter) {
    return runUnscoped(
      'a platform reviewer has no tenant of the supplier and must see every submission ' +
        '(docs/09 § 9.3 platform scope); restricted to SYSTEM_ADMIN and UNION_ADMIN',
      () =>
        this.prisma.client.qualification.findMany({
          where: {
            state: filter.state,
            ...(filter.capability ? { capability: filter.capability } : {}),
            ...(filter.cursor ? { id: { gt: filter.cursor } } : {}),
          },
          include: {
            evidence: { select: { documentId: true, label: true } },
            supplier: {
              select: { id: true, organizationId: true, displayName: true, status: true },
            },
          },
          orderBy: { id: 'asc' },
          take: filter.limit + 1,
        }),
    );
  }
}
