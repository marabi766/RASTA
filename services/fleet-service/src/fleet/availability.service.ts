import { Inject, Injectable, Optional } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { assetsUnavailableTotal } from '../observability/metrics';
import { FleetRepository } from './fleet.repository';
import type { ClaimFence } from './idempotency';
import { FLEET_EVENTS, validateFleetPayload } from './events';
import { FLEET_TOPIC, SERVICE_NAME } from '../config/env';
import { ACTIVE_ASSET_STATUSES } from './constraints';
import {
  DEFAULT_DISPATCH_POLICY,
  DISPATCH_POLICY,
  activeDispatchBlocks,
  type DispatchBlockFields,
  type DispatchPolicy,
} from './dispatch-blocks';
import type {
  AvailabilityBlocker,
  AvailabilityQuery,
  AvailabilityView,
  AvailabilityWindowView,
  DeclareAvailabilityDto,
  ListAvailabilityWindowsQuery,
  UtilizationQuery,
  UtilizationView,
} from './dto';

/**
 * "Which machines can go out today", and "how hard has the fleet been working".
 *
 * Availability is the one answer on the platform assembled from facts that
 * four different services own, and the design decision recorded in ADR-026 is
 * that fleet-service *composes* them without owning any but its own:
 *
 *   asset lifecycle state   asset-service          replicated into asset_ref
 *   safety withdrawal       asset-service          replicated into asset_ref
 *   maintenance withdrawal  maintenance-service    replicated into asset_ref
 *   active assignment       fleet-service          owned here
 *   declared window         fleet-service          owned here
 *
 * Every blocker returned to the caller names its owner, so an operator seeing
 * "unavailable" knows whether to call the workshop, renew a policy, or end an
 * assignment. A bare boolean would send them to the wrong place.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repository: FleetRepository,
    // Optional so a test can build the service with the repository alone; the
    // application always provides it from configuration (docs/24 Q-65).
    @Optional()
    @Inject(DISPATCH_POLICY)
    private readonly dispatchPolicy: DispatchPolicy = DEFAULT_DISPATCH_POLICY,
  ) {}

  // =========================================================================
  // Availability
  // =========================================================================

  async list(query: AvailabilityQuery) {
    const organizationId = getOrganizationId();
    const at = query.at ? new Date(query.at) : new Date();

    const assets = await this.repository.listAssetRefs(organizationId, query);
    const assetIds = assets.items.map((asset) => asset.id);

    // Two batched reads rather than one per asset. The N+1 version of this is
    // the query behind every fleet dashboard, so it would be the first thing
    // to fall over.
    const [assignments, windows, fenced] = await Promise.all([
      this.repository.findActiveAssignments(assetIds),
      this.repository.findWindowsInForce(at, assetIds),
      this.repository.findFencedAssetIds(assetIds),
    ]);

    const assignmentByAsset = new Map(assignments.map((a) => [a.assetId, a]));
    const windowByAsset = new Map<string, (typeof windows)[number]>();
    // Windows arrive newest-first, so the first one seen for an asset is the
    // most recently declared and wins.
    for (const window of windows) {
      if (!windowByAsset.has(window.assetId)) windowByAsset.set(window.assetId, window);
    }

    const items: AvailabilityView[] = assets.items.map((asset) => {
      const assignment = assignmentByAsset.get(asset.id);
      const window = windowByAsset.get(asset.id);
      const blockers = describeBlockers(
        asset,
        assignment,
        window,
        this.dispatchPolicy,
        fenced.has(asset.id),
      );

      return {
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.assetType,
        assetTag: asset.assetTag,
        available: blockers.length === 0,
        blockers,
        currentAssignment: assignment
          ? {
              id: assignment.id,
              driverId: assignment.driverId,
              startedAt: assignment.startedAt.toISOString(),
            }
          : null,
      };
    });

    this.recordAvailabilityGauge(items);

    const filtered = query.availableOnly ? items.filter((item) => item.available) : items;

    return {
      items: filtered,
      // Deliberately the unfiltered page's cursor. `availableOnly` filters
      // after paging, so a page can come back short; the cursor still
      // describes a real position, which is what keeps "next page" correct.
      nextCursor: assets.nextCursor,
      hasMore: assets.hasMore,
      at: at.toISOString(),
    };
  }

  /**
   * Records a fleet manager's statement about a machine's future availability.
   *
   * This is the only part of availability fleet-service decides for itself.
   * It cannot make an unavailable machine available — a declared window sits
   * alongside the other blockers rather than overriding them, because
   * declaring a machine free does not renew its insurance.
   */
  async declare(
    dto: DeclareAvailabilityDto,
    fence?: ClaimFence<AvailabilityWindowView>,
  ): Promise<AvailabilityWindowView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    await this.assertAssetVisible(dto.assetId);

    const fromAt = dto.fromAt ? new Date(dto.fromAt) : new Date();
    const toAt = dto.toAt ? new Date(dto.toAt) : null;
    const id = `${ID_PREFIXES.availabilityWindow}_${ulid()}`;

    return this.repository.transaction(async (tx) => {
      // The claim is locked by its token before anything else, so a declaration
      // whose claim lapsed and was re-taken by a retry commits nothing.
      if (fence) await fence.hold(tx);

      // One declaration at a time per machine, and the machine's owner read
      // under the same lock. The lock is the one the asset-sync consumer takes
      // to apply a transfer, so a declaration either commits before the
      // transfer is applied (and is then revoked by it) or finds the machine
      // already another organization's and is refused like any foreign machine.
      // Without it, two declarations with different keys each saw no live
      // window to supersede and each created one (review #225 round 1).
      await this.repository.lockAssetRef(tx, dto.assetId);
      const asset = await this.repository.findAssetRef(organizationId, dto.assetId, tx);
      if (!asset) {
        throw RastaError.notFound('Asset', dto.assetId);
      }

      // A new declaration supersedes the previous one for the same machine
      // rather than stacking with it: two open-ended windows saying opposite
      // things would make the composed answer depend on row order. The partial
      // unique index `ux_availability_window_live` holds this at the database.
      await tx.availabilityWindow.updateMany({
        where: { organizationId, assetId: dto.assetId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actor },
      });

      const window = await tx.availabilityWindow.create({
        data: {
          id,
          organizationId,
          assetId: dto.assetId,
          available: dto.available,
          fromAt,
          toAt,
          reason: dto.reason,
          createdBy: actor,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'AvailabilityWindow',
        aggregateId: id,
        eventName: FLEET_EVENTS.AVAILABILITY_CHANGED,
        topic: FLEET_TOPIC,
        organizationId,
        payload: validateFleetPayload(FLEET_EVENTS.AVAILABILITY_CHANGED, {
          assetId: dto.assetId,
          organizationId,
          available: dto.available,
          reason: dto.reason,
          from: fromAt.toISOString(),
          to: toAt?.toISOString() ?? null,
        }),
      });

      const view = toWindowView(window);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  /**
   * The machine is one of the caller's organization's — or `404`, exactly as
   * for one that does not exist. A replay passes this before it answers
   * (`ReplayGuard`): a stored 201 must not outlive the machine leaving the
   * caller's tenant.
   */
  async assertAssetVisible(assetId: string): Promise<void> {
    const asset = await this.repository.findAssetRef(getOrganizationId(), assetId);
    if (!asset) {
      throw RastaError.notFound('Asset', assetId);
    }
  }

  /**
   * A machine's declarations, newest first, revoked ones included — the
   * history a fleet manager is asked about ("why was this machine unavailable
   * last March?"), and the only way to learn the id a revoke names.
   */
  async listWindows(query: ListAvailabilityWindowsQuery) {
    await this.assertAssetVisible(query.assetId);
    const rows = await this.repository.listAvailabilityWindows(query);
    return {
      items: rows.items.map(toWindowView),
      nextCursor: rows.nextCursor,
      hasMore: rows.hasMore,
    };
  }

  async revoke(id: string): Promise<AvailabilityWindowView> {
    const window = await this.repository.findAvailabilityWindowById(id);
    if (!window) throw RastaError.notFound('AvailabilityWindow', id);
    if (window.revokedAt) {
      throw RastaError.invalidStateTransition(
        'AvailabilityWindow',
        'REVOKED',
        'REVOKED',
        'This availability window has already been revoked',
      );
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const revokedAt = new Date();

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.availabilityWindow.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt, revokedBy: actor },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'AvailabilityWindow',
          'REVOKED',
          'REVOKED',
          'This availability window was revoked by another request',
        );
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'AvailabilityWindow',
        aggregateId: id,
        eventName: FLEET_EVENTS.AVAILABILITY_CHANGED,
        topic: FLEET_TOPIC,
        organizationId: window.organizationId,
        payload: validateFleetPayload(FLEET_EVENTS.AVAILABILITY_CHANGED, {
          assetId: window.assetId,
          organizationId: window.organizationId,
          // Revoking a declaration returns the machine to whatever the other
          // services say about it. Reported as available because the fleet's
          // own objection is withdrawn; the composed view still applies the
          // rest.
          available: true,
          reason: `Declaration withdrawn: ${window.reason}`,
          from: revokedAt.toISOString(),
          to: null,
        }),
      });

      return tx.availabilityWindow.findFirstOrThrow({ where: { id } });
    });

    return toWindowView(updated);
  }

  // =========================================================================
  // Utilization
  // =========================================================================

  /**
   * How much of the available time each machine actually worked.
   *
   * Deliberately a query over the operational records this service already
   * holds, not an analytics engine. `analytics-service` owns cross-domain
   * reporting (docs/04 § 4.15); duplicating its job here would mean two places
   * computing the same number from different data.
   *
   * The denominator comes from configuration, not from a constant: how many
   * hours a day a machine counts as available is a business fact the product
   * document does not state, and an organization running two shifts changes it
   * without a code change (AGENTS.md § 9).
   */
  async utilization(
    query: UtilizationQuery,
    windowDays: number,
    availableHoursPerDay: number,
  ): Promise<{ items: UtilizationView[]; from: string; to: string }> {
    const organizationId = getOrganizationId();

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - windowDays * 86_400_000);

    if (from >= to) {
      throw RastaError.businessRule('The reporting window must start before it ends.', {
        rule: 'INVALID_WINDOW',
        from: from.toISOString(),
        to: to.toISOString(),
      });
    }

    const totals = await this.repository.usageTotals(organizationId, from, to, query);
    const assetIds = totals.map((row) => row.asset_id);

    // Two batched reads, not one per asset. Decorating the report with names
    // one row at a time would issue up to `limit` round trips — the query that
    // grows with the fleet rather than with the page.
    const [counts, assets] = await Promise.all([
      this.repository.assignmentCounts(organizationId, from, to, assetIds),
      this.repository.findAssetRefs(organizationId, assetIds),
    ]);

    const countByAsset = new Map(counts.map((row) => [row.asset_id, row.assignment_count]));
    const nameByAsset = new Map(assets.map((asset) => [asset.id, asset.name]));

    const windowHours = ((to.getTime() - from.getTime()) / 86_400_000) * availableHoursPerDay;

    const items = totals.map((row): UtilizationView => {
      const usedHours = Number(row.total_hours);

      return {
        assetId: row.asset_id,
        assetName: nameByAsset.get(row.asset_id) ?? null,
        from: from.toISOString(),
        to: to.toISOString(),
        usedHours: row.total_hours,
        kilometres: row.total_kilometres,
        availableHours: windowHours.toFixed(2),
        // Null, never zero, when there is nothing to divide. The platform
        // refuses to report an absent measurement as a measured absence — the
        // same rule analytics-service applies with INSUFFICIENT_BASELINE
        // (docs/04 § 4.15).
        utilizationPercent:
          row.record_count === 0 || windowHours <= 0
            ? null
            : ((usedHours / windowHours) * 100).toFixed(1),
        recordCount: row.record_count,
        assignmentCount: countByAsset.get(row.asset_id) ?? 0,
      };
    });

    return { items, from: from.toISOString(), to: to.toISOString() };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private recordAvailabilityGauge(items: readonly AvailabilityView[]): void {
    const counts = new Map<string, number>();
    for (const item of items) {
      // Only the first blocker is counted, so one machine contributes one to
      // the gauge and the series stays readable as "machines held up by X".
      const primary = item.blockers[0];
      if (!primary) continue;
      counts.set(primary.code, (counts.get(primary.code) ?? 0) + 1);
    }

    for (const [reason, count] of counts) {
      assetsUnavailableTotal.set({ service: SERVICE_NAME, reason }, count);
    }
  }
}

