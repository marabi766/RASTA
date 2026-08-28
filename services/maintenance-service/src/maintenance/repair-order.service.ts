import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext } from '@rasta/nest-common';
import {
  downtimeHours,
  partsRecordedTotal,
  requestsCompletedTotal,
} from '../observability/metrics';
import { MaintenanceRepository, isUniqueViolation } from './maintenance.repository';
import { MAINTENANCE_EVENTS, validateMaintenancePayload } from './events';
import { MAINTENANCE_TOPIC, SERVICE_NAME } from '../config/env';
import { currentMaintenanceScope } from './access';
import {
  assertRepairOrderTransition,
  assertRequestTransition,
  COSTABLE_REPAIR_ORDER_STATUSES,
} from './lifecycle';
import { lineTotalMinor } from './quantity';
import { WorkshopDirectory } from './workshop.directory';
import {
  toCostView,
  toLabourView,
  toPartView,
  toRepairOrderView,
  type CostRow,
  type LabourRow,
  type PartRow,
  type RepairOrderRow,
} from './views';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type {
  AssignWorkshopDto,
  CancelRepairDto,
  CompleteRepairDto,
  LabourEntryView,
  ListRepairOrdersQuery,
  MaintenanceCostView,
  PartUsageView,
  RecordCostDto,
  RecordLabourDto,
  RecordPartDto,
  RepairOrderDetailView,
  RepairOrderView,
  StartRepairDto,
} from './dto';

/**
 * Repair orders — the work itself, and what it cost.
 *
 * ## The cost invariant
 *
 * docs/03 § 3.3 puts `RepairOrder`, `PartUsage` and `LaborEntry` inside the
 * maintenance request's aggregate boundary for one stated reason: "هزینه کل
 * باید با اجزایش اتمیک بماند" — the total must stay atomic with its parts.
 * Every write here therefore does the same three things in one transaction:
 *
 *   1. lock the repair order row,
 *   2. write the line and its cost entry,
 *   3. recompute the order's and the request's totals **from the lines**.
 *
 * Recomputed, never incremented. An increment is a read-modify-write, and two
 * mechanics entering parts at the same moment would each read the same
 * starting total and one of their lines would vanish from it. The lock in step
 * one is what makes step three see everything: PostgreSQL takes a fresh
 * snapshot per statement under READ COMMITTED, so the transaction that waited
 * sums the rows the other one committed.
 *
 * ## The economic boundary
 *
 * Everything here is an *operational* record: what was fitted, who worked, how
 * long, what it cost. Nothing decides who pays, what the platform's share is,
 * or when money moves — those belong to economic-service, several of them are
 * still open questions (docs/24 Q-08), and inventing any of them here would be
 * inventing a business rule (ADR-028).
 */
@Injectable()
export class RepairOrderService {
  private readonly logger = new Logger(RepairOrderService.name);

  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly workshops: WorkshopDirectory,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<RepairOrderDetailView> {
    const order = await this.repository.findRepairOrderWithDetail(id);
    if (!order) throw RastaError.notFound('RepairOrder', id);

    await this.assertVisible(order.maintenanceRequestId, 'RepairOrder', id);

    return {
      ...toRepairOrderView(order as RepairOrderRow),
      parts: order.parts.map((part) => toPartView(part as PartRow)),
      labour: order.labour.map((entry) => toLabourView(entry as LabourRow)),
      costs: order.costs.map((cost) => toCostView(cost as CostRow)),
    };
  }

