import {
  maintenanceMeterFullRunPayloadV1,
  maintenanceMeterReconciledPayloadV1,
} from './maintenance-meter';

const state = {
  mode: 'LEDGER',
  hours: '0.00',
  kilometres: '0.00',
  recordCount: 0,
  lastPeriodEnd: null,
  lastUsageRecordId: null,
};
const payload = {
  assetId: 'AST_A',
  organizationId: 'ORG_A',
  operatorId: 'USR_OPERATOR',
  runId: 'RUN_1',
  certificateDigest: 'a'.repeat(64),
  snapshot: '1:2:',
  before: { ...state, mode: 'LEGACY' },
  after: state,
};
it('accepts a bounded transition and refuses missing identity, evidence, noncanonical numbers and unknown fields', () => {
  expect(maintenanceMeterReconciledPayloadV1.parse(payload)).toEqual(payload);
  for (const bad of [
    { ...payload, operatorId: undefined },
    { ...payload, operatorId: ' ' },
    { ...payload, certificateDigest: 'bad' },
    { ...payload, snapshot: 'unproven' },
    { ...payload, after: { ...state, hours: '0' } },
    { ...payload, extra: 'private' },
  ])
    expect(maintenanceMeterReconciledPayloadV1.safeParse(bad).success).toBe(false);
});

it('validates bounded global full-run evidence without inventing an asset or tenant', () => {
  const p = {
    runId: 'RUN_1',
    operatorId: 'USR_1',
    before: 'INACTIVE',
    after: 'ACTIVE',
    inventoryDigest: 'a'.repeat(64),
    sourceBoundary: 'OWNER_SEAL',
    assetCount: 1,
    refusedCount: 1,
  };
  expect(maintenanceMeterFullRunPayloadV1.parse(p)).toEqual(p);
  for (const bad of [
    { ...p, refusedCount: 2 },
    { ...p, assetCount: 20_001 },
    { ...p, operatorId: '' },
    { ...p, sourceBoundary: 'a\nb' },
    { ...p, after: 'INACTIVE' },
  ])
    expect(maintenanceMeterFullRunPayloadV1.safeParse(bad).success).toBe(false);
});
