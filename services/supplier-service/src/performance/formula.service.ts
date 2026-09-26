import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { assertCanManagePerformanceFormula } from '../access/access';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { requireActor } from '../supplier/supplier.service';
import { assertActivatable, assertValidFormulaDraft, type FormulaDraftInput } from './formula';
import { PerformanceFormulaRepository, type FormulaVersionRow } from './formula.repository';

/**
 * Creating and activating versions of the platform-wide performance formula
 * (ADR-052 § 3, step 2).
 *
 * Every change writes its audit event through the transactional outbox in the
 * same transaction as the row (AGENTS.md A-08, S-06): a version that rolled
 * back announces nothing, and a committed one cannot go unannounced.
 *
 * There is deliberately no `retire()`. Retirement happens only when a successor
 * is activated, in one transaction (PM ruling on Q-B); the database refuses a
 * standalone retirement at commit whether or not this class is the caller.
 * There is no draft edit either: a mistaken draft is superseded by a new one,
 * so every configuration anybody proposed stays on the record.
 *
 * Not wired into `AppModule` and reachable from no endpoint — the management
 * API is ADR-052 step 7.
 */
@Injectable()
export class PerformanceFormulaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PerformanceFormulaRepository,
    private readonly events: EventPublisher,
  ) {}

  /** Records a DRAFT version. Returns it as stored. */
  async createDraft(draft: FormulaDraftInput): Promise<FormulaVersionRow> {
    assertCanManagePerformanceFormula();
    const actor = requireActor();
    const { correlationId } = getContext();
    assertValidFormulaDraft(draft);

    const id = newId(ID_PREFIX.formulaVersion);

    try {
      await this.prisma.transaction(async (tx) => {
        const createdAt = await transactionNow(tx);
        const formulaVersion = await this.repository.nextFormulaVersion(tx);

        await this.repository.insertDraft(tx, {
          id,
          formulaVersion,
          draft,
          created: { by: actor, at: createdAt, correlationId },
        });

        await this.events.enqueue(tx, {
          eventName: 'PERFORMANCE_FORMULA_VERSION_CREATED',
          aggregateId: id,
          organizationId: null,
          payload: {
            formulaVersionId: id,
            formulaVersion,
            windowDays: draft.windowDays,
            minSampleCount: draft.minSampleCount,
            minCoverageBp: draft.minCoverageBp,
            ratingMapping: { ...draft.ratingMapping },
            weights: [...draft.weights]
              .map(({ component, weightBp }) => ({ component, weightBp }))
              .sort((a, b) => a.component.localeCompare(b.component)),
            createdBy: actor,
            createdAt: createdAt.toISOString(),
          },
          occurredAt: createdAt,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `ux_performance_formula_version_number`: another draft took this
        // number between the read and the insert. Refused, never renumbered.
        throw RastaError.optimisticLockFailed('PerformanceFormulaVersion', id);
      }
      throw error;
    }

    return this.mustFind(id);
  }

  /**
   * Makes a DRAFT the platform's one ACTIVE version, retiring the one it
   * replaces in the same transaction.
   *
   * Does not recompute any score (ADR-052 § 3, § 13): existing snapshots keep
   * the version they were stamped with.
   */
  async activate(id: string): Promise<FormulaVersionRow> {
    assertCanManagePerformanceFormula();
    const actor = requireActor();
    const { correlationId } = getContext();

    try {
      await this.prisma.transaction(async (tx) => {
        const target = await this.repository.lockById(tx, id);
        if (!target) throw RastaError.notFound('PerformanceFormulaVersion', id);
        assertActivatable(target.formulaVersion, target.status);

        const now = await transactionNow(tx);
        const stamp = { by: actor, at: now, correlationId };
        const current = await this.repository.lockActive(tx);

        // Retire first: the single-ACTIVE index is immediate, so the order is
        // retire then activate. The successor trigger checks the pair at commit.
        if (current) {
          if (!(await this.repository.markRetired(tx, current.id, stamp))) {
            throw RastaError.optimisticLockFailed('PerformanceFormulaVersion', current.id);
          }
          await this.events.enqueue(tx, {
            eventName: 'PERFORMANCE_FORMULA_VERSION_RETIRED',
            aggregateId: current.id,
            organizationId: null,
            payload: {
              formulaVersionId: current.id,
              formulaVersion: current.formulaVersion,
              successorFormulaVersionId: id,
              retiredBy: actor,
              retiredAt: now.toISOString(),
            },
            occurredAt: now,
          });
        }

        if (!(await this.repository.markActive(tx, id, stamp))) {
          throw RastaError.optimisticLockFailed('PerformanceFormulaVersion', id);
        }
        await this.events.enqueue(tx, {
          eventName: 'PERFORMANCE_FORMULA_VERSION_ACTIVATED',
          aggregateId: id,
          organizationId: null,
          payload: {
            formulaVersionId: id,
            formulaVersion: target.formulaVersion,
            supersededFormulaVersionId: current?.id ?? null,
            activatedBy: actor,
            activatedAt: now.toISOString(),
          },
          occurredAt: now,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `ux_performance_formula_single_active`: a concurrent activation of a
        // different draft committed first. Nothing of this attempt remains.
        throw RastaError.optimisticLockFailed('PerformanceFormulaVersion', id);
      }
      throw error;
    }

    return this.mustFind(id);
  }

  private async mustFind(id: string): Promise<FormulaVersionRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw RastaError.internal('The formula version disappeared immediately after it was written');
    }
    return row;
  }
}