/**
 * Every reason this machine cannot go out, most specific first.
 *
 * All of them, not just the first: a fleet manager who clears one blocker
 * should not have to re-run the query to discover the next. The ordering puts
 * the ones a human can act on soonest at the top.
 */
function describeBlockers(
  asset: {
    status: string;
    inMaintenance: boolean;
  } & DispatchBlockFields,
  assignment: { id: string; driverId: string } | undefined,
  window: { available: boolean; reason: string } | undefined,
  dispatchPolicy: DispatchPolicy = DEFAULT_DISPATCH_POLICY,
  transferPending = false,
): AvailabilityBlocker[] {
  const blockers: AvailabilityBlocker[] = [];

  // A transfer asked whether the machine is free and was told yes (ADR-062):
  // assignment refuses it, so the listing must not call it available. Any
  // fence counts, an expired one too — expiry is not an answer. Reported as
  // `ASSET_STATUS`, the code the portal already has a sentence for: a new code
  // would be one it cannot word (its contract spec lists every code).
  if (transferPending) {
    blockers.push({
      code: 'ASSET_STATUS',
      owner: 'asset-service',
      detail: 'The machine is being transferred to another organization',
    });
  }

  // One blocker per cause, never merged (L3-02): a fleet manager clearing
  // the inspection must still be told the insurance has lapsed, and vice
  // versa. The code stays `DISPATCH_BLOCKED` — the contract ADR-026 published
  // — and each entry's detail names the cause.
  for (const block of activeDispatchBlocks(asset, new Date(), dispatchPolicy)) {
    blockers.push({
      code: 'DISPATCH_BLOCKED',
      owner: 'asset-service',
      detail: block.detail,
      cause: block.cause,
      ...(block.coverages ? { coverages: block.coverages } : {}),
    });
  }

  if (asset.inMaintenance) {
    blockers.push({
      code: 'IN_MAINTENANCE',
      owner: 'maintenance-service',
      detail: 'The machine is withdrawn for repair',
    });
  }

  if (!ACTIVE_ASSET_STATUSES.includes(asset.status)) {
    blockers.push({
      code: 'ASSET_STATUS',
      owner: 'asset-service',
      detail: `The machine is in state ${asset.status}`,
    });
  }

  if (assignment) {
    blockers.push({
      code: 'ACTIVE_ASSIGNMENT',
      owner: 'fleet-service',
      detail: `Assigned to driver ${assignment.driverId}`,
    });
  }

  if (window && !window.available) {
    blockers.push({
      code: 'DECLARED_UNAVAILABLE',
      owner: 'fleet-service',
      detail: window.reason,
    });
  }

  return blockers;
}

interface WindowRow {
  id: string;
  assetId: string;
  available: boolean;
  fromAt: Date;
  toAt: Date | null;
  reason: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export function toWindowView(window: WindowRow): AvailabilityWindowView {
  return {
    id: window.id,
    assetId: window.assetId,
    available: window.available,
    fromAt: window.fromAt.toISOString(),
    toAt: window.toAt?.toISOString() ?? null,
    reason: window.reason,
    createdAt: window.createdAt.toISOString(),
    revokedAt: window.revokedAt?.toISOString() ?? null,
  };
}

export { describeBlockers };
