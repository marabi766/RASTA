import { PERFORMANCE_FORMULA_EVENTS, SUPPLIER_EVENTS, type SupplierEventName } from './events';
import { AGGREGATE_OF, isFormulaEvent, resolvePartitionKey } from './routing';

/**
 * Event routing and the partition-key policy.
 *
 * `docs/07` § 7.7 makes every deviation from `partitionKey = aggregateId`
 * something that has to be explicit and documented. This service deviates for
 * three of its four events, so the deviation is asserted rather than left to be
 * noticed.
 */

const SUPPLIER_ID = 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2';

describe('aggregate identity', () => {
  it('names an aggregate for every published event', () => {
    for (const name of Object.values(SUPPLIER_EVENTS)) {
      expect(AGGREGATE_OF[name]).toBeTruthy();
    }
  });

  it('attributes each event to the aggregate it is actually about', () => {
    expect(AGGREGATE_OF.SUPPLIER_REGISTERED).toBe('Supplier');
    expect(AGGREGATE_OF.SUPPLIER_QUALIFIED).toBe('Qualification');
    expect(AGGREGATE_OF.SUPPLIER_REJECTED).toBe('Qualification');
    expect(AGGREGATE_OF.SUPPLIER_SUSPENDED).toBe('Suspension');
  });
});

describe('stream identity is not aggregate identity', () => {
  it.each(Object.values(SUPPLIER_EVENTS))('%s is keyed by the supplier', (name) => {
    expect(resolvePartitionKey(name, { supplierId: SUPPLIER_ID }).key).toBe(SUPPLIER_ID);
  });

  it('deviates from the aggregate id for the four non-Supplier aggregates', () => {
    // The documented deviation (docs/07 § 7.7, ADR-051 § C-7). A qualification
    // event keyed by its own id could land on a different partition from the
    // suspension that followed it, and a consumer could apply the approval
    // after the suspension and un-hide an offer that should stay hidden.
    const deviating = (Object.values(SUPPLIER_EVENTS) as SupplierEventName[]).filter(
      (name) => AGGREGATE_OF[name] !== 'Supplier',
    );

    expect(deviating.sort()).toEqual([
      'SUPPLIER_QUALIFIED',
      'SUPPLIER_REINSTATED',
      'SUPPLIER_REJECTED',
      'SUPPLIER_SUSPENDED',
    ]);
  });

  it('puts the whole lifecycle of one supplier on one key', () => {
    const keys = (Object.values(SUPPLIER_EVENTS) as SupplierEventName[]).map(
      (name) => resolvePartitionKey(name, { supplierId: SUPPLIER_ID }).key,
    );

    expect(new Set(keys).size).toBe(1);
  });

  it('separates two suppliers onto different keys', () => {
    const a = resolvePartitionKey('SUPPLIER_SUSPENDED', { supplierId: 'SUP_A' }).key;
    const b = resolvePartitionKey('SUPPLIER_SUSPENDED', { supplierId: 'SUP_B' }).key;

    expect(a).not.toBe(b);
  });

  it('is not keyed by the organization', () => {
    // Identical in practice today — one profile per organization — but it would
    // tie the stream to an identifier this service does not own, so a future
    // organization merge would silently rewrite the stream identity.
    const decision = resolvePartitionKey('SUPPLIER_REGISTERED', { supplierId: SUPPLIER_ID });

    expect(decision.key).not.toMatch(/^ORG_/);
  });
});

describe('the decision carries its reason', () => {
  it('states why the key was chosen, for the reader of a stuck partition', () => {
    const decision = resolvePartitionKey('SUPPLIER_QUALIFIED', { supplierId: SUPPLIER_ID });

    expect(decision.reason).toContain('SUPPLIER_QUALIFIED');
    expect(decision.reason).toMatch(/co-partitioned/);
  });

  it('does not claim ordering — D-027 is open', () => {
    // The key co-partitions; it does not order. Several relay replicas may
    // publish separate rows of one key concurrently, and backoff, a live lease
    // or a manual DLQ replay can move a later event ahead of an earlier one.
    const decision = resolvePartitionKey('SUPPLIER_SUSPENDED', { supplierId: SUPPLIER_ID });

    expect(decision.reason).not.toMatch(/guarantee|ordered in|in order/i);
  });
});

describe('the performance formula events', () => {
  const VERSION_ID = 'PFV_01JBQ8Z4K7M2N5P8R1T3V6X9Y2';

  it.each(Object.values(PERFORMANCE_FORMULA_EVENTS))(
    '%s is keyed by the formula version, which is also its aggregate',
    (name) => {
      expect(AGGREGATE_OF[name]).toBe('PerformanceFormulaVersion');
      expect(resolvePartitionKey(name, { formulaVersionId: VERSION_ID }).key).toBe(VERSION_ID);
      expect(isFormulaEvent(name)).toBe(true);
    },
  );

  it('says why it is not keyed by a supplier', () => {
    const decision = resolvePartitionKey('PERFORMANCE_FORMULA_VERSION_CREATED', {
      formulaVersionId: VERSION_ID,
    });

    expect(decision.reason).toMatch(/platform-wide/);
  });

  it('refuses to key a formula event without its version, or a supplier event without its supplier', () => {
    expect(() =>
      resolvePartitionKey('PERFORMANCE_FORMULA_VERSION_CREATED', { supplierId: SUPPLIER_ID }),
    ).toThrow();
    expect(() =>
      resolvePartitionKey('SUPPLIER_REGISTERED', { formulaVersionId: VERSION_ID }),
    ).toThrow();
  });

  it('leaves every supplier event on the supplier key', () => {
    for (const name of Object.values(SUPPLIER_EVENTS)) {
      expect(isFormulaEvent(name)).toBe(false);
    }
  });
});
