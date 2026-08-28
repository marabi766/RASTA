import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { MaintenanceRepository, isUniqueViolation } from './maintenance.repository';
import { assessDue, type MeterReading, type ScheduleRule } from './due';
import { MAINTAINABLE_ASSET_STATUSES } from './lifecycle';
import { toScheduleView, type ScheduleRow } from './views';
import { ENV } from '../tokens';
import type { MaintenanceEnv } from '../config/env';
import type {
  ChangeScheduleStatusDto,
  CreateScheduleDto,
  DueSchedulesQuery,
  ListSchedulesQuery,
  ScheduleDueView,
  ScheduleView,
  UpdateScheduleDto,
} from './dto';

/**
 * Service schedules — the rules that turn maintenance from reactive to
 * preventive (docs/04 § 4.7).
 *
 * The service owns two things that are easy to conflate and must not be:
 *
 *   the **rule**       intervals, leads and the anchor of the last service.
 *                      Stored, edited by people, and the only thing here that
 *                      is authoritative.
 *   the **verdict**    whether a schedule is due right now. Computed on every
 *                      read from the rule, the machine's meter and the clock,
 *                      and never stored. See `due.ts` for why: a stored
 *                      verdict that a job failed to refresh reports every
 *                      overdue machine as compliant, and nothing about the
 *                      screen would look wrong.
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly repository: MaintenanceRepository,
    @Inject(ENV) private readonly env: MaintenanceEnv,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<ScheduleView> {
    const schedule = await this.repository.findScheduleById(id);
    if (!schedule) throw RastaError.notFound('MaintenanceSchedule', id);

    const asset = await this.repository.findAssetRef(schedule.assetId);
    return toScheduleView(schedule as ScheduleRow, asset?.name ?? null);
  }

  async list(query: ListSchedulesQuery) {
    const result = await this.repository.listSchedules(query);
    const names = await this.assetNames(result.items.map((row) => row.assetId));

    return {
      items: result.items.map((row) =>
        toScheduleView(row as ScheduleRow, names.get(row.assetId) ?? null),
      ),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  /**
   * What needs doing — the endpoint docs/04 § 4.7 names `GET
   * /maintenance-schedules/due`.
   *
   * Every schedule is assessed against the same `now`, taken once. Reading the
   * clock per row would let a batch straddle a due boundary and report two
   * machines with identical schedules differently.
   */
  async listDue(query: DueSchedulesQuery): Promise<{
    items: ScheduleDueView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const now = query.at ? new Date(query.at) : new Date();

    const result = await this.repository.listActiveSchedules(
      query.assetId,
      query.cursor,
      query.limit,
    );

    const assetIds = result.items.map((row) => row.assetId);
    const [names, meters, openRequests] = await Promise.all([
      this.assetNames(assetIds),
      this.meters(assetIds),
      this.repository.findOpenRequestsForSchedules(result.items.map((row) => row.id)),
    ]);

    const openByScheduleId = new Map(
      openRequests.map((request) => [request.scheduleId ?? '', request.id]),
    );

    const assessed = result.items.map((row) => {
      const snapshot = meters.get(row.assetId) ?? EMPTY_SNAPSHOT;
      const due = assessDue(toRule(row as ScheduleRow), snapshot.reading, now);

      return {
        ...toScheduleView(row as ScheduleRow, names.get(row.assetId) ?? null),
        due: {
          state: due.state,
          basis: due.basis,
          dueBy: due.dueBy,
          dueAtMeter: due.dueAtMeter,
          triggers: due.triggers,
        },
        meter: {
          hourMeter: snapshot.reading.hourMeter ?? '0.00',
          odometer: snapshot.reading.odometer ?? '0.00',
          lastPeriodEnd: snapshot.lastPeriodEnd,
        },
        openRequestId: openByScheduleId.get(row.id) ?? null,
      } satisfies ScheduleDueView;
    });

    // Filtering after assessment rather than in SQL: due-ness is derived, so
    // there is no column to filter on. The page is bounded by the cursor
    // query above, so this never walks an unbounded set — but it does mean a
    // page can come back partly empty, which `hasMore` and the cursor still
    // describe correctly.
    const items = query.includeNotDue
      ? assessed
      : assessed.filter((item) => item.due.state !== 'NOT_DUE');

    return { items, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Defines a service rule for a machine.
   *
   * The anchors are the interesting part. A schedule created for a grader with
   * 4 310 hours on its meter must not report as overdue the moment it is
   * saved, so unless the caller states when the machine was last serviced, the
   * current meter *is* the anchor and the first interval starts from now.
   */
  async create(dto: CreateScheduleDto): Promise<ScheduleView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    const asset = await this.assertAssetMaintainable(dto.assetId);
    const meter = await this.repository.findMeter(dto.assetId);

    const id = `${ID_PREFIXES.maintenanceSchedule}_${ulid()}`;
    const now = new Date();

    try {
      const created = await this.repository.client.maintenanceSchedule.create({
        data: {
          id,
          organizationId,
          assetId: dto.assetId,
          title: dto.title,
          maintenanceType: dto.maintenanceType,
          recurrence: dto.recurrence,
          intervalDays: dto.intervalDays ?? null,
          intervalHours: dto.intervalHours ?? null,
          intervalKilometres: dto.intervalKilometres ?? null,
          leadDays: this.resolveLeadDays(dto),
          leadHours: dto.leadHours ?? null,
          leadKilometres: dto.leadKilometres ?? null,
          lastServicedAt: dto.lastServicedAt ? new Date(dto.lastServicedAt) : now,
          lastServicedHourMeter: dto.lastServicedHourMeter ?? meter?.hourMeter?.toString() ?? null,
          lastServicedOdometer: dto.lastServicedOdometer ?? meter?.odometer?.toString() ?? null,
          notes: dto.notes ?? null,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      return toScheduleView(created as ScheduleRow, asset.name ?? null);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw RastaError.businessRule('This machine already has a live schedule with that title.', {
          rule: 'DUPLICATE_SCHEDULE_TITLE',
          assetId: dto.assetId,
          title: dto.title,
        });
      }
      throw error;
    }
  }

  /**
   * Edits the rule, or re-anchors it.
   *
   * Re-anchoring is the supported repair for a replaced hour meter. The meter
   * read model never moves backwards — a new instrument reading low would
   * otherwise freeze it — so the schedule is moved to meet the new reading
   * rather than the usage history being rewritten, which other services also
   * hold and this one does not own.
   *
   * Any edit clears the announcement marker: a schedule whose interval just
   * changed has a different due point, and the announcement made against the
   * old one no longer describes it.
   */
  async update(id: string, dto: UpdateScheduleDto): Promise<ScheduleView> {
    const schedule = await this.repository.findScheduleById(id);
    if (!schedule) throw RastaError.notFound('MaintenanceSchedule', id);

    if (schedule.status === 'ARCHIVED') {
      throw RastaError.invalidStateTransition(
        'MaintenanceSchedule',
        'ARCHIVED',
        'ARCHIVED',
        'An archived schedule cannot be edited; create a new one',
      );
    }

    const actor = getContext().userId ?? 'SYSTEM';

    const next = {
      intervalDays: pick(dto.intervalDays, schedule.intervalDays),
      intervalHours: pickDecimal(dto.intervalHours, schedule.intervalHours),
      intervalKilometres: pickDecimal(dto.intervalKilometres, schedule.intervalKilometres),
    };

    if (
      next.intervalDays === null &&
      next.intervalHours === null &&
      next.intervalKilometres === null
    ) {
      throw RastaError.businessRule(
        'A schedule must keep at least one interval; one with none never comes due.',
        { rule: 'SCHEDULE_WITHOUT_INTERVAL', scheduleId: id },
      );
    }

    const updated = await this.repository.client.maintenanceSchedule.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.intervalDays !== undefined ? { intervalDays: dto.intervalDays } : {}),
        ...(dto.intervalHours !== undefined ? { intervalHours: dto.intervalHours } : {}),
        ...(dto.intervalKilometres !== undefined
          ? { intervalKilometres: dto.intervalKilometres }
          : {}),
        ...(dto.leadDays !== undefined ? { leadDays: dto.leadDays } : {}),
        ...(dto.leadHours !== undefined ? { leadHours: dto.leadHours } : {}),
        ...(dto.leadKilometres !== undefined ? { leadKilometres: dto.leadKilometres } : {}),
        ...(dto.lastServicedAt !== undefined
          ? { lastServicedAt: dto.lastServicedAt ? new Date(dto.lastServicedAt) : null }
          : {}),
        ...(dto.lastServicedHourMeter !== undefined
          ? { lastServicedHourMeter: dto.lastServicedHourMeter }
          : {}),
        ...(dto.lastServicedOdometer !== undefined
          ? { lastServicedOdometer: dto.lastServicedOdometer }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        // The due point has moved, so the announcement made against the old
        // one is stale. Cleared rather than left, or the schedule would go
        // quiet until it was next served.
        dueAnnouncedAt: null,
        updatedBy: actor,
      },
    });

    return toScheduleView(updated as ScheduleRow);
  }

  /**
   * Pauses, resumes or archives a schedule.
   *
   * The reason is required rather than optional. A schedule quietly switched
   * off is a machine that quietly stops being serviced, and that is precisely
   * the decision someone will need to explain later (AGENTS.md S-06).
   */
  async changeStatus(id: string, dto: ChangeScheduleStatusDto): Promise<ScheduleView> {
    const schedule = await this.repository.findScheduleById(id);
    if (!schedule) throw RastaError.notFound('MaintenanceSchedule', id);

    if (schedule.status === dto.status) {
      throw RastaError.invalidStateTransition(
        'MaintenanceSchedule',
        schedule.status,
        dto.status,
        `This schedule is already ${schedule.status}`,
      );
    }

    if (schedule.status === 'ARCHIVED') {
      throw RastaError.invalidStateTransition(
        'MaintenanceSchedule',
        'ARCHIVED',
        dto.status,
        'An archived schedule is final; create a new one',
      );
    }

    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.client.maintenanceSchedule.update({
      where: { id },
      data: {
        status: dto.status,
        notes: appendReason(schedule.notes, dto.status, dto.reason),
        // Resuming a paused schedule must be able to announce again: the world
        // moved on while it was off.
        dueAnnouncedAt: null,
        updatedBy: actor,
      },
    });

    return toScheduleView(updated as ScheduleRow);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Refuses a machine this tenant may not raise maintenance for.
   *
   * Every fact consulted here is owned by asset-service and mirrored into
   * `asset_ref` by the event consumer. That is a deliberate trade: the replica
   * can be seconds stale, and the alternative — an HTTP call to asset-service
   * on every write — would make reporting a breakdown fail whenever
   * asset-service is down, which is precisely the coupling docs/03 § 3.6
   * rejects and precisely the wrong failure mode for a safety report.
   *
   * A machine in another organization is reported as absent, not as forbidden:
   * confirming it exists elsewhere would let a caller enumerate another
   * organization's fleet.
   */
  private async assertAssetMaintainable(assetId: string) {
    const asset = await this.repository.findAssetRef(assetId);

    if (!asset || asset.organizationId !== getOrganizationId()) {
      throw RastaError.notFound('Asset', assetId);
    }

    if (!MAINTAINABLE_ASSET_STATUSES.includes(asset.status)) {
      throw RastaError.businessRule(
        `A machine in state ${asset.status} cannot take on maintenance work.`,
        { rule: 'ASSET_NOT_MAINTAINABLE', assetId, status: asset.status, owner: 'asset-service' },
      );
    }

    return asset;
  }

  /**
   * The warning lead for the time trigger.
   *
   * Falls back to configuration when the caller states none — the product asks
   * for a warning before the deadline but says nothing about how far before,
   * which makes it an organizational preference rather than a platform fact
   * (AGENTS.md § 9). Clamped below the interval, because a lead as long as the
   * interval means the schedule is permanently "due soon", which is the same
   * as having no warning at all.
   */
  private resolveLeadDays(dto: CreateScheduleDto): number | null {
    if (dto.leadDays !== undefined) return dto.leadDays;
    if (dto.intervalDays === undefined) return null;
    return Math.min(this.env.MAINTENANCE_DEFAULT_LEAD_DAYS, dto.intervalDays - 1);
  }

  private async assetNames(assetIds: readonly string[]): Promise<Map<string, string | null>> {
    const refs = await this.repository.findAssetRefs(unique(assetIds));
    return new Map(refs.map((ref) => [ref.id, ref.name]));
  }

  private async meters(assetIds: readonly string[]): Promise<Map<string, MeterSnapshot>> {
    const rows = await this.repository.findMeters(unique(assetIds));

    return new Map(
      rows.map((row) => [
        row.assetId,
        {
          reading: {
            hourMeter: row.hourMeter.toString(),
            odometer: row.odometer.toString(),
          },
          lastPeriodEnd: row.lastPeriodEnd?.toISOString() ?? null,
        },
      ]),
    );
  }
}

