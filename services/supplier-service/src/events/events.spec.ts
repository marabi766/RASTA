import {
  PERFORMANCE_FORMULA_EVENTS,
  SUPPLIER_EVENT_SCHEMAS,
  SUPPLIER_EVENTS,
  validateSupplierPayload,
  type SupplierEventName,
} from './events';

/**
 * The event contract, asserted at the shape the platform catalogue publishes.
 *
 * `docs/07` § 7.8 requires validation at publish time as well as at consume
 * time, so these assertions exercise the same `validateSupplierPayload` the
 * publisher calls rather than a copy of the schemas.
 */

const REGISTERED = {
  supplierId: 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
  displayName: 'A supplier',
  capabilities: ['GOODS_SUPPLY'],
  registeredBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y4',
  registeredAt: '2026-09-05T10:15:30.123Z',
};

const QUALIFIED = {
  supplierId: 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
  qualificationId: 'QLF_01JBQ8Z4K7M2N5P8R1T3V6X9Y5',
  qualifiedFor: ['WORKSHOP_SERVICE'],
  decidedBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y6',
  decidedAt: '2026-09-05T11:00:00.000Z',
};

const REJECTED = {
  supplierId: 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
  qualificationId: 'QLF_01JBQ8Z4K7M2N5P8R1T3V6X9Y5',
  rejectedFor: ['CONTRACTING'],
  reason: 'The submission named no capability evidence',
  decidedBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y6',
  decidedAt: '2026-09-05T11:00:00.000Z',
};

const SUSPENDED = {
  supplierId: 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
  suspensionId: 'SSP_01JBQ8Z4K7M2N5P8R1T3V6X9Y7',
  reason: 'Repeated undelivered orders reported by two buyers',
  until: null,
  suspendedBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y6',
  suspendedAt: '2026-09-05T12:00:00.000Z',
};

const REINSTATED = {
  supplierId: 'SUP_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
  suspensionId: 'SSP_01JBQ8Z4K7M2N5P8R1T3V6X9Y7',
  reason: 'The orders were delivered late, not never',
  reinstatedBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y6',
  reinstatedAt: '2026-09-06T09:00:00.000Z',
};

const VALID: Record<SupplierEventName, Record<string, unknown>> = {
  SUPPLIER_REGISTERED: REGISTERED,
  SUPPLIER_QUALIFIED: QUALIFIED,
  SUPPLIER_REJECTED: REJECTED,
  SUPPLIER_SUSPENDED: SUSPENDED,
  SUPPLIER_REINSTATED: REINSTATED,
};

describe('the published event set', () => {
  it('publishes exactly the five events this phase is scoped to', () => {
    // SUPPLIER_REINSTATED was added by the global audit's L7-14: the lifting
    // of a suspension is a state change and is audited (AGENTS.md S-06).
    expect(Object.keys(SUPPLIER_EVENTS).sort()).toEqual([
      'SUPPLIER_QUALIFIED',
      'SUPPLIER_REGISTERED',
      'SUPPLIER_REINSTATED',
      'SUPPLIER_REJECTED',
      'SUPPLIER_SUSPENDED',
    ]);
  });

  it('carries the closed episode, the stated reason and the operator on SUPPLIER_REINSTATED', () => {
    expect(validateSupplierPayload('SUPPLIER_REINSTATED', REINSTATED)).toEqual(REINSTATED);
    // Nothing about qualifications — reinstating decides nothing about them —
    // and nothing unlisted.
    expect(() =>
      validateSupplierPayload('SUPPLIER_REINSTATED', {
        ...REINSTATED,
        qualifiedFor: ['GOODS_SUPPLY'],
      }),
    ).toThrow(/SUPPLIER_REINSTATED/);
  });

  it('does not publish PERFORMANCE_SCORE_UPDATED', () => {
    // The catalogue lists it; there is no formula. Q-12 — the weights — is
    // open, and marketplace ranks on price and delivery time precisely because
    // no score exists (ADR-042). A fabricated number would silently become the
    // platform's ranking authority and be indistinguishable from a real one.
    expect(Object.keys(SUPPLIER_EVENT_SCHEMAS)).not.toContain('PERFORMANCE_SCORE_UPDATED');
  });

  it('has a schema for every declared event name', () => {
    for (const name of Object.values(SUPPLIER_EVENTS)) {
      expect(SUPPLIER_EVENT_SCHEMAS[name]).toBeDefined();
    }
  });
});

