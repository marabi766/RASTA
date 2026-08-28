import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { usageDuplicatesTotal, usageRecordsTotal } from '../observability/metrics';
import { FleetRepository, isUniqueViolation } from './fleet.repository';
import { FLEET_EVENTS, validateFleetPayload } from './events';
import { FLEET_TOPIC, SERVICE_NAME } from '../config/env';
import { currentFleetScope } from './access';
import type { ListUsageQuery, RecordUsageDto, UsageRecordView } from './dto';

/**
 * Usage recording — the busiest write path in the fleet domain.
 *
 * `USAGE_RECORDED` is the event that drives usage-based maintenance schedules
 * (docs/04 § 4.6): "service every 250 hours" is evaluated by
 * maintenance-service consuming this stream. That makes accuracy here a safety
 * property rather than a reporting nicety, and it is why quantities are
 * NUMERIC end to end and never pass through a float.
 *
 * The other shaping force is the field. The product asks for offline capture
 * that syncs later (docs/17), so the same reading *will* be submitted twice.
 * A resubmission carrying the same `clientReference` returns the record that
 * already exists rather than adding a second one — and, importantly, does not
 * publish a second event, because maintenance-service would count those hours
 * twice.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly repository: FleetRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<UsageRecordView> {
    const record = await this.repository.findUsageById(id);
    if (!record) throw RastaError.notFound('UsageRecord', id);

    const scope = currentFleetScope();
    if (scope.kind !== 'SUPERVISOR') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      // Reported as absent rather than forbidden: a 403 would confirm that a
      // reading exists for a machine the caller is not entitled to see.
      if (!own || record.driverId !== own.id) throw RastaError.notFound('UsageRecord', id);
    }

    return toUsageView(record);
  }

  async list(query: ListUsageQuery) {
    const scope = currentFleetScope();

    let effective = query;
    if (scope.kind === 'SELF') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      if (!own) return { items: [], nextCursor: null, hasMore: false };
      if (query.driverId && query.driverId !== own.id) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      effective = { ...query, driverId: own.id };
    }

    const result = await this.repository.listUsage(effective);
    return {
      items: result.items.map(toUsageView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async record(dto: RecordUsageDto): Promise<UsageRecordView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    // Replay check first, before any validation that could reject a record
    // that was already accepted once. A tablet resyncing a week-old reading
    // must get back the record it created then, not a fresh refusal because
    // the driver has since been suspended.
    if (dto.clientReference) {
      const existing = await this.repository.findUsageByClientReference(dto.clientReference);
      if (existing) {
        usageDuplicatesTotal.inc({ service: SERVICE_NAME });
        this.logger.debug(
          `Usage submission ${dto.clientReference} matched existing ${existing.id}`,
        );
        return toUsageView(existing);
      }
    }

    const asset = await this.repository.findAssetRef(dto.assetId);
    if (!asset || asset.organizationId !== organizationId) {
      // Absent, not forbidden — the same non-disclosure rule the rest of the
      // platform follows for a resource in another tenant.
      throw RastaError.notFound('Asset', dto.assetId);
    }

    const { driverId, assignmentId } = await this.resolveOperator(dto);

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodEnd.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      // A small tolerance absorbs clock skew on a field device; anything
      // beyond it is a wrong date, and accepting it would put usage into a
      // reporting window before the work happened.
      throw RastaError.businessRule('Usage cannot be recorded for a period in the future.', {
        rule: 'FUTURE_PERIOD',
        periodEnd: periodEnd.toISOString(),
      });
    }

    const id = `${ID_PREFIXES.usageRecord}_${ulid()}`;

    try {
      const created = await this.repository.transaction(async (tx) => {
        const record = await tx.usageRecord.create({
          data: {
            id,
            organizationId,
            assetId: dto.assetId,
            driverId,
            assignmentId,
            periodStart,
            periodEnd,
            hours: dto.hours ?? null,
            kilometres: dto.kilometres ?? null,
            hourMeter: dto.hourMeter ?? null,
            odometer: dto.odometer ?? null,
            source: dto.source,
            notes: dto.notes ?? null,
            clientReference: dto.clientReference ?? null,
            recordedBy: actor,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'UsageRecord',
          aggregateId: id,
          eventName: FLEET_EVENTS.USAGE_RECORDED,
          topic: FLEET_TOPIC,
          organizationId,
          // Keyed by asset: every consumer of this event — the dossier, the
          // maintenance schedule — reasons about one machine's readings in
          // order, and ordering is only guaranteed within a partition.
          partitionKey: dto.assetId,
          payload: validateFleetPayload(FLEET_EVENTS.USAGE_RECORDED, {
            usageRecordId: id,
            assetId: dto.assetId,
            organizationId,
            driverId,
            assignmentId,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            // Strings, for the same reason money is a string (ADR-022): the
            // column is NUMERIC and a JSON float would reintroduce exactly the
            // drift the column type exists to prevent.
            hours: dto.hours ?? null,
            kilometres: dto.kilometres ?? null,
            hourMeter: dto.hourMeter ?? null,
            odometer: dto.odometer ?? null,
            source: dto.source,
          }),
        });

        return record;
      });

      usageRecordsTotal.inc({ service: SERVICE_NAME, source: dto.source });
      return toUsageView(created);
    } catch (error) {
      // Two tablets replaying the same queued reading at once: both passed the
      // replay check, one committed. The unique index is what actually makes
      // the operation idempotent, and the loser reads back the winner's row
      // rather than reporting a conflict the caller cannot act on.
      if (isUniqueViolation(error) && dto.clientReference) {
        const existing = await this.repository.findUsageByClientReference(dto.clientReference);
        if (existing) {
          usageDuplicatesTotal.inc({ service: SERVICE_NAME });
          return toUsageView(existing);
        }
      }
      throw error;
    }
  }

  /**
   * Works out who operated the machine, and under which assignment.
   *
   * Three cases, and the third is the one that matters for authorization: a
   * caller holding only `DRIVER` or `OPERATOR` may record usage for the
   * machine they are actually holding, and for nothing else. Without that
   * check, any operator could file readings against the whole yard.
   */
  private async resolveOperator(
    dto: RecordUsageDto,
  ): Promise<{ driverId: string | null; assignmentId: string | null }> {
    const scope = currentFleetScope();

    if (scope.kind === 'SELF') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      if (!own) {
        throw RastaError.forbidden('Only a registered driver may record usage for a machine');
      }
      if (dto.driverId && dto.driverId !== own.id) {
        throw RastaError.forbidden('You may only record usage under your own driver record');
      }

      const active = await this.repository.findActiveAssignmentForDriver(own.id);
      if (!active || active.assetId !== dto.assetId) {
        // Absent rather than forbidden: the caller learns nothing about which
        // machines exist or who else is holding them.
        throw RastaError.notFound('Asset', dto.assetId);
      }

      return { driverId: own.id, assignmentId: active.id };
    }

    if (!dto.driverId) {
      // A supervisor may record usage with no driver named — a contractor's
      // operator, or a reading taken from the meter after the fact. Losing
      // that usage would be worse than not knowing who produced it.
      const active = await this.repository.findActiveAssignmentForAsset(dto.assetId);
      return { driverId: active?.driverId ?? null, assignmentId: active?.id ?? null };
    }

    const driver = await this.repository.findDriverById(dto.driverId);
    if (!driver) throw RastaError.notFound('Driver', dto.driverId);

    const active = await this.repository.findActiveAssignmentForDriver(dto.driverId);
    // Linked only when the assignment is for this machine. A driver holding a
    // different machine gets a record with no assignment rather than one
    // attributed to the wrong job.
    const assignmentId = active && active.assetId === dto.assetId ? active.id : null;

    return { driverId: dto.driverId, assignmentId };
  }
}

/** Clock skew a field device is forgiven. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------

interface DecimalLike {
  toString(): string;
}

interface UsageRow {
  id: string;
  organizationId: string;
  assetId: string;
  driverId: string | null;
  assignmentId: string | null;
  periodStart: Date;
  periodEnd: Date;
  hours: DecimalLike | null;
  kilometres: DecimalLike | null;
  hourMeter: DecimalLike | null;
  odometer: DecimalLike | null;
  source: string;
  notes: string | null;
  clientReference: string | null;
  recordedAt: Date;
}

export function toUsageView(record: UsageRow): UsageRecordView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    assetId: record.assetId,
    driverId: record.driverId,
    assignmentId: record.assignmentId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    // `toString()` on Prisma's Decimal, never `toNumber()`. The whole reason
    // the column is NUMERIC is that a float cannot hold these values exactly,
    // and converting on the way out would give that up at the last step.
    hours: record.hours?.toString() ?? null,
    kilometres: record.kilometres?.toString() ?? null,
    hourMeter: record.hourMeter?.toString() ?? null,
    odometer: record.odometer?.toString() ?? null,
    source: record.source,
    notes: record.notes,
    clientReference: record.clientReference,
    recordedAt: record.recordedAt.toISOString(),
  };
}
