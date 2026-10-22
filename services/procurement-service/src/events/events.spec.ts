import { createHash } from 'node:crypto';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';
import {
  PROCUREMENT_EVENT_SCHEMAS,
  PROCUREMENT_EVENTS,
  demandIdsDigest,
  validateProcurementPayload,
  type ProcurementEventName,
} from './events';

const PRODUCT = 'PRD_01JABCDEFGHJKMNPQRSTVWXYZ0';
const AT = '2026-10-16T10:00:00.000Z';

const window = {
  aggregationId: 'AGG_1',
  organizationId: 'ORG_BUYER',
  productId: PRODUCT,
  totalQuantity: 12,
};

/** SHA-256 of the empty string: the digest of a window that ended with no live demand. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
    demandCount: 2,
    demandIdsSha256: demandIdsDigest(['DMD_1', 'DMD_2']),
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
  AGGREGATION_REFERRED: {
    ...window,
    demandCount: 1,
    demandIdsSha256: demandIdsDigest(['DMD_1']),
    closedAt: AT,
  },
  AGGREGATION_LAPSED: {
    ...window,
    totalQuantity: 0,
    demandCount: 0,
    demandIdsSha256: EMPTY_SHA256,
    reasonCode: 'NO_LIVE_DEMAND',
    closedAt: AT,
  },
  AGGREGATION_CANCELLED: {
    ...window,
    demandCount: 2,
    demandIdsSha256: demandIdsDigest(['DMD_1', 'DMD_2']),
    cancelledBy: 'USR_1',
    cancelledAt: AT,
  },
};

describe('the procurement events (ADR-070 § 9, PRs 1 and 2)', () => {
  it('are the demand’s two, the four of a window’s end and the cancellation, each with a schema and an aggregate', () => {
    const names = [
      'DEMAND_SUBMITTED',
      'DEMAND_WITHDRAWN',
      'DEMAND_AGGREGATED',
      'AGGREGATION_WINDOW_EXTENDED',
      'AGGREGATION_REFERRED',
      'AGGREGATION_LAPSED',
      'AGGREGATION_CANCELLED',
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

  it('carries a window’s total as a whole number up to MAX_QUANTITY (ADR-070 § 2)', () => {
    expect(() =>
      validateProcurementPayload('DEMAND_AGGREGATED', {
        ...PUBLISHED.DEMAND_AGGREGATED,
        totalQuantity: 2_147_483_647,
      }),
    ).not.toThrow();
    for (const totalQuantity of [2_147_483_648, -1, 1.5, '12']) {
      expect(() =>
        validateProcurementPayload('DEMAND_AGGREGATED', {
          ...PUBLISHED.DEMAND_AGGREGATED,
          totalQuantity,
        }),
      ).toThrow();
    }
  });

  it('names a window’s demands by count and digest, never by an unbounded list (ADR-070 § 9)', () => {
    for (const name of [
      'DEMAND_AGGREGATED',
      'AGGREGATION_REFERRED',
      'AGGREGATION_LAPSED',
      'AGGREGATION_CANCELLED',
    ] as const) {
      expect(() =>
        validateProcurementPayload(name, { ...PUBLISHED[name], demandIds: ['DMD_1'] }),
      ).toThrow();
      expect(() =>
        validateProcurementPayload(name, { ...PUBLISHED[name], demandIdsSha256: 'ABC' }),
      ).toThrow();
    }
  });

  it('digests the ids sorted and joined by a newline, whatever order they come in', () => {
    const expected = createHash('sha256').update('DMD_1\nDMD_2', 'utf8').digest('hex');
    expect(demandIdsDigest(['DMD_2', 'DMD_1'])).toBe(expected);
    expect(demandIdsDigest(['DMD_1', 'DMD_2'])).toBe(expected);
    expect(demandIdsDigest([])).toBe(EMPTY_SHA256);
  });

  it('a READY window names at least one demand; a lapsed one names its closed reason', () => {
    expect(() =>
      validateProcurementPayload('DEMAND_AGGREGATED', {
        ...PUBLISHED.DEMAND_AGGREGATED,
        demandCount: 0,
      }),
    ).toThrow();
    expect(() =>
      validateProcurementPayload('AGGREGATION_LAPSED', {
        ...PUBLISHED.AGGREGATION_LAPSED,
        reasonCode: 'BECAUSE',
      }),
    ).toThrow();
  });

  it('a cancellation names its demands and who cancelled, never why', () => {
    expect(() =>
      validateProcurementPayload('AGGREGATION_CANCELLED', {
        ...PUBLISHED.AGGREGATION_CANCELLED,
        demandCount: 0,
      }),
    ).toThrow();
    expect(() =>
      validateProcurementPayload('AGGREGATION_CANCELLED', {
        ...PUBLISHED.AGGREGATION_CANCELLED,
        cancelReason: 'no longer needed',
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
