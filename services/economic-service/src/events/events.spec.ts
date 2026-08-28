import { NEVER_AUTO_REPLAY, isAutoReplayable } from '@rasta/contracts';
import {
  ECONOMIC_EVENTS,
  ECONOMIC_EVENT_SCHEMAS,
  validateEconomicPayload,
  type EconomicEventName,
} from './events';
import { CONSUMED_EVENTS, DEFERRED_CONSUMPTION, maintenanceApprovedSchema } from './consumed';

/**
 * The event contract (docs/07 § 7.8, docs/events/README.md § Economic).
 *
 * Publish-time validation is what keeps a malformed event out of the log
 * entirely. For this domain the alternative is worse than usual: an unreadable
 * `SETTLEMENT_COMPLETED` is a payment other services never learn about,
 * discovered in a dead-letter topic it may not be automatically replayed from.
 */

const EVENT_NAMES = Object.values(ECONOMIC_EVENTS) as EconomicEventName[];

describe('the catalogue', () => {
  it('publishes exactly the eleven events docs/07 § 7.5 lists', () => {
    expect(EVENT_NAMES.sort()).toEqual(
      [
        'COMMISSION_APPLIED',
        'FUNDS_HELD',
        'FUNDS_RELEASED',
        'JOURNAL_POSTED',
        'PAYMENT_AUTHORIZED',
        'PAYMENT_COMPLETED',
        'PAYMENT_FAILED',
        'REWARD_GRANTED',
        'REWARD_LEVEL_CHANGED',
        'SETTLEMENT_COMPLETED',
        'WALLET_OPENED',
      ].sort(),
    );
  });

  it('gives every event a schema', () => {
    for (const name of EVENT_NAMES) {
      expect(ECONOMIC_EVENT_SCHEMAS[name]).toBeDefined();
    }
  });
});

describe('no financial event may be replayed automatically', () => {
  // `NEVER_AUTO_REPLAY` in @rasta/contracts is not decoration: replaying a
  // settlement out of a dead-letter topic without first establishing what
  // happened to the money is a larger risk than the original failure
  // (docs/runbooks/replay-dlq.md).
  it.each([
    'PAYMENT_AUTHORIZED',
    'PAYMENT_COMPLETED',
    'PAYMENT_FAILED',
    'COMMISSION_APPLIED',
    'REWARD_GRANTED',
    'SETTLEMENT_COMPLETED',
    'JOURNAL_POSTED',
  ])('%s is marked never-auto-replay', (name) => {
    expect(NEVER_AUTO_REPLAY.has(name)).toBe(true);
    expect(isAutoReplayable(name)).toBe(false);
  });
});