describe('valid payloads', () => {
  it.each(Object.keys(VALID) as SupplierEventName[])('%s accepts its documented shape', (name) => {
    expect(() => validateSupplierPayload(name, VALID[name])).not.toThrow();
  });
});

describe('unknown fields are refused, not dropped', () => {
  it.each(Object.keys(VALID) as SupplierEventName[])('%s rejects an extra field', (name) => {
    // `.strict()` everywhere. A misspelled field that is silently dropped
    // produces an event that validates and means something else.
    expect(() => validateSupplierPayload(name, { ...VALID[name], extra: 'x' })).toThrow(
      /does not match its published contract/,
    );
  });
});

describe('what a payload may never carry', () => {
  it('refuses an evidence document identifier on a qualification event', () => {
    // An event lives seven days in a log every service can read. A document id
    // there would let any consumer holding document-service credentials try to
    // fetch a supplier's private licence, bypassing this service entirely.
    expect(() =>
      validateSupplierPayload('SUPPLIER_QUALIFIED', {
        ...QUALIFIED,
        evidenceDocumentIds: ['DOC_1'],
      }),
    ).toThrow();
  });

  it("refuses the reviewer's private decision note on a rejection", () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_REJECTED', { ...REJECTED, decisionNote: 'internal' }),
    ).toThrow();
  });

  it('refuses a score or rating on any event', () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_QUALIFIED', { ...QUALIFIED, score: 87 }),
    ).toThrow();
    expect(() =>
      validateSupplierPayload('SUPPLIER_REGISTERED', { ...REGISTERED, rating: 4.5 }),
    ).toThrow();
  });
});

describe('SUPPLIER_REGISTERED', () => {
  it('names claimed capabilities, never a qualification', () => {
    const parsed = validateSupplierPayload('SUPPLIER_REGISTERED', REGISTERED);

    expect(parsed).toHaveProperty('capabilities');
    expect(parsed).not.toHaveProperty('qualifiedFor');
  });

  it('refuses a profile that claims nothing', () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_REGISTERED', { ...REGISTERED, capabilities: [] }),
    ).toThrow();
  });

  it('refuses a capability outside the bounded vocabulary', () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_REGISTERED', { ...REGISTERED, capabilities: ['HAULAGE'] }),
    ).toThrow();
  });
});

describe('SUPPLIER_SUSPENDED', () => {
  it('carries `until` as null — no end date, not a missing field', () => {
    // The catalogue names the field, and null is a meaningful answer: the
    // suspension runs until somebody explicitly reinstates. A consumer must be
    // able to tell "no end date" from "this producer does not tell you".
    const parsed = validateSupplierPayload('SUPPLIER_SUSPENDED', SUSPENDED);

    expect(parsed.until).toBeNull();
  });

  it('refuses an `until` date, because no rule defines a timed suspension', () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_SUSPENDED', {
        ...SUSPENDED,
        until: '2026-10-05T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('refuses a suspension with no stated reason', () => {
    expect(() =>
      validateSupplierPayload('SUPPLIER_SUSPENDED', { ...SUSPENDED, reason: '' }),
    ).toThrow();
  });
});

describe('every mutation names its actor', () => {
  it.each([
    ['SUPPLIER_REGISTERED', 'registeredBy'],
    ['SUPPLIER_QUALIFIED', 'decidedBy'],
    ['SUPPLIER_REJECTED', 'decidedBy'],
    ['SUPPLIER_SUSPENDED', 'suspendedBy'],
  ] as const)('%s refuses a payload with no %s', (name, field) => {
    const { [field]: _omitted, ...withoutActor } = VALID[name] as Record<string, unknown>;

    expect(() => validateSupplierPayload(name, withoutActor)).toThrow();
  });
});

