import {
  FLEET_METER_INVENTORY_SEALED,
  fleetMeterInventorySealedPayloadV1,
  auditChangesSchema,
  MAINTENANCE_METER_FULL_RUN_ACTIVATED,
  MAINTENANCE_METER_FULL_RUN_ACTIVATED_VERSION,
  maintenanceMeterFullRunPayloadV1,
  DLQ_REASONS,
  MAINTENANCE_METER_RECONCILED,
  MAINTENANCE_METER_RECONCILED_VERSION,
  maintenanceMeterReconciledPayloadV1,
  type AuditChange,
  type EventEnvelope,
} from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';

/** Keep only the contract's scalar meter state and reconciliation evidence. */
export function toMeterReconcileChanges(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditChange[] | null {
  if (envelope.eventName === FLEET_METER_INVENTORY_SEALED) {
    const parsed = fleetMeterInventorySealedPayloadV1.safeParse(envelope.payload);
    if (
      !parsed.success ||
      delivery.topic !== 'rasta.fleet.v1' ||
      envelope.producer !== 'fleet-service' ||
      envelope.eventVersion !== 1 ||
      envelope.aggregateType !== 'MeterInventorySeal' ||
      envelope.tenantId !== undefined ||
      parsed.data.runId !== envelope.aggregateId ||
      parsed.data.runId !== envelope.correlationId ||
      envelope.actor?.type !== 'USER' ||
      parsed.data.operatorId !== envelope.actor.id
    )
      throw new UnprocessableEventError(
        DLQ_REASONS.VALIDATION_FAILED,
        'Source seal evidence refused',
      );
    return auditChangesSchema.parse(
      Object.entries(parsed.data).map(([field, to]) => ({ field, from: null, to })),
    );
  }
  if (envelope.eventName === MAINTENANCE_METER_FULL_RUN_ACTIVATED) {
    const parsed = maintenanceMeterFullRunPayloadV1.safeParse(envelope.payload);
    if (
      !parsed.success ||
      delivery.topic !== 'rasta.maintenance.v1' ||
      envelope.producer !== 'maintenance-service' ||
      envelope.eventVersion !== MAINTENANCE_METER_FULL_RUN_ACTIVATED_VERSION ||
      envelope.aggregateType !== 'MeterFullRun' ||
      envelope.tenantId !== undefined ||
      parsed.data.runId !== envelope.aggregateId ||
      parsed.data.runId !== envelope.correlationId ||
      envelope.actor?.type !== 'USER' ||
      parsed.data.operatorId !== envelope.actor.id
    )
      throw new UnprocessableEventError(DLQ_REASONS.VALIDATION_FAILED, 'Full-run evidence refused');
    const p = parsed.data;
    return auditChangesSchema.parse([
      { field: 'state', from: p.before, to: p.after },
      ...(
        [
          'inventoryDigest',
          'sourceBoundary',
          'assetCount',
          'refusedCount',
          'operatorId',
          'runId',
        ] as const
      ).map((field) => ({ field, from: null, to: p[field] })),
    ]);
  }
  if (envelope.eventName !== MAINTENANCE_METER_RECONCILED) return null;
  const parsed = maintenanceMeterReconciledPayloadV1.safeParse(envelope.payload);
  if (
    delivery.topic !== 'rasta.maintenance.v1' ||
    envelope.producer !== 'maintenance-service' ||
    envelope.eventVersion !== MAINTENANCE_METER_RECONCILED_VERSION ||
    !parsed.success ||
    envelope.aggregateType !== 'AssetUsageMeter' ||
    parsed.data.assetId !== envelope.aggregateId ||
    parsed.data.organizationId !== envelope.tenantId ||
    parsed.data.runId !== envelope.correlationId ||
    envelope.actor?.type !== 'USER' ||
    parsed.data.operatorId !== envelope.actor.id
  ) {
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      'Meter reconciliation evidence refused',
    );
  }
  const p = parsed.data;
  return auditChangesSchema.parse([
    ...Object.keys(p.before).map((field) => ({
      field,
      from: p.before[field as keyof typeof p.before],
      to: p.after[field as keyof typeof p.after],
    })),
    ...(['certificateDigest', 'snapshot', 'runId', 'operatorId'] as const).map((field) => ({
      field,
      from: null,
      to: p[field],
    })),
  ]);
}