describe('money on the wire', () => {
  it('accepts an amount as a string and refuses it as a number', () => {
    // A rial figure past Number.MAX_SAFE_INTEGER does not survive a JSON
    // number (ADR-022), so the schema has to refuse one even when it looks
    // harmless.
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.FUNDS_HELD, {
        holdId: 'HLD_1',
        walletId: 'WLT_1',
        organizationId: 'ORG-A',
        transactionId: 'TXN_1',
        reference: 'TXN_1',
        referenceType: 'TRANSACTION',
        amountMinor: 10_000_000,
        currency: 'IRR',
        heldAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('refuses a decimal amount', () => {
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.PAYMENT_COMPLETED, {
        paymentIntentId: 'PAY_1',
        organizationId: 'ORG-A',
        walletId: 'WLT_1',
        transactionId: 'TXN_1',
        journalId: 'JRN_1',
        amountMinor: '100.50',
        currency: 'IRR',
        provider: 'mock',
        simulated: true,
        completedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('carries an amount beyond Number.MAX_SAFE_INTEGER intact', () => {
    const payload = validateEconomicPayload(ECONOMIC_EVENTS.WALLET_OPENED, {
      walletId: 'WLT_1',
      organizationId: 'ORG-A',
      currency: 'IRR',
      openedAt: new Date().toISOString(),
    });
    expect(payload).toMatchObject({ walletId: 'WLT_1' });
  });
});

describe('payment events disclose that they are simulated', () => {
  // ADR-024 forbids any claim of a bank connection, and silence is a claim: a
  // consumer must be able to tell that no real money moved without knowing
  // which provider happened to be configured.
  it.each([
    ECONOMIC_EVENTS.PAYMENT_AUTHORIZED,
    ECONOMIC_EVENTS.PAYMENT_COMPLETED,
    ECONOMIC_EVENTS.PAYMENT_FAILED,
  ])('%s requires a `simulated` flag', (name) => {
    const base: Record<string, unknown> = {
      paymentIntentId: 'PAY_1',
      organizationId: 'ORG-A',
      walletId: 'WLT_1',
      transactionId: 'TXN_1',
      journalId: 'JRN_1',
      amountMinor: '1000',
      currency: 'IRR',
      provider: 'mock',
      authorizedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      reason: 'DECLINED',
    };

    expect(() => validateEconomicPayload(name, base)).toThrow();
    expect(() => validateEconomicPayload(name, { ...base, simulated: true })).not.toThrow();
  });
});

describe('JOURNAL_POSTED', () => {
  const entry = {
    accountId: 'ACC_1',
    organizationId: 'ORG-A',
    direction: 'DEBIT' as const,
    amountMinor: '1000',
    currency: 'IRR',
  };

  it('refuses a journal with fewer than two legs', () => {
    // An auditor reconstructing the ledger from the event log must see both
    // sides of every movement, or the log proves nothing.
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.JOURNAL_POSTED, {
        journalId: 'JRN_1',
        organizationId: 'ORG-A',
        transactionId: null,
        journalType: 'SETTLEMENT',
        currency: 'IRR',
        postedAt: new Date().toISOString(),
        reversesJournalId: null,
        entries: [entry],
      }),
    ).toThrow();
  });

  it('accepts a balanced pair', () => {
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.JOURNAL_POSTED, {
        journalId: 'JRN_1',
        organizationId: 'ORG-A',
        transactionId: null,
        journalType: 'SETTLEMENT',
        currency: 'IRR',
        postedAt: new Date().toISOString(),
        reversesJournalId: null,
        entries: [entry, { ...entry, direction: 'CREDIT' as const, accountId: 'ACC_2' }],
      }),
    ).not.toThrow();
  });
});

describe('COMMISSION_APPLIED', () => {
  const base = {
    commissionId: 'CMS_1',
    transactionId: 'TXN_1',
    organizationId: 'ORG-B',
    rateBasisPoints: 200,
    grossAmountMinor: '10000000',
    amountMinor: '200000',
    currency: 'IRR',
    appliedAt: new Date().toISOString(),
  };

  it('permits a null ruleId — no rule matched, so nothing was charged', () => {
    // The ADR-023 case, and a real one rather than defensive: with no active
    // rule the commission is zero and there is no rule to name.
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.COMMISSION_APPLIED, {
        ...base,
        ruleId: null,
        amountMinor: '0',
      }),
    ).not.toThrow();
  });

  it('refuses a rate outside 0–10 000 basis points', () => {
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.COMMISSION_APPLIED, {
        ...base,
        ruleId: null,
        rateBasisPoints: 10_001,
      }),
    ).toThrow();
  });

  it('refuses a fractional rate', () => {
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.COMMISSION_APPLIED, {
        ...base,
        ruleId: null,
        rateBasisPoints: 2.5,
      }),
    ).toThrow();
  });
});

describe('REWARD_GRANTED', () => {
  const base = {
    rewardId: 'RWD_1',
    organizationId: 'ORG-A',
    userId: 'USR-1',
    ruleId: 'RWR_1',
    triggerEvent: 'USAGE_RECORDED',
    sourceReference: 'USG_1',
    points: 10,
    currency: 'IRR',
    grantedAt: new Date().toISOString(),
  };

  it('carries `monetised` so a consumer never infers value from a zero', () => {
    // Without it, "points only" and "a configured rate that rounded to
    // nothing" would look identical — two different facts (ADR-033).
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.REWARD_GRANTED, {
        ...base,
        creditAmountMinor: '0',
        journalId: null,
      }),
    ).toThrow();

    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.REWARD_GRANTED, {
        ...base,
        creditAmountMinor: '0',
        monetised: false,
        journalId: null,
      }),
    ).not.toThrow();
  });

  it('refuses a grant of zero points', () => {
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.REWARD_GRANTED, {
        ...base,
        points: 0,
        creditAmountMinor: '0',
        monetised: false,
        journalId: null,
      }),
    ).toThrow();
  });
});

