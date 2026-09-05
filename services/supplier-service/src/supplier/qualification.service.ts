import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import {
  assertActingAsSupplier,
  assertCanDecideAbout,
  assertCanReviewQualifications,
} from '../access/access';
import { isUniqueViolation } from '../shared/prisma-errors';
import { SupplierRepository } from './supplier.repository';
import { page, requireActor } from './supplier.service';
import {
  assertNoBlockingQualification,
  assertQualificationTransition,
  isCurrentlyQualified,
  type QualificationStateName,
} from './qualification.state-machine';
import type {
  ApproveQualificationDto,
  QualificationView,
  RejectQualificationDto,
  ReviewQueueQuery,
  SubmitQualificationDto,
} from './dto';
import type { SupplierCapability } from './capabilities';
import {
  qualificationDecisionsTotal,
  qualificationsSubmittedTotal,
} from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';

/**
 * SubmitQualification, ApproveQualification, RejectQualification, and the
 * reviewer's queue.
 *
 * ## The separation this class exists to preserve
 *
 * Submitting and deciding are two authorities and they meet on one row. A
 * supplier submits for its own organization ({@link assertActingAsSupplier},
 * which platform scope does not exempt); a platform operator from a *different*
 * organization decides ({@link assertCanDecideAbout}, which no role exempts).
 * Neither call site can reach the other's gate: they are separate functions and
 * each command wires exactly one.
 *
 * ## What a decision is, and what it is not
 *
 * A decision is a human recording an outcome. Nothing in this class computes,
 * infers, defers or times out into one. There is no auto-approval path, no
 * scoring threshold and no scheduled sweep, because none of those exists as an
 * approved rule — and an approval nobody made is the single most damaging thing
 * this service could produce, since `SUPPLIER_QUALIFIED` is what other services
 * will act on.
 *
 * ## What an approval does not assert
 *
 * That a named operator approved it, at a stated time. **Not** that any evidence
 * document was fetched, opened, scanned, or found authentic, current or legally
 * valid: this service never calls document-service (see the schema comment on
 * `qualification_evidence`), so it has no basis for any of those claims and does
 * not make them — in the event payload, in the API response, or here.
 */
