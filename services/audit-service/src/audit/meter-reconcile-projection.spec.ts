import type { EventEnvelope } from '@rasta/contracts';
import { toAuditEventRecord } from './audit.mapper';

const state = {
  mode: 'LEDGER',
  hours: '0.00',
  kilometres: '0.00',
  recordCount: 0,
  lastPeriodEnd: null,
  lastUsageRecordId: null,
};
const event = {
  eventId: 'EVT_1',
  eventName: 'MAINTENANCE_METER_RECONCILED',
  eventVersion: 1,
  occurredAt: '2026-11-01T00:00:00Z',
  producer: 'maintenance-service',
  aggregateType: 'AssetUsageMeter',
  aggregateId: 'AST_A',
  tenantId: 'ORG_A',
  actor: { type: 'USER', id: 'USR_OPERATOR' },
  correlationId: 'RUN_1',
  payload: {
    assetId: 'AST_A',
    organizationId: 'ORG_A',
    before: { ...state, mode: 'LEGACY' },
    after: state,
    operatorId: 'USR_OPERATOR',
    certificateDigest: 'a'.repeat(64),
    snapshot: '1:2:',
    runId: 'RUN_1',
  },
} as EventEnvelope;
it.each([
  { eventVersion: 2 },
  { correlationId: 'OTHER_RUN' },
  { actor: undefined },
  { actor: { type: 'USER', id: 'USR_OTHER' } },
  { aggregateId: 'AST_B' },
  { tenantId: 'ORG_B' },
  { producer: 'fleet-service' },
  { aggregateType: 'Asset' },
  { payload: { ...(event.payload as object), operatorId: undefined } },
])('refuses inconsistent meter evidence %# without recording partial audit state', (override) => {
  expect(() =>
    toAuditEventRecord({ ...event, ...override } as EventEnvelope, {
      topic: 'rasta.maintenance.v1',
      partition: 0,
    }),
  ).toThrow('Meter reconciliation evidence refused');
});
it('refuses a meter event on another topic', () => {
  expect(() => toAuditEventRecord(event, { topic: 'rasta.fleet.v1', partition: 0 })).toThrow();
});

const fullRun = {
  ...event,
  eventName: 'MAINTENANCE_METER_FULL_RUN_ACTIVATED',
  aggregateType: 'MeterFullRun',
  aggregateId: 'RUN_1',
  tenantId: undefined,
  payload: {
    runId: 'RUN_1',
    operatorId: 'USR_OPERATOR',
    before: 'INACTIVE',
    after: 'ACTIVE',
    inventoryDigest: 'a'.repeat(64),
    sourceBoundary: 'OWNER_SEAL',
    assetCount: 2,
    refusedCount: 1,
  },
} as EventEnvelope;
it('preserves global activation state and bounded inventory evidence in the audit path', () => {
  const row = toAuditEventRecord(fullRun, { topic: 'rasta.maintenance.v1', partition: 0 });
  expect(row.organizationId).toBeNull();
  expect(row.actorId).toBe('USR_OPERATOR');
  expect(row.changes).toEqual(
    expect.arrayContaining([
      { field: 'state', from: 'INACTIVE', to: 'ACTIVE' },
      { field: 'inventoryDigest', from: null, to: 'a'.repeat(64) },
      { field: 'refusedCount', from: null, to: 1 },
    ]),
  );
});
it.each([
  { tenantId: 'ORG_A' },
  { tenantId: null },
  { aggregateId: 'RUN_OTHER' },
  { actor: undefined },
  { producer: 'fleet-service' },
  { eventVersion: 2 },
  { aggregateType: 'Asset' },
  { correlationId: 'OTHER' },
  { actor: { type: 'USER', id: 'OTHER' } },
  { payload: { ...(fullRun.payload as object), refusedCount: 3 } },
])('refuses inconsistent global activation evidence %#', (override) => {
  expect(() =>
    toAuditEventRecord({ ...fullRun, ...override } as EventEnvelope, {
      topic: 'rasta.maintenance.v1',
      partition: 0,
    }),
  ).toThrow('Full-run evidence refused');
});
