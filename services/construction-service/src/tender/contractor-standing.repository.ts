import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/** Why a suspension event could not be folded; both are verdicts on the event, not failures. */
export type SuspensionRefusal = 'ORGANIZATION_MISMATCH' | 'EPISODE_OUT_OF_ORDER';

/**
 * Whether a contractor may bid, and if not, why (ADR-067 § 4, ADR-061 § 4).
 *
 * `STANDING_NOT_LOADED` is the fail-closed state before the bootstrap has finished:
 * the service has not yet read what predates its consumer group, so it cannot say
 * that *anybody* is eligible — and must not say it of a contractor it has merely
 * not heard about.
 */
export type EligibilityVerdict = 'ELIGIBLE' | 'STANDING_NOT_LOADED' | 'NOT_QUALIFIED' | 'SUSPENDED';

export interface BootstrapState {
  startedAt: Date;
  cursor: string | null;
  suppliersLoaded: number;
  sourceSnapshotAt: Date | null;
  completedAt: Date | null;
}

/**
 * The read model of a contractor's standing (CON-002 PR 5, ADR-067 § 4).
 *
 * ## Where the tenant guard is crossed
 *
 * The rows are about the **contractor's** organization, which is neither the
 * event's tenant nor the tender owner's: the consumer has no request context and
 * the bid path asks about another organization. Every method therefore runs
 * under `runUnscoped` with a written reason, and each statement names the one
 * organization it is about. (`standing_bootstrap` names no organization at all.)
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
 * **The bootstrap folds the same way.** Its snapshot is applied through these very
 * methods, so snapshot and events are idempotent with one another in either order:
 * an event that arrives before, during or after the page that also states it
 * leaves the same row.
 *
 * Times are the events' own (the producer's decision instants), not this
 * service's clock: they are facts about when supplier-service decided.
 */
@Injectable()
export class ContractorStandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A `CONTRACTING` qualification decided at `decidedAt`. Never moves the record back. */
  async recordQualified(
    organizationId: string,
    decidedAt: Date,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<void> {
    await runUnscoped(
      "folding a contractor's qualification into its standing, which belongs to that organization (ADR-067 § 4)",
      () =>
        client.$executeRawUnsafe(
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
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<SuspensionRefusal | undefined> {
    return this.foldEpisode(client, organizationId, suspensionId, 'suspended_at', suspendedAt);
  }

  /** The end of episode `suspensionId`; may arrive before its start. */
  reinstate(
    organizationId: string,
    suspensionId: string,
    reinstatedAt: Date,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<SuspensionRefusal | undefined> {
    return this.foldEpisode(client, organizationId, suspensionId, 'reinstated_at', reinstatedAt);
  }

  /**
   * **Advisory.** What this service's read model says about `organizationId`, for
   * listing and for a UI. It is **not** a source for deciding a bid: built from a
   * seven-day event log and a snapshot, it can say "eligible" when supplier-service
   * says otherwise (an event that expired while this service was down; a suspension
   * committed but not yet relayed). A bid asks `StandingAuthority`, which asks the
   * owner at the moment of the bid.
   *
   * Whether `organizationId` is eligible by the read model, and the reason when not:
   * the standing must have been **loaded** (the bootstrap marker exists), and the
   * organization qualified for `CONTRACTING` and in no open suspension episode.
   * An organization this service has heard nothing about is not eligible.
   */
  async eligibility(
    organizationId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<EligibilityVerdict> {
    const rows = await runUnscoped(
      "reading one contractor's standing for a bid, which belongs to that organization (ADR-067 § 4)",
      () =>
        client.$queryRawUnsafe<{ loaded: boolean; qualified: boolean; suspended: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM standing_bootstrap WHERE id = 1 AND completed_at IS NOT NULL) AS loaded,
                  EXISTS (SELECT 1 FROM contractor_standing s
                           WHERE s.organization_id = $1
                             AND s.contracting_qualified_at IS NOT NULL) AS qualified,
                  EXISTS (SELECT 1 FROM contractor_suspension x
                           WHERE x.organization_id = $1
                             AND x.suspended_at IS NOT NULL
                             AND x.reinstated_at IS NULL) AS suspended`,
          organizationId,
        ),
    );
    const row = rows[0];
    if (!row?.loaded) return 'STANDING_NOT_LOADED';
    if (row.suspended) return 'SUSPENDED';
    return row.qualified ? 'ELIGIBLE' : 'NOT_QUALIFIED';
  }

  async isEligible(
    organizationId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<boolean> {
    return (await this.eligibility(organizationId, client)) === 'ELIGIBLE';
  }

  // -- the bootstrap marker -------------------------------------------------------

  async bootstrapState(
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<BootstrapState | null> {
    const row = await runUnscoped('the bootstrap marker names no organization', () =>
      client.standingBootstrap.findUnique({ where: { id: 1 } }),
    );
    return row
      ? {
          startedAt: row.startedAt,
          cursor: row.cursor,
          suppliersLoaded: row.suppliersLoaded,
          sourceSnapshotAt: row.sourceSnapshotAt,
          completedAt: row.completedAt,
        }
      : null;
  }

  /** Opens the marker if there is none; an open or completed one is left as it is. */
  async beginBootstrap(client: ExtendedPrismaClient = this.prisma.client): Promise<void> {
    await runUnscoped('the bootstrap marker names no organization', () =>
      client.$executeRawUnsafe(
        `INSERT INTO standing_bootstrap (id, started_at, updated_at) VALUES (1, now(), now())
         ON CONFLICT (id) DO NOTHING`,
      ),
    );
  }

  /** One page applied: where the next starts, how many suppliers so far, the newest instant read. */
  async recordSnapshotPage(
    client: ExtendedPrismaClient,
    page: { cursor: string | null; loaded: number; snapshotAt: Date },
  ): Promise<void> {
    await runUnscoped('the bootstrap marker names no organization', () =>
      client.$executeRawUnsafe(
        `UPDATE standing_bootstrap
            SET cursor = $1,
                suppliers_loaded = suppliers_loaded + $2,
                source_snapshot_at = GREATEST(COALESCE(source_snapshot_at, $3::timestamp), $3::timestamp),
                updated_at = now()
          WHERE id = 1 AND completed_at IS NULL`,
        page.cursor,
        page.loaded,
        page.snapshotAt,
      ),
    );
  }

  /** The last page was applied: from now on eligibility is answered. Returns whether this call completed it. */
  async completeBootstrap(client: ExtendedPrismaClient): Promise<boolean> {
    const touched = await runUnscoped('the bootstrap marker names no organization', () =>
      client.$executeRawUnsafe(
        `UPDATE standing_bootstrap SET completed_at = now(), updated_at = now()
          WHERE id = 1 AND completed_at IS NULL AND source_snapshot_at IS NOT NULL`,
      ),
    );
    return touched === 1;
  }

  private async foldEpisode(
    client: ExtendedPrismaClient,
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
          client.$executeRawUnsafe(
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
