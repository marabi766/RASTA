import {
  auditChangesSchema,
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
