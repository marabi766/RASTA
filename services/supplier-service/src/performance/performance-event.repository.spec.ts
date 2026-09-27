import type { PerformanceEventInput } from './performance-event';
import { FACT_FIELDS, differingFactFields } from './performance-event.repository';

/**
 * Redelivery comparison (Codex review of #120, finding 4): every field that
 * states the fact is compared; only delivery metadata is not.
 */

const STORED: PerformanceEventInput = {
  organizationId: 'ORG_A',
  sourceEventId: 'EVT_1',
  sourceEventName: 'ORDER_DISPUTE_RESOLVED',
  component: 'DISPUTE_ABSENCE',
  outcomeKind: 'ORDER',
  outcomeKey: 'ORD_1',
  responsibility: 'SUPPLIER',
  rating: null,
  promisedAt: null,
  deliveredAt: null,
  compensatesSourceEventId: null,
  occurredAt: new Date('2026-09-20T10:00:00.000Z'),
  correlationId: 'COR_1',
};

const MUTATIONS: Record<(typeof FACT_FIELDS)[number], Partial<PerformanceEventInput>> = {
  organizationId: { organizationId: 'ORG_B' },
  sourceEventName: { sourceEventName: 'ORDER_CANCELLED' },
  component: { component: 'CANCELLATION_ABSENCE' },
  outcomeKind: { outcomeKind: 'REPAIR_ORDER' },
  outcomeKey: { outcomeKey: 'ORD_2' },
  responsibility: { responsibility: 'BUYER' },
  rating: { rating: 3 },
  promisedAt: { promisedAt: new Date('2026-10-01T00:00:00.000Z') },
  deliveredAt: { deliveredAt: new Date('2026-10-01T00:00:00.000Z') },
  compensatesSourceEventId: { compensatesSourceEventId: 'EVT_0' },
  occurredAt: { occurredAt: new Date('2026-09-20T10:00:00.001Z') },
};

describe('the fields compared on redelivery', () => {
  it('are every field of the fact except the store’s own id, its clock and the trace id', () => {
    const everyInputField = Object.keys(STORED).sort();

    expect([...FACT_FIELDS, 'correlationId', 'sourceEventId'].sort()).toEqual(everyInputField);
  });

  it.each(Object.entries(MUTATIONS))('names %s when only it differs', (field, mutation) => {
    expect(differingFactFields(STORED, { ...STORED, ...mutation })).toEqual([field]);
  });

  it('ignores a new correlation id — a replay carries its own trace', () => {
    const replay: PerformanceEventInput = { ...STORED, correlationId: 'COR_2' };

    expect(differingFactFields(STORED, replay)).toEqual([]);
  });

  it('compares instants by value, not by object identity', () => {
    expect(
      differingFactFields(STORED, { ...STORED, occurredAt: new Date(STORED.occurredAt.getTime()) }),
    ).toEqual([]);
  });

  it('treats null and a value as different', () => {
    expect(differingFactFields(STORED, { ...STORED, rating: 0 })).toEqual(['rating']);
  });
});
