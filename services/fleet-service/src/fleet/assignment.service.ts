import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { assignmentConflictsTotal, assignmentsCreatedTotal } from '../observability/metrics';
import { FleetRepository, isUniqueViolation, violatedConstraint } from './fleet.repository';
import { FLEET_EVENTS, validateFleetPayload } from './events';
import { FLEET_TOPIC, SERVICE_NAME } from '../config/env';
import { assertOwnDriverRecord, currentFleetScope } from './access';
import { isAssignable } from './driver-lifecycle';
import { ACTIVE_ASSET_STATUSES, identifyExclusivityConstraint } from './constraints';
import type {
  AssignmentView,
  CreateAssignmentDto,
  EndAssignmentDto,
  ListAssignmentsQuery,
} from './dto';

/**
 * Assignments — the operational relationship between a driver and a machine.
 *
 * Two invariants shape everything here, and both are enforced by partial
 * unique indexes rather than by the checks in this file:
 *
 *   one active assignment per driver   documented (docs/03 § 3.3, docs/05 § 5.5)
 *   one active assignment per asset    decided in ADR-025
 *
 * The pre-flight checks below exist only to produce a good error message. They
 * cannot be the enforcement, because between reading "no active assignment"
 * and writing one, a concurrent request can do exactly the same — and two
 * requests that both pass the check would both insert. The index is what
 * actually holds the line; the check is what stops the common case from
 * arriving as a bare constraint violation. See ADR-025.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(private readonly repository: FleetRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<AssignmentView> {
    const assignment = await this.repository.findAssignmentById(id);
    if (!assignment) throw RastaError.notFound('Assignment', id);

    const scope = currentFleetScope();
    if (scope.kind !== 'SUPERVISOR') {
      const driver = await this.repository.findDriverById(assignment.driverId);
      assertOwnDriverRecord(scope, driver, 'Assignment', id);
    }

    return toAssignmentView(assignment);
  }

  async list(query: ListAssignmentsQuery) {
    const scope = currentFleetScope();

    let effective = query;
    if (scope.kind === 'SELF') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      // No driver record means no assignments — an empty page, not an error.
      // Applied as a filter rather than by discarding rows afterwards, so the
      // cursor still describes a real position in the result set.
      if (!own) return { items: [], nextCursor: null, hasMore: false };
      if (query.driverId && query.driverId !== own.id) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      effective = { ...query, driverId: own.id };
    }

    const result = await this.repository.listAssignments(effective);
    return {
      items: result.items.map(toAssignmentView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Puts a driver in charge of a machine.
   *
   * The order of checks is deliberate: everything cheap and local first, then
   * the write, and the database has the last word on exclusivity.
   */
  async create(dto: CreateAssignmentDto): Promise<AssignmentView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    const driver = await this.repository.findDriverById(dto.driverId);
    if (!driver) throw RastaError.notFound('Driver', dto.driverId);

    if (!isAssignable(driver.status)) {
      throw RastaError.businessRule(
        `A ${driver.status.toLowerCase()} driver cannot be given a new assignment.`,
        { rule: 'DRIVER_NOT_ASSIGNABLE', driverId: driver.id, status: driver.status },
      );
    }

    await this.assertAssetAssignable(dto.assetId);

    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date();
    if (startedAt.getTime() > Date.now()) {
      // This service does not model scheduled assignments. Accepting a future
      // start would make `ended_at IS NULL` mean "active" for something that
      // has not begun, and the exclusivity indexes are written against exactly
      // that column.
      throw RastaError.businessRule(
        'An assignment cannot start in the future; scheduling is not modelled.',
        { rule: 'FUTURE_START', startedAt: startedAt.toISOString() },
      );
    }

    // Pre-flight, for the error message only. See the class comment.
    await this.explainExistingConflicts(dto.driverId, dto.assetId);

    const id = `${ID_PREFIXES.assignment}_${ulid()}`;

    try {
      const created = await this.repository.transaction(async (tx) => {
        const assignment = await tx.assignment.create({
          data: {
            id,
            organizationId,
            driverId: dto.driverId,
            assetId: dto.assetId,
            startedAt,
            purpose: dto.purpose ?? null,
            assignedBy: actor,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'Assignment',
          aggregateId: id,
          eventName: FLEET_EVENTS.ASSET_ASSIGNED,
          topic: FLEET_TOPIC,
          organizationId,
          // Keyed by asset rather than by assignment id. asset-service builds
          // the machine's dossier from this stream and moves it to ASSIGNED;
          // if the assign and the later release landed on different
          // partitions, Kafka would guarantee nothing about their order and a
          // released machine could end up stuck in ASSIGNED (docs/07 § 7.7).
          partitionKey: dto.assetId,
          payload: validateFleetPayload(FLEET_EVENTS.ASSET_ASSIGNED, {
            assignmentId: id,
            assetId: dto.assetId,
            driverId: dto.driverId,
            organizationId,
            startedAt: startedAt.toISOString(),
            purpose: dto.purpose ?? null,
          }),
        });

        return assignment;
      });

      assignmentsCreatedTotal.inc({ service: SERVICE_NAME });
      return toAssignmentView(created);
    } catch (error) {
      throw this.translateExclusivityViolation(error, dto.driverId, dto.assetId);
    }
  }

  /**
   * Releases the machine.
   *
   * The update is guarded on `ended_at IS NULL` and the affected-row count is
   * checked, which is what makes two simultaneous "end this" requests safe:
   * exactly one updates a row, the other sees zero and is told the assignment
   * has already ended. No lock is taken — the guard is the concurrency
   * control, and it costs nothing (ADR-025).
   */
  async end(id: string, dto: EndAssignmentDto): Promise<AssignmentView> {
    const assignment = await this.repository.findAssignmentById(id);
    if (!assignment) throw RastaError.notFound('Assignment', id);

    if (assignment.endedAt) {
      throw RastaError.invalidStateTransition(
        'Assignment',
        'ENDED',
        'ENDED',
        'This assignment has already ended',
      );
    }

    const endedAt = dto.endedAt ? new Date(dto.endedAt) : new Date();
    if (endedAt < assignment.startedAt) {
      throw RastaError.businessRule('An assignment cannot end before it started.', {
        rule: 'END_BEFORE_START',
        startedAt: assignment.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
    }

    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.assignment.updateMany({
        // `endedAt: null` is the whole guard. Without it, the second of two
        // concurrent requests would overwrite the first one's end time and
        // both would report success.
        where: { id, endedAt: null },
        data: {
          endedAt,
          endedBy: actor,
          endReason: dto.reason,
          endNotes: dto.notes ?? null,
        },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'Assignment',
          'ENDED',
          'ENDED',
          'This assignment was ended by another request',
        );
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Assignment',
        aggregateId: id,
        eventName: FLEET_EVENTS.ASSIGNMENT_ENDED,
        topic: FLEET_TOPIC,
        organizationId: assignment.organizationId,
        partitionKey: assignment.assetId,
        payload: validateFleetPayload(FLEET_EVENTS.ASSIGNMENT_ENDED, {
          assignmentId: id,
          assetId: assignment.assetId,
          driverId: assignment.driverId,
          organizationId: assignment.organizationId,
          startedAt: assignment.startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          reason: dto.reason,
        }),
      });

      return tx.assignment.findFirstOrThrow({ where: { id } });
    });

    return toAssignmentView(updated);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Refuses a machine the fleet has been told not to dispatch.
   *
   * Every fact consulted here is owned by another service and mirrored into
   * `asset_ref` by the event consumer. That is a deliberate trade: the replica
   * can be seconds stale, and the alternative — an HTTP call to asset-service
   * on every assignment — would make assigning a driver fail whenever
   * asset-service is down, which is precisely the coupling docs/03 § 3.6
   * rejects.
   *
   * An asset this service has never heard of is refused rather than allowed.
   * The replica is built from `ASSET_CREATED` onwards from offset zero, so a
   * genuine machine is present within seconds of registration; an id that
   * never appears is a typo or another tenant's machine, and assigning a
   * driver to it would create an assignment nobody can ever see.
   */
  private async assertAssetAssignable(assetId: string): Promise<void> {
    const asset = await this.repository.findAssetRef(assetId);

    if (!asset) {
      throw RastaError.notFound('Asset', assetId);
    }

    if (asset.organizationId !== getOrganizationId()) {
      // Reported as absent, not as forbidden: confirming the machine exists
      // elsewhere would let a caller enumerate another organization's fleet.
      throw RastaError.notFound('Asset', assetId);
    }

    if (asset.dispatchBlockedReason) {
      throw RastaError.businessRule(
        'This machine has been withdrawn from dispatch and cannot be assigned.',
        {
          rule: 'ASSET_DISPATCH_BLOCKED',
          assetId,
          detail: asset.dispatchBlockedReason,
          owner: 'asset-service',
        },
      );
    }

    if (asset.inMaintenance) {
      throw RastaError.businessRule('This machine is in maintenance and cannot be assigned.', {
        rule: 'ASSET_IN_MAINTENANCE',
        assetId,
        owner: 'maintenance-service',
      });
    }

    if (!ACTIVE_ASSET_STATUSES.includes(asset.status)) {
      throw RastaError.businessRule(
        `A machine in state ${asset.status} cannot be assigned to a driver.`,
        { rule: 'ASSET_NOT_OPERABLE', assetId, status: asset.status, owner: 'asset-service' },
      );
    }
  }

  /**
   * Turns an existing conflict into a message that names it.
   *
   * Advisory only. The database still has the last word, and
   * {@link translateExclusivityViolation} handles the case where a concurrent
   * request slipped in between this read and the insert.
   */
  private async explainExistingConflicts(driverId: string, assetId: string): Promise<void> {
    const [driverBusy, assetBusy] = await Promise.all([
      this.repository.findActiveAssignmentForDriver(driverId),
      this.repository.findActiveAssignmentForAsset(assetId),
    ]);

    if (driverBusy) {
      assignmentConflictsTotal.inc({ service: SERVICE_NAME, constraint: 'driver' });
      throw RastaError.businessRule(
        'This driver already holds an active assignment. End it before starting another.',
        { rule: 'DRIVER_ALREADY_ASSIGNED', driverId, assignmentId: driverBusy.id },
      );
    }

    if (assetBusy) {
      assignmentConflictsTotal.inc({ service: SERVICE_NAME, constraint: 'asset' });
      throw RastaError.businessRule(
        'This machine is already assigned to a driver. End that assignment first.',
        { rule: 'ASSET_ALREADY_ASSIGNED', assetId, assignmentId: assetBusy.id },
      );
    }
  }

  /**
   * Maps a partial-unique-index violation onto the invariant it protected.
   *
   * This is the path a genuine race takes: both requests passed the pre-flight
   * check, one committed, and the other landed here. The caller is told the
   * same thing they would have been told a millisecond earlier, so a race is
   * indistinguishable from an ordinary conflict — which is the point.
   */
  private translateExclusivityViolation(
    error: unknown,
    driverId: string,
    assetId: string,
  ): unknown {
    if (!isUniqueViolation(error)) return error;

    const target = violatedConstraint(error);
    const constraint = identifyExclusivityConstraint(target);
    this.logger.warn(
      `Assignment exclusivity violated on ${target ?? 'an unnamed constraint'} (${constraint})`,
    );
    assignmentConflictsTotal.inc({ service: SERVICE_NAME, constraint });

    if (constraint === 'driver') {
      return RastaError.businessRule(
        'This driver already holds an active assignment. End it before starting another.',
        { rule: 'DRIVER_ALREADY_ASSIGNED', driverId, concurrent: true },
      );
    }

    if (constraint === 'asset') {
      return RastaError.businessRule(
        'This machine is already assigned to a driver. End that assignment first.',
        { rule: 'ASSET_ALREADY_ASSIGNED', assetId, concurrent: true },
      );
    }

    // Some other unique index. Reported as a conflict rather than swallowed:
    // an unexplained 500 would hide it, and a generic success would be worse.
    return RastaError.alreadyExists('Assignment');
  }
}

// ---------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  organizationId: string;
  driverId: string;
  assetId: string;
  startedAt: Date;
  endedAt: Date | null;
  purpose: string | null;
  endReason: string | null;
  endNotes: string | null;
  assignedBy: string;
  endedBy: string | null;
}

export function toAssignmentView(assignment: AssignmentRow): AssignmentView {
  return {
    id: assignment.id,
    organizationId: assignment.organizationId,
    driverId: assignment.driverId,
    assetId: assignment.assetId,
    // Derived, never stored. One column decides active-ness; a second
    // representation of the same fact would eventually disagree with it.
    active: assignment.endedAt === null,
    startedAt: assignment.startedAt.toISOString(),
    endedAt: assignment.endedAt?.toISOString() ?? null,
    purpose: assignment.purpose,
    endReason: assignment.endReason,
    endNotes: assignment.endNotes,
    assignedBy: assignment.assignedBy,
    endedBy: assignment.endedBy,
  };
}
