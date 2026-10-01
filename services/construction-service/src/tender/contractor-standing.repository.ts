import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';

/** Why a suspension event could not be folded; both are verdicts on the event, not failures. */
export type SuspensionRefusal = 'ORGANIZATION_MISMATCH' | 'EPISODE_OUT_OF_ORDER';

/**
 * The read model of a contractor's standing (CON-002 PR 5, ADR-067 § 4).
 *
 * ## Where the tenant guard is crossed
 *
 * The rows are about the **contractor's** organization, which is neither the
 * event's tenant nor the tender owner's: the consumer has no request context and
 * the bid path asks about another organization. Every method therefore runs
 * under `runUnscoped` with a written reason, and each statement names the one
 * organization it is about.
 *
 * ## Folding: any order, any number of times
 *
 * Kafka redelivers and a replay from the dead-letter topic re-reads old events,
 * so each write is commutative and idempotent instead of "apply what the event
 * says": a qualification only ever moves the recorded time forward (`GREATEST`),
 * and a suspension episode is filled in by its id, each half at most once. A
 * `SUPPLIER_REINSTATED` that overtakes its `SUPPLIER_SUSPENDED` leaves an
 * episode that is already closed when the suspension arrives.
 *
 * Times are the events' own (the producer's decision instants), not this
 * service's clock: they are facts about when supplier-service decided.
 */
@Injectable()
export class ContractorStandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A `CONTRACTING` qualification decided at `decidedAt`. Never moves the record back. */
  async recordQualified(organizationId: string, decidedAt: Date): Promise<void> {
    await runUnscoped(
      "folding a contractor's qualification into its standing, which belongs to that organization (ADR-067 § 4)",
      () =>
        this.prisma.client.$executeRawUnsafe(
          `INSERT INTO contractor_standing (organization_id, contracting_qualified_at, updated_at)
           VALUES ($1, $2::timestamp, now())
           ON CONFLICT (organization_id) DO UPDATE
              SET contracting_qualified_at = GREATEST(
                    contractor_standing.contracting_qualified_at, EXCLUDED.contracting_qualified_at),
                  updated_at = now()`,
          organizationId,
          decidedAt,
        ),
    );
  }

  /** The start of episode `suspensionId`. A second delivery, or one after the lift, changes nothing. */
  suspend(
    organizationId: string,
    suspensionId: string,
    suspendedAt: Date,
  ): Promise<SuspensionRefusal | undefined> {
    return this.foldEpisode(organizationId, suspensionId, 'suspended_at', suspendedAt);
  }

  /** The end of episode `suspensionId`; may arrive before its start. */
  reinstate(
    organizationId: string,
    suspensionId: string,
    reinstatedAt: Date,
  ): Promise<SuspensionRefusal | undefined> {
    return this.foldEpisode(organizationId, suspensionId, 'reinstated_at', reinstatedAt);
  }

  /**
   * Whether `organizationId` may bid as a contractor: qualified for
   * `CONTRACTING` and in no open suspension episode. An organization this
   * service has heard nothing about is **not** eligible (fail closed).
   */
  async isEligible(organizationId: string): Promise<boolean> {
    const rows = await runUnscoped(
      "reading one contractor's standing for a bid, which belongs to that organization (ADR-067 § 4)",
      () =>
        this.prisma.client.$queryRawUnsafe<{ eligible: boolean }[]>(
          `SELECT (s.contracting_qualified_at IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM contractor_suspension x
                                    WHERE x.organization_id = s.organization_id
                                      AND x.suspended_at IS NOT NULL
                                      AND x.reinstated_at IS NULL)) AS eligible
             FROM contractor_standing s
            WHERE s.organization_id = $1`,
          organizationId,
        ),
    );
    return rows[0]?.eligible === true;
  }

  private async foldEpisode(
    organizationId: string,
    suspensionId: string,
    column: 'suspended_at' | 'reinstated_at',
    at: Date,
  ): Promise<SuspensionRefusal | undefined> {
    // `column` is one of the two literals above, never event data.
    try {
      const touched = await runUnscoped(
        'folding a suspension episode into the standing of the organization it names (ADR-067 § 4)',
        () =>
          this.prisma.client.$executeRawUnsafe(
            `INSERT INTO contractor_suspension
                    (suspension_id, organization_id, ${column}, updated_at)
             VALUES ($1, $2, $3::timestamp, now())
             ON CONFLICT (suspension_id) DO UPDATE
                SET ${column} = COALESCE(contractor_suspension.${column}, EXCLUDED.${column}),
                    updated_at = now()
              WHERE contractor_suspension.organization_id = EXCLUDED.organization_id`,
            suspensionId,
            organizationId,
            at,
          ),
      );
      // An episode id that belongs to another organization touches no row.
      return touched === 0 ? 'ORGANIZATION_MISMATCH' : undefined;
    } catch (error) {
      // A lift dated before the start it closes: the event is wrong, retrying cannot fix it.
      if (isOrderViolation(error)) return 'EPISODE_OUT_OF_ORDER';
      throw error;
    }
  }
}

function isOrderViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('ck_suspension_order');
}