/**
 * A meter row as this service reads it.
 *
 * `MeterReading` carries only what the pure evaluator does arithmetic on; the
 * last period end is presentation, and threading it through `assessDue` would
 * widen that contract for the sake of one display field. Kept together here
 * rather than in a module-level side table, because two requests listing
 * different fleets at the same time would overwrite each other's rows in one
 * of those.
 */
interface MeterSnapshot {
  reading: MeterReading;
  lastPeriodEnd: string | null;
}

const EMPTY_SNAPSHOT: MeterSnapshot = {
  reading: { hourMeter: '0.00', odometer: '0.00' },
  lastPeriodEnd: null,
};

/** Turns a stored schedule row into the pure evaluator's input. */
export function toRule(row: ScheduleRow): ScheduleRule {
  return {
    intervalDays: row.intervalDays,
    intervalHours: row.intervalHours?.toString() ?? null,
    intervalKilometres: row.intervalKilometres?.toString() ?? null,
    leadDays: row.leadDays,
    leadHours: row.leadHours?.toString() ?? null,
    leadKilometres: row.leadKilometres?.toString() ?? null,
    lastServicedAt: row.lastServicedAt,
    createdAt: row.createdAt,
    lastServicedHourMeter: row.lastServicedHourMeter?.toString() ?? null,
    lastServicedOdometer: row.lastServicedOdometer?.toString() ?? null,
  };
}

function pick<T>(patch: T | null | undefined, current: T | null): T | null {
  return patch === undefined ? current : patch;
}

function pickDecimal(
  patch: string | null | undefined,
  current: { toString(): string } | null,
): string | null {
  if (patch === undefined) return current?.toString() ?? null;
  return patch;
}

/**
 * Keeps the reason for a status change with the schedule.
 *
 * Appended to the notes rather than given a column of its own: there is no
 * audit-service to publish to yet, and a reason recorded nowhere is a decision
 * nobody can review. When audit-service exists this becomes an event and the
 * append goes away.
 */
function appendReason(notes: string | null, status: string, reason: string): string {
  const line = `[${status}] ${reason}`;
  return notes ? `${notes}\n${line}` : line;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
