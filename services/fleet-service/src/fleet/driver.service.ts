import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { FleetRepository, isUniqueViolation } from './fleet.repository';
import { FLEET_EVENTS, validateFleetPayload } from './events';
import { FLEET_TOPIC } from '../config/env';
import { assertOwnDriverRecord, currentFleetScope } from './access';
import { assertDriverTransition } from './driver-lifecycle';
import type {
  ChangeDriverStatusDto,
  CreateDriverDto,
  DriverView,
  ListDriversQuery,
  UpdateDriverDto,
} from './dto';

/**
 * The driver half of the fleet domain.
 *
 * A driver is an operational role a person holds inside one organization, not
 * a second copy of their platform account (docs/03 § 3.2). Nothing here
 * duplicates identity-service: the row holds a `userId` and the facts fleet
 * needs about how that person operates machinery, and identity remains the
 * single place a person is created, named or authenticated.
 */
@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

  constructor(private readonly repository: FleetRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<DriverView> {
    const driver = await this.repository.findDriverById(id);
    if (!driver) throw RastaError.notFound('Driver', id);

    // The tenant guard already refused another organization's row; this is the
    // second, object-level check: an operator may read only their own record.
    assertOwnDriverRecord(currentFleetScope(), driver, 'Driver', id);

    return toDriverView(driver);
  }

  async list(query: ListDriversQuery) {
    const scope = currentFleetScope();

    // An operator's list is their own record, not a filtered view of everyone
    // else's. Applied as a query constraint rather than by filtering the
    // results, so pagination stays correct.
    const effective: ListDriversQuery =
      scope.kind === 'SUPERVISOR' ? query : { ...query, userId: scope.userId };

    const result = await this.repository.listDrivers(effective);
    return {
      items: result.items.map(toDriverView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  /**
   * The driver record belonging to the calling user, if any.
   *
   * Returns null rather than throwing when the caller is not a driver here:
   * an administrator asking "am I a driver?" and hearing "no" is a normal
   * answer, not an error condition.
   */
  async findForCurrentUser() {
    const userId = getContext().userId;
    if (!userId) return null;
    return this.repository.findDriverByUserId(userId);
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(dto: CreateDriverDto): Promise<DriverView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';
    const id = `${ID_PREFIXES.driver}_${ulid()}`;

    try {
      const created = await this.repository.transaction(async (tx) => {
        const driver = await tx.driver.create({
          data: {
            id,
            organizationId,
            userId: dto.userId,
            employeeNo: dto.employeeNo ?? null,
            licenceNumber: dto.licenceNumber ?? null,
            licenceClass: dto.licenceClass ?? null,
            licenceValidTo: dto.licenceValidTo ? new Date(dto.licenceValidTo) : null,
            notes: dto.notes ?? null,
            status: 'ACTIVE',
            createdBy: actor,
            updatedBy: actor,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'Driver',
          aggregateId: id,
          eventName: FLEET_EVENTS.DRIVER_REGISTERED,
          topic: FLEET_TOPIC,
          organizationId,
          payload: validateFleetPayload(FLEET_EVENTS.DRIVER_REGISTERED, {
            driverId: id,
            organizationId,
            userId: dto.userId,
            status: 'ACTIVE',
          }),
        });

        return driver;
      });

      return toDriverView(created);
    } catch (error) {
      // The unique index on (organization_id, user_id) is the real guard: a
      // check-then-insert would lose to a concurrent request, and a second
      // driver row for the same person would make "this driver's active
      // assignment" ambiguous — the invariant the whole assignment model rests
      // on.
      if (isUniqueViolation(error)) {
        throw RastaError.alreadyExists('Driver', dto.userId);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateDriverDto): Promise<DriverView> {
    const driver = await this.repository.findDriverById(id);
    if (!driver) throw RastaError.notFound('Driver', id);

    if (driver.status === 'DEACTIVATED') {
      throw RastaError.invalidStateTransition(
        'Driver',
        driver.status,
        driver.status,
        'A deactivated driver is a historical record and cannot be edited',
      );
    }

    const actor = getContext().userId ?? 'SYSTEM';

    // Guarded on `version`, so two concurrent edits cannot silently interleave
    // and leave the row holding a mix of both. The loser is told to reload
    // rather than having its write vanish.
    const result = await this.repository.client.driver.updateMany({
      where: { id, version: driver.version },
      data: {
        ...(dto.employeeNo !== undefined ? { employeeNo: dto.employeeNo } : {}),
        ...(dto.licenceNumber !== undefined ? { licenceNumber: dto.licenceNumber } : {}),
        ...(dto.licenceClass !== undefined ? { licenceClass: dto.licenceClass } : {}),
        ...(dto.licenceValidTo !== undefined
          ? { licenceValidTo: dto.licenceValidTo ? new Date(dto.licenceValidTo) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        updatedBy: actor,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) throw RastaError.optimisticLockFailed('Driver', id);

    const updated = await this.repository.findDriverById(id);
    if (!updated) throw RastaError.notFound('Driver', id);
    return toDriverView(updated);
  }

  /**
   * Moves a driver between lifecycle states.
   *
   * Barring a driver has a consequence beyond their own row: they may be
   * holding a machine right now. Leaving that assignment open would leave the
   * asset marked `ASSIGNED` in asset-service with nobody entitled to operate
   * it, so the assignment is ended in the same transaction and the release is
   * published like any other — through the outbox, not as a side effect
   * somewhere downstream.
   */
  async changeStatus(id: string, dto: ChangeDriverStatusDto): Promise<DriverView> {
    const driver = await this.repository.findDriverById(id);
    if (!driver) throw RastaError.notFound('Driver', id);

    assertDriverTransition(driver.status, dto.status);

    const actor = getContext().userId ?? 'SYSTEM';
    const now = new Date();
    const barred = dto.status !== 'ACTIVE';

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.driver.updateMany({
        where: { id, version: driver.version },
        data: {
          status: dto.status,
          statusReason: dto.reason,
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) throw RastaError.optimisticLockFailed('Driver', id);

      if (barred) {
        const ended = await this.repository.endActiveAssignmentsForDriver(
          tx,
          id,
          now,
          actor,
          'DRIVER_UNAVAILABLE',
          dto.reason,
        );

        for (const assignment of ended) {
          await this.repository.enqueueEvent(tx, {
            aggregateType: 'Assignment',
            aggregateId: assignment.id,
            eventName: FLEET_EVENTS.ASSIGNMENT_ENDED,
            topic: FLEET_TOPIC,
            organizationId: driver.organizationId,
            // Keyed by asset, not by assignment: asset-service's projector
            // needs this event ordered against the ASSET_ASSIGNED that opened
            // it, and ordering is only guaranteed within a partition
            // (docs/07 § 7.7).
            partitionKey: assignment.assetId,
            payload: validateFleetPayload(FLEET_EVENTS.ASSIGNMENT_ENDED, {
              assignmentId: assignment.id,
              assetId: assignment.assetId,
              driverId: id,
              organizationId: driver.organizationId,
              startedAt: assignment.startedAt.toISOString(),
              endedAt: now.toISOString(),
              reason: 'DRIVER_UNAVAILABLE',
            }),
          });
        }

        if (ended.length > 0) {
          this.logger.log(
            `Ended ${ended.length} active assignment(s) because driver ${id} became ${dto.status}`,
          );
        }
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Driver',
        aggregateId: id,
        eventName: FLEET_EVENTS.DRIVER_STATUS_CHANGED,
        topic: FLEET_TOPIC,
        organizationId: driver.organizationId,
        payload: validateFleetPayload(FLEET_EVENTS.DRIVER_STATUS_CHANGED, {
          driverId: id,
          organizationId: driver.organizationId,
          userId: driver.userId,
          previousStatus: driver.status,
          newStatus: dto.status,
          reason: dto.reason,
        }),
      });

      return tx.driver.findFirstOrThrow({ where: { id } });
    });

    return toDriverView(updated);
  }
}

// ---------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------

interface DriverRow {
  id: string;
  organizationId: string;
  userId: string;
  employeeNo: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  licenceValidTo: Date | null;
  status: string;
  statusReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toDriverView(driver: DriverRow): DriverView {
  return {
    id: driver.id,
    organizationId: driver.organizationId,
    userId: driver.userId,
    employeeNo: driver.employeeNo,
    licenceNumber: driver.licenceNumber,
    licenceClass: driver.licenceClass,
    licenceValidTo: driver.licenceValidTo?.toISOString() ?? null,
    status: driver.status,
    statusReason: driver.statusReason,
    notes: driver.notes,
    createdAt: driver.createdAt.toISOString(),
    updatedAt: driver.updatedAt.toISOString(),
  };
}