describe('the performance formula audit events (ADR-052 step 2)', () => {
  const CREATED = {
    formulaVersionId: 'PFV_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    formulaVersion: 1,
    windowDays: 180,
    minSampleCount: 5,
    minCoverageBp: 5000,
    ratingMapping: { scaleMin: 1, scaleMax: 5, minScoreCentis: 0, maxScoreCentis: 10_000 },
    weights: [
      { component: 'CANCELLATION_ABSENCE', weightBp: 1000 },
      { component: 'CUSTOMER_SATISFACTION', weightBp: 2000 },
      { component: 'DISPUTE_ABSENCE', weightBp: 1500 },
      { component: 'ON_TIME', weightBp: 2500 },
      { component: 'QUALITY', weightBp: 3000 },
    ],
    createdBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y4',
    createdAt: '2026-09-26T10:00:00.000Z',
  };
  const ACTIVATED = {
    formulaVersionId: 'PFV_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    formulaVersion: 1,
    supersededFormulaVersionId: null,
    activatedBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y4',
    activatedAt: '2026-09-26T10:05:00.000Z',
  };
  const RETIRED = {
    formulaVersionId: 'PFV_01JBQ8Z4K7M2N5P8R1T3V6X9Y1',
    formulaVersion: 1,
    successorFormulaVersionId: 'PFV_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    retiredBy: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y4',
    retiredAt: '2026-09-26T10:05:00.000Z',
  };

  it('declares exactly the three formula events, beside the five supplier events', () => {
    expect(Object.keys(PERFORMANCE_FORMULA_EVENTS).sort()).toEqual([
      'PERFORMANCE_FORMULA_VERSION_ACTIVATED',
      'PERFORMANCE_FORMULA_VERSION_CREATED',
      'PERFORMANCE_FORMULA_VERSION_RETIRED',
    ]);
    for (const name of Object.values(PERFORMANCE_FORMULA_EVENTS)) {
      expect(SUPPLIER_EVENT_SCHEMAS[name]).toBeDefined();
    }
  });

  it.each([
    ['PERFORMANCE_FORMULA_VERSION_CREATED', CREATED],
    ['PERFORMANCE_FORMULA_VERSION_ACTIVATED', ACTIVATED],
    ['PERFORMANCE_FORMULA_VERSION_RETIRED', RETIRED],
  ] as const)('accepts a valid %s', (name, payload) => {
    expect(validateSupplierPayload(name, payload)).toEqual(payload);
  });

  it.each([
    ['PERFORMANCE_FORMULA_VERSION_CREATED', CREATED, 'createdBy'],
    ['PERFORMANCE_FORMULA_VERSION_ACTIVATED', ACTIVATED, 'activatedBy'],
    ['PERFORMANCE_FORMULA_VERSION_RETIRED', RETIRED, 'retiredBy'],
  ] as const)('%s names its actor', (name, payload, field) => {
    const { [field]: _omitted, ...withoutActor } = payload as Record<string, unknown>;

    expect(() => validateSupplierPayload(name, withoutActor)).toThrow();
  });

  it('refuses a fractional weight — no float in the formula', () => {
    const weights = [{ component: 'QUALITY', weightBp: 9999.5 }];

    expect(() =>
      validateSupplierPayload('PERFORMANCE_FORMULA_VERSION_CREATED', { ...CREATED, weights }),
    ).toThrow();
  });

  it('refuses a component ADR-052 did not accept', () => {
    const weights = [{ component: 'PRICE', weightBp: 10_000 }];

    expect(() =>
      validateSupplierPayload('PERFORMANCE_FORMULA_VERSION_CREATED', { ...CREATED, weights }),
    ).toThrow();
  });

  it('refuses a retirement that names no successor — there is no standalone retire', () => {
    const { successorFormulaVersionId: _omitted, ...standalone } = RETIRED;

    expect(() =>
      validateSupplierPayload('PERFORMANCE_FORMULA_VERSION_RETIRED', standalone),
    ).toThrow();
  });

  it('carries no score', () => {
    expect(() =>
      validateSupplierPayload('PERFORMANCE_FORMULA_VERSION_ACTIVATED', { ...ACTIVATED, score: 1 }),
    ).toThrow();
  });
});
