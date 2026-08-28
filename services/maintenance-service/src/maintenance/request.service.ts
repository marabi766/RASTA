import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import {
  duplicateRequestsTotal,
  requestsApprovedTotal,
  requestsCreatedTotal,
} from '../observability/metrics';
import {
  MaintenanceRepository,
  isUniqueViolation,
  violatedConstraint,
} from './maintenance.repository';
import { MAINTENANCE_EVENTS, validateMaintenancePayload } from './events';
import { MAINTENANCE_TOPIC, SERVICE_NAME } from '../config/env';
import { assertOwnReport, currentMaintenanceScope } from './access';
import {
  assertRequestTransition,
  MAINTAINABLE_ASSET_STATUSES,
  OPEN_REQUEST_STATUSES,
} from './lifecycle';
import { assessDue } from './due';
import { toRule } from './schedule.service';
import {
  toRepairOrderView,
  toRequestView,
  type RepairOrderRow,
  type RequestRow,
  type ScheduleRow,
} from './views';
import type {
  ApproveRequestDto,
  CancelRequestDto,
  CreateRequestDto,
  ListRequestsQuery,
  MaintenanceRequestDetailView,
  MaintenanceRequestView,
} from './dto';

/**
 * Maintenance requests — the aggregate root of this domain.
 *
 * Three things here are controls rather than conveniences, and each is
 * enforced where it cannot be bypassed:
 *
 *   **No duplicate open request.** "جلوگیری از ثبت درخواست تکراری" is a
 *   product-document control (docs/17), and docs/05 § 5.5 specifies it as a
 *   partial unique index on `(asset_id, type) WHERE status IN
 *   ('OPEN','IN_PROGRESS')`. The pre-flight check below exists only to produce
 *   a good error message; it cannot be the enforcement, because between
 *   reading "no open request" and writing one, a concurrent request does
 *   exactly the same. The index is what holds the line.
 *
 *   **Approval before settlement.** "الزام تأیید کاربر پیش از تسویه نهایی"
 *   (docs/17). `MAINTENANCE_APPROVED` is the only event that says an owner
 *   approved the work and its cost, and economic-service settles behind it
 *   (ADR-028). This service computes no commission and moves no money.
 *
 *   **Object-level narrowing.** An operator sees only what they reported. Why
 *   that is narrower than docs/09's stated rule, and why it is narrower in the
 *   safe direction, is in `access.ts`.
 */
