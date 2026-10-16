import { AGGREGATE_OF, resolvePartitionKey } from './routing';
import {
  PROCUREMENT_EVENT_SCHEMAS,
  PROCUREMENT_EVENTS,
  validateProcurementPayload,
  type ProcurementEventName,
} from './events';

const PRODUCT = 'PRD_01JABCDEFGHJKMNPQRSTVWXYZ0';
const AT = '2026-10-16T10:00:00.000Z';

const window = {
  aggregationId: 'AGG_1',
  organizationId: 'ORG_BUYER',
  productId: PRODUCT,
  totalQuantity: '12',
};

/** One payload as published for every event. */
const PUBLISHED: Record<ProcurementEventName, Record<string, unknown>> = {
  DEMAND_SUBMITTED: {
    demandId: 'DMD_1',
    aggregationId: 'AGG_1',
    organizationId: 'ORG_BUYER',
    productId: PRODUCT,
    quantity: 5,
    aggregationOpened: true,
    closesAt: '2026-10-23T10:00:00.000Z',
    submittedBy: 'USR_1',
    submittedAt: AT,
  },
  DEMAND_WITHDRAWN: {
    demandId: 'DMD_1',
    aggregationId: 'AGG_1',
    organizationId: 'ORG_BUYER',
    productId: PRODUCT,
    quantity: 5,
    withdrawnBy: 'USR_1',
    withdrawnAt: AT,
  },
  DEMAND_AGGREGATED: {
    ...window,
    demandIds: ['DMD_1', 'DMD_2'],
    settingVersion: null,
    closedAt: AT,
  },
  AGGREGATION_WINDOW_EXTENDED: {
    ...window,
    previousClosesAt: '2026-10-09T10:00:00.000Z',
    closesAt: '2026-10-16T10:00:00.000Z',
    windows: 1,
    extensionCount: 1,
  },
  AGGREGATION_REFERRED: { ...window, demandIds: ['DMD_1'], closedAt: AT },
  AGGREGATION_LAPSED: {
    ...window,
    totalQuantity: '0',
    demandIds: [],
    reasonCode: 'NO_LIVE_DEMAND',
    closedAt: AT,
  },
};

describe('the procurement events (ADR-070 § 9, PR 1)', () => {
  it('are the demand’s two and the four of a window’s end, each with a schema and an aggregate', () => {
    const names = [
      'DEMAND_SUBMITTED',
      'DEMAND_WITHDRAWN',
      'DEMAND_AGGREGATED',
      'AGGREGATION_WINDOW_EXTENDED',
      'AGGREGATION_REFERRED',
      'AGGREGATION_LAPSED',
    ];
    expect(Object.keys(PROCUREMENT_EVENTS)).toEqual(names);
    expect(Object.keys(PROCUREMENT_EVENT_SCHEMAS)).toEqual(names);
    expect(Object.keys(AGGREGATE_OF)).toEqual(names);
  });

  it.each(Object.keys(PUBLISHED) as ProcurementEventName[])(
    '%s accepts its payload as published and is keyed by the aggregation',
    (name) => {
      const payload = validateProcurementPayload(name, PUBLISHED[name]);
      expect(resolvePartitionKey(name, payload).key).toBe('AGG_1');
    },
  );

  it.each(Object.keys(PUBLISHED) as ProcurementEventName[])(
    '%s refuses a field it does not publish: no note, reason or amount can ride along',
    (name) => {
      for (const extra of ['note', 'reason', 'amountMinor', 'unitPriceMinor']) {
        expect(() =>
          validateProcurementPayload(name, { ...PUBLISHED[name], [extra]: 'x' }),
        ).toThrow(/does not match its published contract/);
      }
    },
  );

  it('refuses an instant with an offset: UTC only', () => {
    expect(() =>
      validateProcurementPayload('DEMAND_SUBMITTED', {
        ...PUBLISHED.DEMAND_SUBMITTED,
        submittedAt: '2026-10-16T13:30:00+03:30',
      }),
    ).toThrow();
  });

  it('refuses a quantity that is not a whole positive number, and a product not of marketplace’s shape', () => {
    for (const quantity of [0, -1, 1.5, 2_147_483_648]) {
      expect(() =>
        validateProcurementPayload('DEMAND_SUBMITTED', { ...PUBLISHED.DEMAND_SUBMITTED, quantity }),
      ).toThrow();
    }
    expect(() =>
      validateProcurementPayload('DEMAND_SUBMITTED', {
        ...PUBLISHED.DEMAND_SUBMITTED,
        productId: 'SKU-1',
      }),
    ).toThrow();
  });

  it('carries a window’s total as a decimal string, exact past 2^53', () => {
    expect(() =>
      validateProcurementPayload('DEMAND_AGGREGATED', {
        ...PUBLISHED.DEMAND_AGGREGATED,
        totalQuantity: '9007199254740993',
      }),
    ).not.toThrow();
    for (const totalQuantity of [12, '-1', '01', '1.5']) {
      expect(() =>
        validateProcurementPayload('DEMAND_AGGREGATED', {
          ...PUBLISHED.DEMAND_AGGREGATED,
          totalQuantity,
        }),
      ).toThrow();
    }
  });

  it('a READY window names at least one demand; a lapsed one names its closed reason', () => {
    expect(() =>
      validateProcurementPayload('DEMAND_AGGREGATED', {
        ...PUBLISHED.DEMAND_AGGREGATED,
        demandIds: [],
      }),
    ).toThrow();
    expect(() =>
      validateProcurementPayload('AGGREGATION_LAPSED', {
        ...PUBLISHED.AGGREGATION_LAPSED,
        reasonCode: 'BECAUSE',
      }),
    ).toThrow();
  });
});

describe('routing', () => {
  it('says what each event is about: the demand or the aggregation', () => {
    expect(AGGREGATE_OF.DEMAND_SUBMITTED).toBe('DemandRequest');
    expect(AGGREGATE_OF.DEMAND_WITHDRAWN).toBe('DemandRequest');
    expect(AGGREGATE_OF.DEMAND_AGGREGATED).toBe('DemandAggregation');
  });

  it('refuses an event that names no aggregation to key it by', () => {
    expect(() => resolvePartitionKey('DEMAND_SUBMITTED', {})).toThrow(/no aggregationId/);
  });
});