@Injectable()
export class QualificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: SupplierRepository,
    private readonly events: EventPublisher,
  ) {}

  /**
   * SubmitQualification.
   *
   * Writes the submission, its evidence references and nothing else — no event.
   * A submission is not a platform fact: nobody outside this service acts on
   * "somebody applied", and publishing it would put an organization's
   * in-progress application on a topic every service reads. `SUPPLIER_QUALIFIED`
   * and `SUPPLIER_REJECTED` are the facts, and they are published when a human
   * decides.
   */
  async submit(supplierId: string, dto: SubmitQualificationDto): Promise<QualificationView> {
    const supplier = await this.repository.findSupplier(supplierId);
    if (!supplier) throw RastaError.notFound('Supplier', supplierId);

    assertActingAsSupplier(supplier);

    const existing = await this.repository.findQualificationsFor(supplierId, dto.capability);
    assertNoBlockingQualification(dto.capability, existing as { state: QualificationStateName }[]);

    const context = getContext();
    const actor = requireActor();
    const qualificationId = newId(ID_PREFIX.qualification);

    try {
      await this.prisma.transaction(async (tx) => {
        await this.repository.createQualification(tx, {
          id: qualificationId,
          supplierId,
          organizationId: supplier.organizationId,
          capability: dto.capability,
          statement: dto.statement ?? null,
          submittedBy: actor,
          submittedCorrelationId: context.correlationId,
          evidence: dto.evidence.map((item) => ({
            id: newId(ID_PREFIX.evidence),
            documentId: item.documentId,
            label: item.label ?? null,
          })),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `ux_qualification_open` or `ux_qualification_approved` — two
        // submissions raced past the read above. The database is the authority.
        throw RastaError.businessRule(
          `A qualification for ${dto.capability} already exists for this supplier`,
          { capability: dto.capability },
        );
      }
      throw error;
    }

    qualificationsSubmittedTotal.inc({ service: SERVICE_NAME, capability: dto.capability });

    return this.viewOf(qualificationId, supplier.status === 'SUSPENDED');
  }

  /** ApproveQualification. */
  async approve(
    supplierId: string,
    qualificationId: string,
    dto: ApproveQualificationDto,
  ): Promise<QualificationView> {
    return this.decide(supplierId, qualificationId, 'APPROVED', {
      note: dto.note ?? null,
      reason: null,
    });
  }

  /** RejectQualification. */
  async reject(
    supplierId: string,
    qualificationId: string,
    dto: RejectQualificationDto,
  ): Promise<QualificationView> {
    return this.decide(supplierId, qualificationId, 'REJECTED', {
      note: dto.note ?? null,
      reason: dto.reason,
    });
  }

  /**
   * The one path both decisions take.
   *
   * Written once because the security-relevant steps — locate, check the row,
   * refuse self-judgement, check the transition, write and publish atomically —
   * must be identical for both. Two copies is two chances for one of them to
   * lose a step, and the step it would lose is the one nobody remembers.
   */
  private async decide(
    supplierId: string,
    qualificationId: string,
    state: Exclude<QualificationStateName, 'SUBMITTED'>,
    decision: { note: string | null; reason: string | null },
  ): Promise<QualificationView> {
    const supplier = await this.repository.findSupplier(supplierId);
    if (!supplier) throw RastaError.notFound('Supplier', supplierId);

    // Platform scope, and then the check no role can satisfy: a supplier
    // organization never decides its own case, whichever admin role the person
    // happens to hold.
    assertCanDecideAbout(supplier);

    const qualification = await this.repository.findQualification(qualificationId);
    // Checked against the supplier in the path, so a caller cannot decide one
    // supplier's qualification through another supplier's URL — which would
    // otherwise slip past the self-judgement check by naming an unrelated
    // profile in the path.
    if (!qualification || qualification.supplierId !== supplierId) {
      throw RastaError.notFound('Qualification', qualificationId);
    }

    assertQualificationTransition(
      qualificationId,
      qualification.state as QualificationStateName,
      state,
    );

    const context = getContext();
    const actor = requireActor();
    const decidedAt = new Date();

    await this.prisma.transaction(async (tx) => {
      const changed = await this.repository.recordDecision(tx, {
        qualificationId,
        state,
        decidedBy: actor,
        decidedAt,
        decidedCorrelationId: context.correlationId,
        decisionNote: decision.note,
      });

      if (changed === 0) {
        // Another reviewer decided it between the read and this write. Thrown
        // inside the transaction, so the event rolls back with it — a lost race
        // publishes nothing.
        throw RastaError.businessRule(
          `Qualification ${qualificationId} was decided by somebody else first`,
          { qualificationId },
        );
      }

      if (state === 'APPROVED') {
        await this.events.enqueue(tx, {
          eventName: 'SUPPLIER_QUALIFIED',
          aggregateId: qualificationId,
          organizationId: supplier.organizationId,
          payload: {
            supplierId,
            organizationId: supplier.organizationId,
            qualificationId,
            qualifiedFor: [qualification.capability],
            decidedBy: actor,
            decidedAt: decidedAt.toISOString(),
          },
        });
      } else {
        await this.events.enqueue(tx, {
          eventName: 'SUPPLIER_REJECTED',
          aggregateId: qualificationId,
          organizationId: supplier.organizationId,
          payload: {
            supplierId,
            organizationId: supplier.organizationId,
            qualificationId,
            rejectedFor: [qualification.capability],
            // The stated reason only. The reviewer's private note stays in the
            // database: a seven-day log every service reads is not where it
            // belongs.
            reason: decision.reason ?? 'No reason was stated',
            decidedBy: actor,
            decidedAt: decidedAt.toISOString(),
          },
        });
      }
    });

    qualificationDecisionsTotal.inc({
      service: SERVICE_NAME,
      decision: state,
      capability: qualification.capability,
    });

    return this.viewOf(qualificationId, supplier.status === 'SUSPENDED');
  }

  /**
   * The reviewer's queue. Cross-tenant, platform operators only.
   *
   * It exists because "SYSTEM_ADMIN and UNION_ADMIN may review qualification
   * submissions" is not an operable statement if a reviewer has to already know
   * which supplier applied. It returns the private view — evidence identifiers
   * included — which is exactly why `assertCanReviewQualifications` is the
   * narrow gate rather than the directory one.
   */
  async reviewQueue(query: ReviewQueueQuery): Promise<
    CursorPage<
      QualificationView & {
        supplierId: string;
        supplierOrganizationId: string;
        supplierDisplayName: string;
      }
    >
  > {
    assertCanReviewQualifications();

    const rows = await this.repository.listForReview({
      state: query.state,
      ...(query.capability ? { capability: query.capability } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    return page(rows, query.limit, (row) => ({
      ...projectQualification(row, row.supplier.status === 'SUSPENDED'),
      supplierId: row.supplier.id,
      supplierOrganizationId: row.supplier.organizationId,
      supplierDisplayName: row.supplier.displayName,
    }));
  }

  private async viewOf(qualificationId: string, supplierSuspended: boolean) {
    const row = await this.repository.findQualification(qualificationId);
    if (!row) {
      throw RastaError.internal('The qualification disappeared immediately after being written');
    }
    return projectQualification(row, supplierSuspended);
  }
}

/**
 * The private qualification projection.
 *
 * Deliberately not exported through `views.ts`'s directory path: this shape
 * carries evidence document identifiers and the reviewer's note, and the only
 * readers are the supplier's own organization and platform operators.
 */
function projectQualification(
  row: {
    id: string;
    capability: string;
    state: string;
    statement: string | null;
    submittedBy: string;
    submittedAt: Date;
    decidedBy: string | null;
    decidedAt: Date | null;
    decisionNote: string | null;
    evidence: { documentId: string; label: string | null }[];
  },
  supplierSuspended: boolean,
): QualificationView {
  return {
    id: row.id,
    capability: row.capability as SupplierCapability,
    state: row.state as QualificationStateName,
    statement: row.statement,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    evidence: row.evidence.map((item) => ({ documentId: item.documentId, label: item.label })),
    current: isCurrentlyQualified({
      state: row.state as QualificationStateName,
      supplierSuspended,
    }),
  };
}
