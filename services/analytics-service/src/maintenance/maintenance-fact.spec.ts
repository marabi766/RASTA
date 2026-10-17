import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import {
  MAINTENANCE_COMPLETED,
  contradictionError,
  contradictions,
  toMaintenanceFact,
  type MaintenanceFact,
} from './maintenance-fact';

const ORG = 'ORG_A';

function envelope(
  payload: Record<string, unknown> = {},
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: 'EVT_1',
    eventName: MAINTENANCE_COMPLETED,
    eventVersion: 1,
    occurredAt: '2026-10-10T08:00:00.000Z',
    producer: 'maintenance-service',
    aggregateType: 'MaintenanceRequest',
    aggregateId: 'MRQ_1',
    tenantId: ORG,
    correlationId: 'COR_1',
    payload: {
      requestId: 'MRQ_1',
      assetId: 'AST_1',
      organizationId: ORG,
      type: 'PREVENTIVE',
      scheduleId: 'MSC_1',
      completedAt: '2026-10-10T07:59:00.000Z',
      downtimeMinutes: 90,
      totalCostMinor: '1250000',
      currency: 'IRR',
      ...payload,
    },
    ...overrides,
  } as EventEnvelope;
}

/** Runs `fn` and returns the dead-letter verdict it threw. */
function verdict(fn: () => unknown): UnprocessableEventError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a dead-letter verdict');
}

describe('toMaintenanceFact', () => {
  it('reads the fact a completion states, under the envelope’s tenant', () => {
    expect(toMaintenanceFact(envelope())).toEqual({
      organizationId: ORG,
      requestId: 'MRQ_1',
      assetId: 'AST_1',
      maintenanceType: 'PREVENTIVE',
      scheduleId: 'MSC_1',
      completedAt: new Date('2026-10-10T07:59:00.000Z'),
      downtimeMinutes: 90,
      totalCostMinor: 1_250_000n,
      currency: 'IRR',
      sourceEventId: 'EVT_1',
    });
  });

  it('keeps an unknown downtime as unknown, never as zero', () => {
    expect(toMaintenanceFact(envelope({ downtimeMinutes: null }))?.downtimeMinutes).toBeNull();
  });

  it('accepts a type the producer adds, and extra payload fields', () => {
    const fact = toMaintenanceFact(envelope({ type: 'CONDITION_BASED', note: 'ignored' }));
    expect(fact?.maintenanceType).toBe('CONDITION_BASED');
  });

  it('keeps the largest cost a bigint holds', () => {
    const fact = toMaintenanceFact(envelope({ totalCostMinor: '9223372036854775807' }));
    expect(fact?.totalCostMinor).toBe(9_223_372_036_854_775_807n);
  });

  it('skips an event it does not read', () => {
    expect(toMaintenanceFact(envelope({}, { eventName: 'MAINTENANCE_STARTED' }))).toBeNull();
  });

  it.each([
    ['no request', { requestId: undefined }, 'requestId'],
    ['a blank asset', { assetId: '  ' }, 'assetId'],
    ['a type that is not a code', { type: 'preventive' }, 'type'],
    ['a date that is not ISO', { completedAt: '10/10/2026' }, 'completedAt'],
    ['a negative downtime', { downtimeMinutes: -1 }, 'downtimeMinutes'],
    ['a fractional downtime', { downtimeMinutes: 1.5 }, 'downtimeMinutes'],
    ['a cost past a bigint', { totalCostMinor: '9223372036854775808' }, 'totalCostMinor'],
    ['a signed cost', { totalCostMinor: '-5' }, 'totalCostMinor'],
    ['a currency that is not ISO 4217', { currency: 'rial' }, 'currency'],
  ])(
    'dead-letters %s as VALIDATION_FAILED, naming the field and never its value',
    (_l, change, field) => {
      const error = verdict(() => toMaintenanceFact(envelope(change)));
      expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(error.message).toContain(field);
      for (const value of Object.values(change)) {
        if (typeof value === 'string' && value.trim()) expect(error.message).not.toContain(value);
      }
    },
  );

  it('refuses an envelope with no tenant, whatever the payload says', () => {
    const error = verdict(() => toMaintenanceFact(envelope({}, { tenantId: undefined })));
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toContain('carries no tenant');
  });

  it('refuses a payload whose organization is not the envelope’s, naming neither', () => {
    const error = verdict(() => toMaintenanceFact(envelope({ organizationId: 'ORG_B' })));
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toContain('tenant_mismatch');
    expect(error.message).not.toContain('ORG_B');
  });
});

describe('contradictions', () => {
  const held = toMaintenanceFact(envelope()) as MaintenanceFact;

  it('finds none between two statements of the same fact, whatever their event ids', () => {
    const again = toMaintenanceFact(envelope({}, { eventId: 'EVT_2' })) as MaintenanceFact;
    expect(contradictions(held, again)).toEqual([]);
  });

  it.each([
    ['assetId', { assetId: 'AST_2' }],
    ['maintenanceType', { type: 'CORRECTIVE' }],
    ['scheduleId', { scheduleId: null }],
    ['completedAt', { completedAt: '2026-10-10T08:00:00.000Z' }],
    ['downtimeMinutes', { downtimeMinutes: null }],
    ['totalCostMinor', { totalCostMinor: '1250001' }],
    ['currency', { currency: 'USD' }],
  ])('names %s when it differs', (field, change) => {
    const stated = toMaintenanceFact(envelope(change, { eventId: 'EVT_2' })) as MaintenanceFact;
    expect(contradictions(held, stated)).toEqual([field]);
  });

  it('is a BUSINESS_RULE_VIOLATION that names the request and the fields, never a cost', () => {
    const error = contradictionError(envelope({}, { eventId: 'EVT_2' }), held, ['totalCostMinor']);
    expect(error.reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
    expect(error.message).toContain('MRQ_1');
    expect(error.message).toContain('EVT_1');
    expect(error.message).toContain('totalCostMinor');
    expect(error.message).not.toContain('1250000');
  });
});
