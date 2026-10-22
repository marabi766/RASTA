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
const RFQ = 'RFQ_01JABCDEFGHJKMNPQRSTVWXYZ2';
const AGGREGATION = 'AGG_01JABCDEFGHJKMNPQRSTVWXYZ3';
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
  AGGREGATION_SETTING_CHANGED: {
    organizationId: 'ORG_BUYER',
    settingVersion: 2,
    previousVersion: 1,
    windowHours: 72,
    minQuantity: 500,
    shortfallPolicy: 'REFER',
    recordedBy: 'USR_1',
    recordedAt: AT,
  },
  RFQ_ISSUED: {
    rfqId: RFQ,
    organizationId: 'ORG_BUYER',
    aggregationId: AGGREGATION,
    rfqVersion: 1,
    productId: PRODUCT,
    totalQuantity: 12,
    procurementNature: 'INQUIRY',
    quotationClosingAt: '2026-10-30T10:00:00.000Z',
    invitedSupplierOrganizationIds: ['ORG_01JABCDEFGHJKMNPQRSTVWXYZ1'],
    criteriaCount: 1,
    criteriaDigest: 'b'.repeat(64),
    keyId: 'RFK_1',
    issuedBy: 'USR_1',
    issuedAt: AT,
  },
  RFQ_CLOSED: {
    rfqId: RFQ,
    organizationId: 'ORG_BUYER',
    aggregationId: AGGREGATION,
    rfqVersion: 2,
    quotationClosingAt: '2026-10-30T10:00:00.000Z',
    trigger: 'SWEEPER',
    closedBy: null,
    closedAt: '2026-10-30T10:00:01.000Z',
  },
  RFQ_CANCELLED: {
    rfqId: RFQ,
    organizationId: 'ORG_BUYER',
    aggregationId: AGGREGATION,
    rfqVersion: 2,
    previousStatus: 'PUBLISHED',
    reasonCode: 'BUYER_REQUEST',
    cancelledBy: 'USR_1',
    cancelledAt: AT,
  },
};

/** What each event is keyed by: the aggregation, a setting's organization, an RFQ's id. */
const KEY_OF = (name: ProcurementEventName): string =>
  name === 'AGGREGATION_SETTING_CHANGED' ? 'ORG_BUYER' : name.startsWith('RFQ_') ? RFQ : 'AGG_1';

describe('the procurement events (ADR-070 § 9, PRs 1 to 3 and 6)', () => {
  it('are the demand’s two, the four of a window’s end, the cancellation, the setting and the RFQ’s three, each with a schema and an aggregate', () => {
    const names = [
      'DEMAND_SUBMITTED',
      'DEMAND_WITHDRAWN',
      'DEMAND_AGGREGATED',
      'AGGREGATION_WINDOW_EXTENDED',
      'AGGREGATION_REFERRED',
      'AGGREGATION_LAPSED',
      'AGGREGATION_CANCELLED',
      'AGGREGATION_SETTING_CHANGED',
      'RFQ_ISSUED',
      'RFQ_CLOSED',
      'RFQ_CANCELLED',
    ];
    expect(Object.keys(PROCUREMENT_EVENTS)).toEqual(names);
    expect(Object.keys(PROCUREMENT_EVENT_SCHEMAS)).toEqual(names);
    expect(Object.keys(AGGREGATE_OF)).toEqual(names);
  });

  it.each(Object.keys(PUBLISHED) as ProcurementEventName[])(
    '%s accepts its payload as published and is keyed by the aggregation — a setting by its organization, an RFQ’s by the RFQ',
    (name) => {
      const payload = validateProcurementPayload(name, PUBLISHED[name]);
      expect(resolvePartitionKey(name, payload).key).toBe(KEY_OF(name));
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

  it('keys an RFQ’s events by the RFQ — with the aggregation it came from in the payload — and refuses one that names none (plan PR 6)', () => {
    for (const name of ['RFQ_ISSUED', 'RFQ_CLOSED', 'RFQ_CANCELLED'] as const) {
      expect(AGGREGATE_OF[name]).toBe('Rfq');
      expect(() => resolvePartitionKey(name, { aggregationId: AGGREGATION })).toThrow(/no rfqId/);
    }
  });

  it('an RFQ’s events carry no label, reason text or amount, and a close names its person only when a person closed it', () => {
    for (const extra of [{ criteria: [] }, { cancelReason: 'over budget' }, { amountMinor: '1' }]) {
      for (const name of ['RFQ_ISSUED', 'RFQ_CLOSED', 'RFQ_CANCELLED'] as const) {
        expect(() => validateProcurementPayload(name, { ...PUBLISHED[name], ...extra })).toThrow();
      }
    }
    expect(() =>
      validateProcurementPayload('RFQ_CLOSED', { ...PUBLISHED.RFQ_CLOSED, closedBy: 'USR_1' }),
    ).toThrow();
    expect(
      validateProcurementPayload('RFQ_CLOSED', {
        ...PUBLISHED.RFQ_CLOSED,
        trigger: 'MANUAL',
        closedBy: 'USR_1',
      }),
    ).toMatchObject({ trigger: 'MANUAL' });
  });

  it('keys a setting version by its organization, and refuses one that names none (plan PR 3)', () => {
    expect(AGGREGATE_OF.AGGREGATION_SETTING_CHANGED).toBe('AggregationSetting');
    expect(
      resolvePartitionKey('AGGREGATION_SETTING_CHANGED', { organizationId: 'ORG_1' }).key,
    ).toBe('ORG_1');
    expect(() => resolvePartitionKey('AGGREGATION_SETTING_CHANGED', {})).toThrow(
      /no organizationId/,
    );
  });

  it('a setting version names the one before it, null before the first, and no free text', () => {
    const first = {
      ...PUBLISHED.AGGREGATION_SETTING_CHANGED,
      settingVersion: 1,
      previousVersion: null,
    };
    expect(validateProcurementPayload('AGGREGATION_SETTING_CHANGED', first)).toEqual(first);
    for (const wrong of [
      { settingVersion: 1, previousVersion: 1 },
      { settingVersion: 3, previousVersion: 1 },
      { settingVersion: 2, previousVersion: null },
      { minQuantity: 2_147_483_648 },
      { windowHours: 8761 },
      { shortfallPolicy: 'WAIT' },
    ]) {
      expect(() =>
        validateProcurementPayload('AGGREGATION_SETTING_CHANGED', {
          ...PUBLISHED.AGGREGATION_SETTING_CHANGED,
          ...wrong,
        }),
      ).toThrow(/does not match its published contract/);
    }
  });
});