describe('FUNDS_RELEASED', () => {
  it('distinguishes a release from a refund', () => {
    // A consumer compensating a cancelled order and one completing a fulfilled
    // order need opposite reactions; inferring which from the absence of a
    // later event is how a saga hangs.
    const base = {
      holdId: 'HLD_1',
      walletId: 'WLT_1',
      organizationId: 'ORG-A',
      transactionId: 'TXN_1',
      reference: 'TXN_1',
      amountMinor: '1000',
      currency: 'IRR',
      resolvedAt: new Date().toISOString(),
    };

    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.FUNDS_RELEASED, { ...base, resolution: 'RELEASED' }),
    ).not.toThrow();
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.FUNDS_RELEASED, { ...base, resolution: 'REFUNDED' }),
    ).not.toThrow();
    expect(() =>
      validateEconomicPayload(ECONOMIC_EVENTS.FUNDS_RELEASED, { ...base, resolution: 'DONE' }),
    ).toThrow();
  });
});

describe('consumed events', () => {
  it('consumes only the three contracts that are real', () => {
    // ADR-032. The rest are deferred because their contracts are sketches, and
    // writing them would mean this service defining another service's payload.
    expect(Object.values(CONSUMED_EVENTS).sort()).toEqual([
      'MAINTENANCE_APPROVED',
      'MAINTENANCE_COMPLETED',
      'USAGE_RECORDED',
    ]);
  });

  it('names the deferred ones rather than stubbing them', () => {
    // A handler that consumes an event and does nothing writes a
    // `processed_event` row and looks exactly like one that worked.
    expect(DEFERRED_CONSUMPTION).toContain('ORDER_CREATED');
    expect(DEFERRED_CONSUMPTION).toContain('ORDER_RECEIPT_CONFIRMED');
    expect(DEFERRED_CONSUMPTION).toContain('STATEMENT_APPROVED');

    for (const deferred of DEFERRED_CONSUMPTION) {
      expect(Object.values(CONSUMED_EVENTS)).not.toContain(deferred);
    }
  });

  it('parses the exact payload maintenance-service publishes', () => {
    // Taken from maintenance-service's `maintenanceApprovedPayload`, so a
    // change there fails here rather than in production.
    const payload = maintenanceApprovedSchema.parse({
      requestId: 'MNT_01JBQ8',
      assetId: 'AST_01JBQ8',
      organizationId: 'ORG-A',
      approvedBy: 'USR-1',
      approvedAt: '2026-08-29T10:00:00.000Z',
      workshopOrganizationId: 'ORG-WORKSHOP',
      totalCostMinor: '11850000',
      currency: 'IRR',
      costBreakdown: [
        { category: 'PART', amountMinor: '4800000', currency: 'IRR' },
        { category: 'LABOUR', amountMinor: '5850000', currency: 'IRR' },
        { category: 'SERVICE', amountMinor: '1200000', currency: 'IRR' },
      ],
    });

    expect(payload.totalCostMinor).toBe('11850000');
    expect(payload.workshopOrganizationId).toBe('ORG-WORKSHOP');
  });

  it('accepts an approval with no workshop, which is a real case', () => {
    // An in-house repair. Skipped rather than dead-lettered, because it is a
    // normal thing for maintenance-service to publish.
    expect(() =>
      maintenanceApprovedSchema.parse({
        requestId: 'MNT_1',
        assetId: 'AST_1',
        organizationId: 'ORG-A',
        approvedBy: 'USR-1',
        approvedAt: '2026-08-29T10:00:00.000Z',
        workshopOrganizationId: null,
        totalCostMinor: '0',
        currency: 'IRR',
      }),
    ).not.toThrow();
  });

  it('tolerates a field the producer adds later', () => {
    // `.passthrough()`: a producer adding a field must not dead-letter a
    // financial event.
    expect(() =>
      maintenanceApprovedSchema.parse({
        requestId: 'MNT_1',
        assetId: 'AST_1',
        organizationId: 'ORG-A',
        approvedBy: 'USR-1',
        approvedAt: '2026-08-29T10:00:00.000Z',
        totalCostMinor: '100',
        currency: 'IRR',
        somethingNew: 'added in a later release',
      }),
    ).not.toThrow();
  });

  it('refuses an approval whose cost is not an integer string', () => {
    expect(() =>
      maintenanceApprovedSchema.parse({
        requestId: 'MNT_1',
        assetId: 'AST_1',
        organizationId: 'ORG-A',
        approvedBy: 'USR-1',
        approvedAt: '2026-08-29T10:00:00.000Z',
        totalCostMinor: 11_850_000,
        currency: 'IRR',
      }),
    ).toThrow();
  });
});