  async list(query: ListRepairOrdersQuery) {
    const scope = currentMaintenanceScope();
    // A narrowed caller has no business browsing repair orders at all: they
    // may report a fault, not follow what a workshop charged for it. An empty
    // page rather than a 403, for the same non-disclosure reason a
    // cross-tenant read returns 404.
    if (scope.kind !== 'SUPERVISOR') {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const result = await this.repository.listRepairOrders(query);
    return {
      items: result.items.map((row) => toRepairOrderView(row as RepairOrderRow)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // =========================================================================
  // Referral
  // =========================================================================

  /**
   * Refers the work to a workshop — `POST /maintenance-requests/{id}/assign`.
   *
   * Whether the workshop is *qualified* is a question supplier-service owns
   * and cannot answer yet. It is asked anyway, through a port, so the gap is a
   * class someone can find rather than a sentence in a document — and so that
   * filling it later changes one file (`workshop.directory.ts`, ADR-029).
   */
  async assign(requestId: string, dto: AssignWorkshopDto): Promise<RepairOrderView> {
    const request = await this.repository.findRequestById(requestId);
    if (!request) throw RastaError.notFound('MaintenanceRequest', requestId);

    if (request.status !== 'OPEN' && request.status !== 'IN_PROGRESS') {
      throw RastaError.invalidStateTransition(
        'MaintenanceRequest',
        request.status,
        'ASSIGNED',
        `A ${request.status.toLowerCase()} request cannot be referred to a workshop`,
      );
    }

    const verdict = await this.workshops.verify({
      workshopOrganizationId: dto.workshopOrganizationId,
      organizationId: request.organizationId,
      assetId: request.assetId,
    });

    if (!verdict.permitted) {
      throw RastaError.businessRule('That workshop may not take on this work.', {
        rule: 'WORKSHOP_NOT_QUALIFIED',
        workshopOrganizationId: dto.workshopOrganizationId,
        detail: verdict.reason,
        owner: 'supplier-service',
      });
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const assignedAt = dto.assignedAt ? new Date(dto.assignedAt) : new Date();
    const id = `${ID_PREFIXES.repairOrder}_${ulid()}`;

    try {
      const created = await this.repository.transaction(async (tx) => {
        const order = await tx.repairOrder.create({
          data: {
            id,
            organizationId: request.organizationId,
            maintenanceRequestId: requestId,
            assetId: request.assetId,
            workshopOrganizationId: dto.workshopOrganizationId,
            workshopName: dto.workshopName ?? null,
            workSummary: dto.workSummary ?? null,
            assignedAt,
            assignedBy: actor,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'RepairOrder',
          aggregateId: id,
          eventName: MAINTENANCE_EVENTS.WORKSHOP_ASSIGNED,
          topic: MAINTENANCE_TOPIC,
          organizationId: request.organizationId,
          partitionKey: request.assetId,
          causationId: requestId,
          payload: validateMaintenancePayload(MAINTENANCE_EVENTS.WORKSHOP_ASSIGNED, {
            requestId,
            repairOrderId: id,
            assetId: request.assetId,
            organizationId: request.organizationId,
            workshopOrganizationId: dto.workshopOrganizationId,
            assignedAt: assignedAt.toISOString(),
          }),
        });

        return order;
      });

      return toRepairOrderView(created as RepairOrderRow);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The partial unique index refused a second live referral. Two
        // workshops holding the same job at once is the state it exists to
        // prevent, and only the database can catch two concurrent referrals.
        throw RastaError.businessRule(
          'This request is already with a workshop. Cancel that referral before making another.',
          { rule: 'REPAIR_ORDER_ALREADY_OPEN', requestId },
        );
      }
      throw error;
    }
  }

  // =========================================================================
  // Work
  // =========================================================================

  /**
   * The machine goes into the workshop.
   *
   * `MAINTENANCE_STARTED` is what withdraws it from service: asset-service
   * moves it to `IN_MAINTENANCE` and fleet-service sets
   * `asset_ref.inMaintenance`, so no driver can be assigned to it. Neither is
   * instructed to — each decides from the fact that it happened (ADR-026).
   */
  async start(id: string, dto: StartRepairDto): Promise<RepairOrderView> {
    const order = await this.repository.findRepairOrderById(id);
    if (!order) throw RastaError.notFound('RepairOrder', id);

    assertRepairOrderTransition(order.status, 'IN_PROGRESS');

    const request = await this.repository.findRequestById(order.maintenanceRequestId);
    if (!request) throw RastaError.notFound('MaintenanceRequest', order.maintenanceRequestId);

    if (request.status === 'OPEN') assertRequestTransition(request.status, 'IN_PROGRESS');

    const actor = getContext().userId ?? 'SYSTEM';
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date();

    if (startedAt < order.assignedAt) {
      throw RastaError.businessRule('A repair cannot start before it was referred.', {
        rule: 'START_BEFORE_REFERRAL',
        assignedAt: order.assignedAt.toISOString(),
        startedAt: startedAt.toISOString(),
      });
    }

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.repairOrder.updateMany({
        // The status guard is the concurrency control: two simultaneous starts
        // and exactly one updates a row.
        where: { id, status: 'OPEN' },
        data: {
          status: 'IN_PROGRESS',
          startedAt,
          startedBy: actor,
          ...(dto.workSummary ? { workSummary: dto.workSummary } : {}),
        },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'RepairOrder',
          order.status,
          'IN_PROGRESS',
          'This repair order was started or cancelled by another request',
        );
      }

      await tx.maintenanceRequest.updateMany({
        where: { id: request.id, status: 'OPEN' },
        data: {
          status: 'IN_PROGRESS',
          startedAt,
          startedBy: actor,
          // Planned work takes the machine out of service when it goes in. A
          // breakdown already stated when it stopped being usable, and that
          // earlier moment is the one that counts — so it is never overwritten.
          ...(request.outOfServiceAt ? {} : { outOfServiceAt: startedAt }),
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'MaintenanceRequest',
        aggregateId: request.id,
        eventName: MAINTENANCE_EVENTS.MAINTENANCE_STARTED,
        topic: MAINTENANCE_TOPIC,
        organizationId: order.organizationId,
        partitionKey: order.assetId,
        causationId: id,
        payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_STARTED, {
          requestId: request.id,
          repairOrderId: id,
          assetId: order.assetId,
          organizationId: order.organizationId,
          startedAt: startedAt.toISOString(),
          workshopOrganizationId: order.workshopOrganizationId,
        }),
      });

      return tx.repairOrder.findFirstOrThrow({ where: { id } });
    });

    return toRepairOrderView(updated as RepairOrderRow);
  }

  /**
   * The work is finished and costed.
   *
   * Publishes two events, and both are needed. `REPAIR_COMPLETED` is one
   * workshop's part, with what that workshop charged — supplier-service scores
   * on it. `MAINTENANCE_COMPLETED` is the machine coming back: asset-service
   * returns it to `ACTIVE` and fleet-service clears both `inMaintenance` and
   * the dispatch block. A single event would force every consumer to work out
   * which of the two things it meant.
   *
   * The request moves to `COMPLETED`, not to `APPROVED`. Nothing settles until
   * an owner has looked at the bill (docs/17, ADR-028).
   */
  async complete(id: string, dto: CompleteRepairDto): Promise<RepairOrderView> {
    const order = await this.repository.findRepairOrderById(id);
    if (!order) throw RastaError.notFound('RepairOrder', id);

    assertRepairOrderTransition(order.status, 'COMPLETED');

    const request = await this.repository.findRequestById(order.maintenanceRequestId);
    if (!request) throw RastaError.notFound('MaintenanceRequest', order.maintenanceRequestId);

    assertRequestTransition(request.status, 'COMPLETED');

    const actor = getContext().userId ?? 'SYSTEM';
    const completedAt = dto.completedAt ? new Date(dto.completedAt) : new Date();

    if (order.startedAt && completedAt < order.startedAt) {
      throw RastaError.businessRule('A repair cannot finish before it started.', {
        rule: 'COMPLETE_BEFORE_START',
        startedAt: order.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      });
    }

    const returnedToServiceAt = dto.returnedToServiceAt
      ? new Date(dto.returnedToServiceAt)
      : completedAt;

    if (returnedToServiceAt < completedAt) {
      throw RastaError.businessRule(
        'A machine cannot go back into service before the repair finished.',
        {
          rule: 'RETURNED_BEFORE_COMPLETE',
          completedAt: completedAt.toISOString(),
          returnedToServiceAt: returnedToServiceAt.toISOString(),
        },
      );
    }

    // Downtime is measured from when the machine stopped being usable, not
    // from when a workshop got to it. For a breakdown those are different
    // days, and reporting the second as the first understates how long the
    // fleet was a machine short.
    const downtimeFrom = request.outOfServiceAt ?? request.startedAt ?? completedAt;
    const downtimeMinutes = Math.max(
      0,
      Math.round((returnedToServiceAt.getTime() - downtimeFrom.getTime()) / 60_000),
    );

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.repairOrder.updateMany({
        where: { id, status: 'IN_PROGRESS' },
        data: {
          status: 'COMPLETED',
          completedAt,
          completedBy: actor,
          workPerformed: dto.workPerformed,
        },
      });

      if (result.count === 0) {
        throw RastaError.invalidStateTransition(
          'RepairOrder',
          order.status,
          'COMPLETED',
          'This repair order was completed or cancelled by another request',
        );
      }

      // Totals are recomputed here as well as on every cost write. The lines
      // cannot change after this point, so this is the figure the owner
      // approves and the figure that reaches economic-service, and it is worth
      // it not resting on the last write having got it right.
      const totals = await this.recomputeTotals(tx, order.organizationId, id, request.id);

      const requestResult = await tx.maintenanceRequest.updateMany({
        where: { id: request.id, status: 'IN_PROGRESS' },
        data: {
          status: 'COMPLETED',
          completedAt,
          completedBy: actor,
          returnedToServiceAt,
          downtimeMinutes,
        },
      });

      if (requestResult.count === 0) {
        throw RastaError.invalidStateTransition(
          'MaintenanceRequest',
          request.status,
          'COMPLETED',
          'This request was changed by another request',
        );
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'RepairOrder',
        aggregateId: id,
        eventName: MAINTENANCE_EVENTS.REPAIR_COMPLETED,
        topic: MAINTENANCE_TOPIC,
        organizationId: order.organizationId,
        partitionKey: order.assetId,
        payload: validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_COMPLETED, {
          repairOrderId: id,
          requestId: request.id,
          assetId: order.assetId,
          organizationId: order.organizationId,
          workshopOrganizationId: order.workshopOrganizationId,
          completedAt: completedAt.toISOString(),
          totalCostMinor: totals.orderTotal.toString(),
          currency: order.currency,
        }),
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'MaintenanceRequest',
        aggregateId: request.id,
        eventName: MAINTENANCE_EVENTS.MAINTENANCE_COMPLETED,
        topic: MAINTENANCE_TOPIC,
        organizationId: order.organizationId,
        partitionKey: order.assetId,
        causationId: id,
        payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_COMPLETED, {
          requestId: request.id,
          assetId: order.assetId,
          organizationId: order.organizationId,
          type: request.type,
          scheduleId: request.scheduleId,
          completedAt: completedAt.toISOString(),
          downtimeMinutes,
          totalCostMinor: totals.requestTotal.toString(),
          currency: order.currency,
        }),
      });

      // A served schedule starts its next cycle from this service, and may
      // announce again. Doing it here, in the same transaction, is what stops
      // a completed service from leaving a schedule permanently overdue.
      if (request.scheduleId) {
        await this.rollScheduleForward(tx, request.scheduleId, request.id, completedAt);
      }

      return tx.repairOrder.findFirstOrThrow({ where: { id } });
    });

    requestsCompletedTotal.inc({ service: SERVICE_NAME, type: request.type });
    downtimeHours.observe({ service: SERVICE_NAME, type: request.type }, downtimeMinutes / 60);

    return toRepairOrderView(updated as RepairOrderRow);
  }

  /**
   * Withdraws a referral.
   *
   * The request stays where it is, so it can be referred elsewhere — a
   * workshop turning a job down is not the job going away. Costs already
   * recorded are kept: they were really incurred.
   */
  async cancel(id: string, dto: CancelRepairDto): Promise<RepairOrderView> {
    const order = await this.repository.findRepairOrderById(id);
    if (!order) throw RastaError.notFound('RepairOrder', id);

    assertRepairOrderTransition(order.status, 'CANCELLED');

    const actor = getContext().userId ?? 'SYSTEM';
    const cancelledAt = new Date();

    const updated = await this.repository.client.repairOrder.updateMany({
      where: { id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: {
        status: 'CANCELLED',
        cancelledAt,
        cancelledBy: actor,
        cancellationReason: dto.reason,
      },
    });

    if (updated.count === 0) {
      throw RastaError.invalidStateTransition(
        'RepairOrder',
        order.status,
        'CANCELLED',
        'This repair order was completed or cancelled by another request',
      );
    }

    const row = await this.repository.findRepairOrderById(id);
    return toRepairOrderView(row as RepairOrderRow);
  }

  // =========================================================================
  // Cost
  // =========================================================================

  async recordPart(id: string, dto: RecordPartDto): Promise<PartUsageView> {
    const order = await this.assertCostable(id);

    const unitCostMinor = BigInt(dto.unitCostMinor);
    const totalCostMinor = lineTotalMinor(dto.quantity, unitCostMinor, PART_QUANTITY_DECIMALS);
    if (totalCostMinor === null) {
      throw RastaError.businessRule('That quantity cannot be priced.', {
        rule: 'UNPRICEABLE_QUANTITY',
        quantity: dto.quantity,
      });
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date();
    const partId = `${ID_PREFIXES.partUsage}_${ulid()}`;

    const part = await this.repository.transaction(async (tx) => {
      await this.lock(tx, order.id, order.organizationId);

      const created = await tx.partUsage.create({
        data: {
          id: partId,
          organizationId: order.organizationId,
          repairOrderId: order.id,
          partName: dto.partName,
          partReference: dto.partReference ?? null,
          quantity: dto.quantity,
          unit: dto.unit,
          unitCostMinor,
          totalCostMinor,
          source: dto.source,
          sourceReference: dto.sourceReference ?? null,
          recordedAt,
          recordedBy: actor,
        },
      });

      // The cost line is written here, not by the caller, so a part can never
      // exist without the cost it produced and a `PART` cost can never exist
      // without the part it came from (ADR-028).
      await tx.maintenanceCost.create({
        data: {
          id: `${ID_PREFIXES.maintenanceCost}_${ulid()}`,
          organizationId: order.organizationId,
          repairOrderId: order.id,
          maintenanceRequestId: order.maintenanceRequestId,
          category: 'PART',
          amountMinor: totalCostMinor,
          currency: order.currency,
          description: `${dto.partName} × ${dto.quantity} ${dto.unit}`,
          partUsageId: partId,
          recordedAt,
          recordedBy: actor,
        },
      });

      await this.recomputeTotals(tx, order.organizationId, order.id, order.maintenanceRequestId);

      return created;
    });

    partsRecordedTotal.inc({ service: SERVICE_NAME, source: dto.source });
    return toPartView(part as PartRow);
  }

  async recordLabour(id: string, dto: RecordLabourDto): Promise<LabourEntryView> {
    const order = await this.assertCostable(id);

    const hourlyRateMinor = BigInt(dto.hourlyRateMinor);
    const totalCostMinor = lineTotalMinor(dto.hours, hourlyRateMinor, LABOUR_HOUR_DECIMALS);
    if (totalCostMinor === null) {
      throw RastaError.businessRule('Those hours cannot be priced.', {
        rule: 'UNPRICEABLE_HOURS',
        hours: dto.hours,
      });
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date();
    const performedAt = dto.performedAt ? new Date(dto.performedAt) : recordedAt;
    const labourId = `${ID_PREFIXES.laborEntry}_${ulid()}`;

    const entry = await this.repository.transaction(async (tx) => {
      await this.lock(tx, order.id, order.organizationId);

      const created = await tx.laborEntry.create({
        data: {
          id: labourId,
          organizationId: order.organizationId,
          repairOrderId: order.id,
          description: dto.description,
          technician: dto.technician ?? null,
          hours: dto.hours,
          hourlyRateMinor,
          totalCostMinor,
          performedAt,
          recordedAt,
          recordedBy: actor,
        },
      });

      await tx.maintenanceCost.create({
        data: {
          id: `${ID_PREFIXES.maintenanceCost}_${ulid()}`,
          organizationId: order.organizationId,
          repairOrderId: order.id,
          maintenanceRequestId: order.maintenanceRequestId,
          category: 'LABOUR',
          amountMinor: totalCostMinor,
          currency: order.currency,
          description: dto.description,
          laborEntryId: labourId,
          recordedAt,
          recordedBy: actor,
        },
      });

      await this.recomputeTotals(tx, order.organizationId, order.id, order.maintenanceRequestId);

      return created;
    });

    return toLabourView(entry as LabourRow);
  }

  /**
   * Records a cost that is neither a part nor metered labour — a call-out fee,
   * a third-party invoice.
   *
   * `PART` and `LABOUR` are refused here by the DTO's category enum, so those
   * two categories can only ever arrive through the work that produced them.
   * That is what makes the provenance on a cost line meaningful rather than
   * advisory.
   */
  async recordCost(id: string, dto: RecordCostDto): Promise<MaintenanceCostView> {
    const order = await this.assertCostable(id);

    if (dto.currency !== order.currency) {
      throw RastaError.businessRule('A cost must be in the same currency as the repair order.', {
        rule: 'CURRENCY_MISMATCH',
        expected: order.currency,
        actual: dto.currency,
      });
    }

    const actor = getContext().userId ?? 'SYSTEM';
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date();
    const costId = `${ID_PREFIXES.maintenanceCost}_${ulid()}`;

    const cost = await this.repository.transaction(async (tx) => {
      await this.lock(tx, order.id, order.organizationId);

      const created = await tx.maintenanceCost.create({
        data: {
          id: costId,
          organizationId: order.organizationId,
          repairOrderId: order.id,
          maintenanceRequestId: order.maintenanceRequestId,
          category: dto.category,
          amountMinor: BigInt(dto.amountMinor),
          currency: dto.currency,
          description: dto.description,
          recordedAt,
          recordedBy: actor,
        },
      });

      await this.recomputeTotals(tx, order.organizationId, order.id, order.maintenanceRequestId);

      return created;
    });

    return toCostView(cost as CostRow);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Recomputes the repair order's category totals and the request's grand
   * total from the cost lines.
   *
   * From the lines, every time. The alternative — adding the new amount to the
   * stored total — is a read-modify-write, and it is wrong under exactly the
   * concurrency this domain has: two people entering parts on the same job at
   * the same time.
   */
  private async recomputeTotals(
    tx: ExtendedPrismaClient,
    organizationId: string,
    repairOrderId: string,
    maintenanceRequestId: string,
  ): Promise<{ orderTotal: bigint; requestTotal: bigint }> {
    const byCategory = await this.repository.sumCostsByCategory(tx, organizationId, {
      repairOrderId,
    });

    const totals = new Map(byCategory.map((row) => [row.category, row.total]));
    const parts = totals.get('PART') ?? 0n;
    const labour = totals.get('LABOUR') ?? 0n;
    const other = [...totals.entries()]
      .filter(([category]) => category !== 'PART' && category !== 'LABOUR')
      .reduce((sum, [, amount]) => sum + amount, 0n);

    const orderTotal = parts + labour + other;

    await tx.repairOrder.update({
      where: { id: repairOrderId },
      data: {
        partsCostMinor: parts,
        labourCostMinor: labour,
        otherCostMinor: other,
        totalCostMinor: orderTotal,
      },
    });

    // The request's total spans every referral it ever had, including the
    // cancelled ones. A workshop that stripped the machine down and then gave
    // up still charged for it, and a history cheaper than the bank statement
    // is not a history.
    const requestLines = await this.repository.sumCostsByCategory(tx, organizationId, {
      maintenanceRequestId,
    });
    const requestTotal = requestLines.reduce((sum, row) => sum + row.total, 0n);

    await tx.maintenanceRequest.update({
      where: { id: maintenanceRequestId },
      data: { totalCostMinor: requestTotal },
    });

    return { orderTotal, requestTotal };
  }

  private async lock(
    tx: ExtendedPrismaClient,
    repairOrderId: string,
    organizationId: string,
  ): Promise<void> {
    const locked = await this.repository.lockRepairOrder(tx, repairOrderId, organizationId);
    if (!locked) {
      // The row vanished between the check and the lock, or belongs to another
      // tenant. Either way the caller learns nothing about which.
      throw RastaError.notFound('RepairOrder', repairOrderId);
    }
  }

  /**
   * Moves a served schedule on to its next cycle.
   *
   * The anchor becomes this completion — in both time and meter — and the
   * announcement marker is cleared so the schedule can announce again when the
   * new cycle comes due. A one-time schedule archives itself instead: it has
   * served its purpose, and leaving it active would report it as overdue for
   * ever.
   *
   * Runs inside the completion transaction so a served schedule and the
   * completion that served it commit together. A crash between them would
   * leave a repaired machine reporting as overdue.
   */
  private async rollScheduleForward(
    tx: ExtendedPrismaClient,
    scheduleId: string,
    requestId: string,
    completedAt: Date,
  ): Promise<void> {
    const schedule = await this.repository.findScheduleById(scheduleId, tx);
    if (!schedule) {
      this.logger.warn(`Request ${requestId} names schedule ${scheduleId}, which no longer exists`);
      return;
    }

    const meter = await this.repository.findMeter(schedule.assetId, tx);

    await tx.maintenanceSchedule.update({
      where: { id: scheduleId },
      data: {
        lastServicedAt: completedAt,
        lastServicedHourMeter: meter?.hourMeter ?? schedule.lastServicedHourMeter,
        lastServicedOdometer: meter?.odometer ?? schedule.lastServicedOdometer,
        lastServiceRequestId: requestId,
        dueAnnouncedAt: null,
        ...(schedule.recurrence === 'ONE_TIME' ? { status: 'ARCHIVED' as const } : {}),
      },
    });
  }

  /** The order must exist, be visible, and still accept cost. */
  private async assertCostable(id: string) {
    const order = await this.repository.findRepairOrderById(id);
    if (!order) throw RastaError.notFound('RepairOrder', id);

    await this.assertVisible(order.maintenanceRequestId, 'RepairOrder', id);

    if (!COSTABLE_REPAIR_ORDER_STATUSES.includes(order.status)) {
      throw RastaError.businessRule(
        `Cost cannot be added to a ${order.status.toLowerCase()} repair order.`,
        { rule: 'REPAIR_ORDER_NOT_COSTABLE', repairOrderId: id, status: order.status },
      );
    }

    return order;
  }

  /**
   * Object-level check for anything hanging off a request.
   *
   * A narrowed caller sees only what they reported, and is told the record
   * does not exist rather than that they may not see it — a 403 would confirm
   * that a colleague's repair, and what it cost, is there to be found.
   */
  private async assertVisible(
    requestId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    const scope = currentMaintenanceScope();
    if (scope.kind === 'SUPERVISOR') return;

    const request = await this.repository.findRequestById(requestId);
    if (!request || request.reportedBy !== scope.userId) {
      throw RastaError.notFound(resourceType, resourceId);
    }
  }
}

/** Part quantities carry three decimals; labour hours carry two. */
const PART_QUANTITY_DECIMALS = 3;
const LABOUR_HOUR_DECIMALS = 2;