@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  constructor(private readonly repository: MaintenanceRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<MaintenanceRequestDetailView> {
    const request = await this.repository.findRequestWithDetail(id);
    if (!request) throw RastaError.notFound('MaintenanceRequest', id);

    assertOwnReport(currentMaintenanceScope(), request.reportedBy, 'MaintenanceRequest', id);

    const breakdown = await this.repository.sumCostsByCategory(
      this.repository.client,
      request.organizationId,
      { maintenanceRequestId: id },
    );

    return {
      ...toRequestView(request as RequestRow),
      repairOrders: request.repairOrders.map((order) => toRepairOrderView(order as RepairOrderRow)),
      costBreakdown: breakdown.map((row) => ({
        category: row.category,
        amountMinor: row.total.toString(),
        currency: request.currency,
      })),
    };
  }

  async list(query: ListRequestsQuery) {
    const scope = currentMaintenanceScope();

    // Applied as a filter rather than by discarding rows afterwards, so the
    // cursor still describes a real position in the result set.
    const result = await this.repository.listRequests(
      query,
      scope.kind === 'REPORTER' ? scope.userId : undefined,
    );

    return {
      items: result.items.map((row) => toRequestView(row as RequestRow)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Raises a piece of maintenance work.
   *
   * Two events, not one, for a breakdown. `BREAKDOWN_REPORTED` says "something
   * failed" — the thing notification-service acts on immediately.
   * `MAINTENANCE_CREATED` says "a piece of work now exists" — the thing
   * asset-service records in the machine's file. Collapsing them would force
   * every consumer to infer one from the other's `type` field.
   */
  async create(dto: CreateRequestDto): Promise<MaintenanceRequestView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    await this.assertAssetMaintainable(dto.assetId);

    const schedule = dto.scheduleId
      ? await this.resolveSchedule(dto.scheduleId, dto.assetId)
      : null;

    // Pre-flight, for the error message only. See the class comment.
    await this.explainExistingRequest(dto.assetId, dto.type);

    const reportedAt = dto.reportedAt ? new Date(dto.reportedAt) : new Date();
    if (reportedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw RastaError.businessRule('Maintenance cannot be reported for a future moment.', {
        rule: 'FUTURE_REPORT',
        reportedAt: reportedAt.toISOString(),
      });
    }

    const dueDate = dto.dueDate
      ? new Date(dto.dueDate)
      : schedule
        ? scheduleDueDate(schedule as ScheduleRow)
        : null;

    const id = `${ID_PREFIXES.maintenanceRequest}_${ulid()}`;

    try {
      const created = await this.repository.transaction(async (tx) => {
        const request = await tx.maintenanceRequest.create({
          data: {
            id,
            organizationId,
            assetId: dto.assetId,
            scheduleId: schedule?.id ?? null,
            type: dto.type,
            title: dto.title,
            description: dto.description ?? null,
            severity: dto.severity ?? null,
            reportedAt,
            reportedBy: actor,
            dueDate,
            // A breakdown takes the machine out of service when it fails, not
            // when a workshop is free. Planned work leaves this null until the
            // repair starts.
            outOfServiceAt: dto.outOfServiceAt ? new Date(dto.outOfServiceAt) : null,
          },
        });

        if (dto.type === 'CORRECTIVE') {
          await this.repository.enqueueEvent(tx, {
            aggregateType: 'MaintenanceRequest',
            aggregateId: id,
            eventName: MAINTENANCE_EVENTS.BREAKDOWN_REPORTED,
            topic: MAINTENANCE_TOPIC,
            organizationId,
            partitionKey: dto.assetId,
            payload: validateMaintenancePayload(MAINTENANCE_EVENTS.BREAKDOWN_REPORTED, {
              requestId: id,
              assetId: dto.assetId,
              organizationId,
              severity: dto.severity ?? 'MEDIUM',
              title: dto.title,
              reportedAt: reportedAt.toISOString(),
            }),
          });
        }

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'MaintenanceRequest',
          aggregateId: id,
          eventName: MAINTENANCE_EVENTS.MAINTENANCE_CREATED,
          topic: MAINTENANCE_TOPIC,
          organizationId,
          // Keyed by asset rather than by request id. asset-service builds the
          // machine's dossier from this stream and moves it in and out of
          // IN_MAINTENANCE; if the created, started and completed events for
          // one machine landed on different partitions, Kafka would guarantee
          // nothing about their order and a repaired machine could stay
          // withdrawn for ever (docs/07 § 7.7).
          partitionKey: dto.assetId,
          payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_CREATED, {
            requestId: id,
            assetId: dto.assetId,
            organizationId,
            type: dto.type,
            title: dto.title,
            scheduleId: schedule?.id ?? null,
            dueDate: dueDate?.toISOString() ?? null,
            reportedAt: reportedAt.toISOString(),
          }),
        });

        return request;
      });

      requestsCreatedTotal.inc({ service: SERVICE_NAME, type: dto.type });
      return toRequestView(created as RequestRow);
    } catch (error) {
      throw this.translateDuplicate(error, dto.assetId, dto.type);
    }
  }

  /**
   * The owner accepts the work and its cost.
   *
   * The product document makes this mandatory before settlement, so it is
   * guarded three ways: the request must be `COMPLETED`, the update is
   * conditional on it still being `COMPLETED` when it lands, and — when the
   * caller states what they believe they are approving — the total must match
   * exactly. An approval that silently covers a figure that changed between
   * the screen and the button is not the control it claims to be.
   */
  async approve(id: string, dto: ApproveRequestDto): Promise<MaintenanceRequestView> {
    const request = await this.repository.findRequestById(id);
    if (!request) throw RastaError.notFound('MaintenanceRequest', id);

    assertRequestTransition(request.status, 'APPROVED');

    if (
      dto.expectedTotalCostMinor !== undefined &&
      dto.expectedTotalCostMinor !== request.totalCostMinor.toString()
    ) {
      throw RastaError.businessRule(
        'The cost has changed since it was shown to you; review it again before approving.',
        {
          rule: 'APPROVAL_TOTAL_MISMATCH',
          requestId: id,
          expected: dto.expectedTotalCostMinor,
          actual: request.totalCostMinor.toString(),
        },
      );
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const approvedAt = new Date();

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.maintenanceRequest.updateMany({
        // The status guard is the concurrency control. Without it, two
        // simultaneous approvals would both report success and two
        // MAINTENANCE_APPROVED events would authorise the same settlement
        // twice.
        where: { id, status: 'COMPLETED' },
        data: {
          status: 'APPROVED',
          approvedAt,
          approvedBy: actor,
          approvalNotes: dto.notes ?? null,
        },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'MaintenanceRequest',
          request.status,
          'APPROVED',
          'This request was already approved or cancelled by another request',
        );
      }

      const breakdown = await this.repository.sumCostsByCategory(tx, request.organizationId, {
        maintenanceRequestId: id,
      });

      const workshop = await tx.repairOrder.findFirst({
        where: { maintenanceRequestId: id, status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        select: { workshopOrganizationId: true },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'MaintenanceRequest',
        aggregateId: id,
        eventName: MAINTENANCE_EVENTS.MAINTENANCE_APPROVED,
        topic: MAINTENANCE_TOPIC,
        organizationId: request.organizationId,
        partitionKey: request.assetId,
        payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_APPROVED, {
          requestId: id,
          assetId: request.assetId,
          organizationId: request.organizationId,
          approvedBy: actor,
          approvedAt: approvedAt.toISOString(),
          workshopOrganizationId: workshop?.workshopOrganizationId ?? null,
          totalCostMinor: request.totalCostMinor.toString(),
          currency: request.currency,
          // The breakdown is what makes the total auditable rather than
          // merely trusted: economic-service can reconcile a settlement line
          // by line instead of accepting one number (ADR-028).
          costBreakdown: breakdown.map((row) => ({
            category: row.category,
            amountMinor: row.total.toString(),
            currency: request.currency,
          })),
        }),
      });

      return tx.maintenanceRequest.findFirstOrThrow({ where: { id } });
    });

    requestsApprovedTotal.inc({ service: SERVICE_NAME });
    return toRequestView(updated as RequestRow);
  }

  /**
   * Abandons the work.
   *
   * Publishes `MAINTENANCE_CANCELLED`, which is not in the published
   * catalogue. Without it, every consumer that saw `MAINTENANCE_CREATED` keeps
   * believing the work is outstanding, and audit-service — whose only input is
   * events — never learns it was dropped (AGENTS.md S-06). The event exists to
   * keep an already-published claim true, which is the only reason this
   * service adds one.
   *
   * Cost lines already recorded are kept. They were really incurred, and
   * deleting them would make the machine's history cheaper than the
   * organization's bank statement.
   */
  async cancel(id: string, dto: CancelRequestDto): Promise<MaintenanceRequestView> {
    const request = await this.repository.findRequestById(id);
    if (!request) throw RastaError.notFound('MaintenanceRequest', id);

    assertRequestTransition(request.status, 'CANCELLED');

    const actor = getContext().userId ?? 'SYSTEM';
    const cancelledAt = new Date();
    const previousStatus = request.status;

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.maintenanceRequest.updateMany({
        where: { id, status: previousStatus },
        data: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledBy: actor,
          cancellationReason: dto.reason,
        },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'MaintenanceRequest',
          previousStatus,
          'CANCELLED',
          'This request was changed by another request',
        );
      }

      // A live referral cannot outlive the work it was for.
      await tx.repairOrder.updateMany({
        where: { maintenanceRequestId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledBy: actor,
          cancellationReason: `Maintenance request cancelled: ${dto.reason}`,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'MaintenanceRequest',
        aggregateId: id,
        eventName: MAINTENANCE_EVENTS.MAINTENANCE_CANCELLED,
        topic: MAINTENANCE_TOPIC,
        organizationId: request.organizationId,
        partitionKey: request.assetId,
        payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_CANCELLED, {
          requestId: id,
          assetId: request.assetId,
          organizationId: request.organizationId,
          cancelledAt: cancelledAt.toISOString(),
          reason: dto.reason,
          previousStatus,
        }),
      });

      return tx.maintenanceRequest.findFirstOrThrow({ where: { id } });
    });

    return toRequestView(updated as RequestRow);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Refuses a machine this tenant may not raise maintenance for.
   *
   * The same replica-based check the schedule service makes, and for the same
   * reason: an HTTP call to asset-service on every write would make reporting
   * a breakdown fail whenever asset-service is down, which is the wrong
   * failure mode for a safety report (docs/03 § 3.6).
   */
  private async assertAssetMaintainable(assetId: string): Promise<void> {
    const asset = await this.repository.findAssetRef(assetId);

    // Reported as absent, not as forbidden: confirming the machine exists
    // elsewhere would let a caller enumerate another organization's fleet.
    if (!asset || asset.organizationId !== getOrganizationId()) {
      throw RastaError.notFound('Asset', assetId);
    }

    if (!MAINTAINABLE_ASSET_STATUSES.includes(asset.status)) {
      throw RastaError.businessRule(
        `A machine in state ${asset.status} cannot take on maintenance work.`,
        { rule: 'ASSET_NOT_MAINTAINABLE', assetId, status: asset.status, owner: 'asset-service' },
      );
    }
  }

  private async resolveSchedule(scheduleId: string, assetId: string) {
    const schedule = await this.repository.findScheduleById(scheduleId);
    if (!schedule) throw RastaError.notFound('MaintenanceSchedule', scheduleId);

    if (schedule.assetId !== assetId) {
      throw RastaError.businessRule('That schedule belongs to a different machine.', {
        rule: 'SCHEDULE_ASSET_MISMATCH',
        scheduleId,
        assetId,
        scheduleAssetId: schedule.assetId,
      });
    }

    if (schedule.status === 'ARCHIVED') {
      throw RastaError.businessRule('That schedule has been archived.', {
        rule: 'SCHEDULE_ARCHIVED',
        scheduleId,
      });
    }

    return schedule;
  }

  /**
   * Turns an existing open request into a message that names it.
   *
   * Advisory only. The database still has the last word, and
   * {@link translateDuplicate} handles the case where a concurrent request
   * slipped in between this read and the insert.
   */
  private async explainExistingRequest(
    assetId: string,
    type: CreateRequestDto['type'],
  ): Promise<void> {
    const existing = await this.repository.client.maintenanceRequest.findFirst({
      where: { assetId, type, status: { in: [...OPEN_REQUEST_STATUSES] } },
    });

    if (!existing) return;

    duplicateRequestsTotal.inc({ service: SERVICE_NAME });
    throw RastaError.businessRule(
      'This machine already has an open request of that kind. Add to it, or close it first.',
      { rule: 'DUPLICATE_OPEN_REQUEST', assetId, type, requestId: existing.id },
    );
  }

  /**
   * Maps the partial unique index violation onto the control it protected.
   *
   * This is the path a genuine race takes: both requests passed the pre-flight
   * check, one committed, and the other landed here. The caller is told the
   * same thing they would have been told a millisecond earlier, so a race is
   * indistinguishable from an ordinary conflict — which is the point.
   *
   * Matched on the *columns*, not on the index name. Prisma reports
   * `meta.target` as the indexed columns and never the index name, and code
   * that matches on the name silently never matches — the bug that lived
   * undetected in fleet-service until its first real integration run.
   */
  private translateDuplicate(
    error: unknown,
    assetId: string,
    type: CreateRequestDto['type'],
  ): unknown {
    if (!isUniqueViolation(error)) return error;

    const target = violatedConstraint(error);
    this.logger.warn(
      `Duplicate maintenance request refused on ${target ?? 'an unnamed constraint'}`,
    );

    if (!target || target.includes('asset_id') || target.includes('ux_request_open_per_asset')) {
      duplicateRequestsTotal.inc({ service: SERVICE_NAME });
      return RastaError.businessRule(
        'This machine already has an open request of that kind. Add to it, or close it first.',
        { rule: 'DUPLICATE_OPEN_REQUEST', assetId, type, concurrent: true },
      );
    }

    // Some other unique index. Reported as a conflict rather than swallowed:
    // an unexplained 500 would hide it, and a generic success would be worse.
    return RastaError.alreadyExists('MaintenanceRequest');
  }
}

/** Clock skew a client is forgiven when stating when something was reported. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The date a schedule's time trigger falls due, for stamping on a request.
 *
 * Only the time trigger yields a date; a usage-based schedule comes due at a
 * meter reading, and inventing a calendar date for it would be inventing a
 * fact. The request's `dueDate` is then null, which is honest — the due
 * listing still reports it correctly because that verdict is derived, not read
 * from this column.
 */
function scheduleDueDate(schedule: ScheduleRow): Date | null {
  const assessment = assessDue(toRule(schedule), { hourMeter: null, odometer: null }, new Date());
  const time = assessment.triggers.find((trigger) => trigger.basis === 'TIME');
  return time?.dueAt ? new Date(time.dueAt) : null;
}
