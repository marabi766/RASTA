import { ECONOMIC_EVENTS, type EconomicEventName } from './events';
import {
  AGGREGATE_OF,
  PARTITION_KEY_POLICY,
  resolvePartitionKey,
  type PartitionScope,
} from './routing';

/**
 * The partition-key policy (ADR-036).
 *
 * The table below is the specification, not an illustration of it: every event
 * this service publishes appears exactly once, with the scope it belongs to
 * and the payload field its key is read from. A new event added without a row
 * here fails the exhaustiveness test at the bottom.
 */

const TXN = 'TXN_ORDER_1';
const OTHER_TXN = 'TXN_ORDER_2';
const WALLET = 'WLT_A';
const JOURNAL = 'JRN_1';
const INTENT = 'PAY_1';
const ORG = 'ORG-A';

/** Payloads that satisfy each schema, so the policy runs on real shapes. */
const PAYLOADS = {
  WALLET_OPENED: {
    walletId: WALLET,
    organizationId: ORG,
    currency: 'IRR',
    openedAt: '2026-08-29T00:00:00.000Z',
  },
  FUNDS_HELD: {
    holdId: 'HLD_1',
    walletId: WALLET,
    organizationId: ORG,
    transactionId: TXN,
    reference: TXN,
    referenceType: 'TRANSACTION',
    amountMinor: '1000',
    currency: 'IRR',
    heldAt: '2026-08-29T00:00:01.000Z',
  },
  FUNDS_RELEASED: {
    holdId: 'HLD_1',
    walletId: WALLET,
    organizationId: ORG,
    transactionId: TXN,
    reference: TXN,
    amountMinor: '1000',
    currency: 'IRR',
    resolution: 'RELEASED' as const,
    resolvedAt: '2026-08-29T00:00:05.000Z',
  },
  PAYMENT_AUTHORIZED: {
    paymentIntentId: INTENT,
    organizationId: ORG,
    walletId: WALLET,
    amountMinor: '5000',
    currency: 'IRR',
    provider: 'mock',
    simulated: true,
    authorizedAt: '2026-08-29T00:00:00.000Z',
  },
  PAYMENT_COMPLETED: {
    paymentIntentId: INTENT,
    organizationId: ORG,
    walletId: WALLET,
    transactionId: TXN,
    journalId: JOURNAL,
    amountMinor: '5000',
    currency: 'IRR',
    provider: 'mock',
    simulated: true,
    completedAt: '2026-08-29T00:00:02.000Z',
  },
  PAYMENT_FAILED: {
    paymentIntentId: INTENT,
    organizationId: ORG,
    amountMinor: '5000',
    currency: 'IRR',
    provider: 'mock',
    simulated: true,
    reason: 'PROVIDER_DECLINED',
    failedAt: '2026-08-29T00:00:02.000Z',
  },
  COMMISSION_APPLIED: {
    commissionId: 'CMS_1',
    transactionId: TXN,
    organizationId: ORG,
    ruleId: 'CRL_1',
    rateBasisPoints: 250,
    grossAmountMinor: '1000',
    amountMinor: '25',
    currency: 'IRR',
    appliedAt: '2026-08-29T00:00:06.000Z',
  },
  REWARD_GRANTED: {
    rewardId: 'RWD_1',
    organizationId: ORG,
    userId: 'USR-1',
    ruleId: 'RRL_1',
    triggerEvent: 'SETTLEMENT_COMPLETED',
    sourceReference: TXN,
    points: 10,
    creditAmountMinor: '0',
    currency: 'IRR',
    monetised: false,
    journalId: null,
    grantedAt: '2026-08-29T00:00:07.000Z',
  },
  REWARD_LEVEL_CHANGED: {
    organizationId: ORG,
    userId: 'USR-1',
    from: null,
    to: 'BRONZE',
    totalPoints: 10,
    changedAt: '2026-08-29T00:00:08.000Z',
  },
  SETTLEMENT_COMPLETED: {
    settlementId: 'STL_1',
    transactionId: TXN,
    organizationId: ORG,
    payerOrganizationId: ORG,
    payeeOrganizationId: 'ORG-B',
    journalId: JOURNAL,
    grossAmountMinor: '1000',
    commissionAmountMinor: '25',
    netAmountMinor: '975',
    currency: 'IRR',
    settledAt: '2026-08-29T00:00:05.000Z',
  },
  JOURNAL_POSTED: {
    journalId: JOURNAL,
    organizationId: ORG,
    transactionId: TXN,
    journalType: 'FUNDS_HELD',
    currency: 'IRR',
    postedAt: '2026-08-29T00:00:01.000Z',
    reversesJournalId: null,
    entries: [
      {
        accountId: 'ACC_1',
        organizationId: ORG,
        direction: 'DEBIT' as const,
        amountMinor: '1000',
        currency: 'IRR',
      },
      {
        accountId: 'ACC_2',
        organizationId: ORG,
        direction: 'CREDIT' as const,
        amountMinor: '1000',
        currency: 'IRR',
      },
    ],
  },
} satisfies { [N in EconomicEventName]: Parameters<(typeof PARTITION_KEY_POLICY)[N]>[0] };

/** The specification, one row per published event. */
const EXPECTED: { [N in EconomicEventName]: { scope: PartitionScope; key: string } } = {
  WALLET_OPENED: { scope: 'WALLET', key: WALLET },
  FUNDS_HELD: { scope: 'TRANSACTION', key: TXN },
  FUNDS_RELEASED: { scope: 'TRANSACTION', key: TXN },
  PAYMENT_AUTHORIZED: { scope: 'PAYMENT_INTENT', key: INTENT },
  PAYMENT_COMPLETED: { scope: 'TRANSACTION', key: TXN },
  PAYMENT_FAILED: { scope: 'PAYMENT_INTENT', key: INTENT },
  COMMISSION_APPLIED: { scope: 'TRANSACTION', key: TXN },
  REWARD_GRANTED: { scope: 'REWARD', key: 'RWD_1' },
  REWARD_LEVEL_CHANGED: { scope: 'REWARD_SUBJECT', key: `${ORG}:USR-1` },
  SETTLEMENT_COMPLETED: { scope: 'TRANSACTION', key: TXN },
  JOURNAL_POSTED: { scope: 'TRANSACTION', key: TXN },
};

const NAMES = Object.values(ECONOMIC_EVENTS);

/** Resolves through the same entry point production uses. */
function resolve<N extends EconomicEventName>(name: N) {
  return resolvePartitionKey(name, PAYLOADS[name]);
}

describe('every published economic event has a partition decision', () => {
  it.each(NAMES)('%s resolves the scope and key ADR-036 specifies', (name) => {
    expect(resolve(name)).toEqual(EXPECTED[name]);
  });

  it('covers exactly the eleven events the catalogue publishes', () => {
    // Guards the table above against drift in both directions: an event added
    // to the catalogue without a row here, and a row left behind for an event
    // that no longer exists.
    expect(Object.keys(EXPECTED).sort()).toEqual([...NAMES].sort());
    expect(Object.keys(PARTITION_KEY_POLICY).sort()).toEqual([...NAMES].sort());
    expect(NAMES).toHaveLength(11);
  });
});

describe('a transaction is one ordered stream', () => {
  it('gives every transaction-lifecycle event of one transaction the same key', () => {
    // The invariant Q-26 asked for. Without it these five sit on up to four
    // partitions and a consumer can see the settlement before the hold.
    const lifecycle = [
      'FUNDS_HELD',
      'FUNDS_RELEASED',
      'PAYMENT_COMPLETED',
      'COMMISSION_APPLIED',
      'SETTLEMENT_COMPLETED',
      'JOURNAL_POSTED',
    ] as const;

    const keys = new Set(lifecycle.map((name) => resolve(name).key));

    expect(keys).toEqual(new Set([TXN]));
  });

  it('lets two transactions partition independently', () => {
    // Ordering is per transaction, not global: nothing here forces unrelated
    // transactions onto one partition, which would serialise the whole domain.
    const first = resolvePartitionKey('FUNDS_HELD', PAYLOADS.FUNDS_HELD);
    const second = resolvePartitionKey('FUNDS_HELD', {
      ...PAYLOADS.FUNDS_HELD,
      transactionId: OTHER_TXN,
    });

    expect(first.key).not.toBe(second.key);
    expect(second.key).toBe(OTHER_TXN);
  });

  it('keys a hold by its transaction even though the event is about the hold', () => {
    // Aggregate identity and partition ordering are different questions, and
    // this is the case where they visibly disagree.
    expect(AGGREGATE_OF.FUNDS_HELD).toBe('WalletHold');
    expect(resolve('FUNDS_HELD').key).toBe(TXN);
    expect(resolve('FUNDS_HELD').key).not.toBe(PAYLOADS.FUNDS_HELD.holdId);
  });
});

describe('aggregate-only lifecycles keep their own key', () => {
  it('keys a wallet event by the wallet', () => {
    expect(resolve('WALLET_OPENED')).toEqual({ scope: 'WALLET', key: WALLET });
  });

  it('keys a journal with no transaction by the journal', () => {
    // A `REWARD_GRANT` journal is the real case: rewards are credited without
    // a transaction, so there is nothing to be ordered with.
    const decision = resolvePartitionKey('JOURNAL_POSTED', {
      ...PAYLOADS.JOURNAL_POSTED,
      journalType: 'REWARD_GRANT',
      transactionId: null,
    });

    expect(decision).toEqual({ scope: 'JOURNAL', key: JOURNAL });
  });

  it('keys a reward by the reward', () => {
    expect(resolve('REWARD_GRANTED')).toEqual({ scope: 'REWARD', key: 'RWD_1' });
  });

  it('keys a level change by the subject whose balance moved', () => {
    // Not by the reward: a level change is a fact about the person's running
    // balance, and consecutive changes for one subject must stay in order.
    expect(resolve('REWARD_LEVEL_CHANGED')).toEqual({
      scope: 'REWARD_SUBJECT',
      key: `${ORG}:USR-1`,
    });
  });
});

describe('no transaction id is invented', () => {
  it('keys an authorised payment by its intent, because no transaction exists yet', () => {
    // `PaymentIntent.transaction_id` is written at capture. At authorisation
    // there is nothing to point at, and pointing anyway would put a false id
    // in a financial payload.
    expect(resolve('PAYMENT_AUTHORIZED')).toEqual({ scope: 'PAYMENT_INTENT', key: INTENT });
    expect(PAYLOADS.PAYMENT_AUTHORIZED).not.toHaveProperty('transactionId');
  });

  it('keys a failed payment by its intent, because it will never have a transaction', () => {
    expect(resolve('PAYMENT_FAILED')).toEqual({ scope: 'PAYMENT_INTENT', key: INTENT });
    expect(PAYLOADS.PAYMENT_FAILED).not.toHaveProperty('transactionId');
  });

  it('does not silently reuse the intent id as a transaction key', () => {
    // The two payment phases genuinely land on different partitions, which is
    // the documented cost of ADR-036 rather than an oversight. Asserted so
    // that a later "tidy-up" cannot quietly change it without failing here.
    expect(resolve('PAYMENT_AUTHORIZED').scope).not.toBe('TRANSACTION');
    expect(resolve('PAYMENT_COMPLETED').scope).toBe('TRANSACTION');
    expect(resolve('PAYMENT_AUTHORIZED').key).not.toBe(resolve('PAYMENT_COMPLETED').key);
  });
});

describe('the policy refuses to publish an unkeyed message', () => {
  it('throws rather than letting Kafka round-robin the event', () => {
    // An empty key is not a smaller problem than a wrong one: Kafka spreads a
    // keyless message across partitions, which loses exactly the ordering
    // this policy exists to create — and does it silently.
    expect(() =>
      resolvePartitionKey('FUNDS_HELD', { ...PAYLOADS.FUNDS_HELD, transactionId: '' }),
    ).toThrow(/empty TRANSACTION partition key/);
  });

  it('names the event so an operator can find it', () => {
    expect(() =>
      resolvePartitionKey('WALLET_OPENED', { ...PAYLOADS.WALLET_OPENED, walletId: '' }),
    ).toThrow(/^WALLET_OPENED /);
  });
});

describe('aggregate identity is untouched by this change', () => {
  it('still names the entity each event is about', () => {
    // ADR-036 changes what events are ordered by, not what they are about. An
    // auditor attributing an event to its owning entity reads `aggregateType`
    // and `aggregateId`, and those are exactly as they were.
    expect(AGGREGATE_OF).toEqual({
      WALLET_OPENED: 'Wallet',
      FUNDS_HELD: 'WalletHold',
      FUNDS_RELEASED: 'WalletHold',
      PAYMENT_AUTHORIZED: 'PaymentIntent',
      PAYMENT_COMPLETED: 'PaymentIntent',
      PAYMENT_FAILED: 'PaymentIntent',
      COMMISSION_APPLIED: 'Commission',
      REWARD_GRANTED: 'Reward',
      REWARD_LEVEL_CHANGED: 'RewardBalance',
      SETTLEMENT_COMPLETED: 'Settlement',
      JOURNAL_POSTED: 'Journal',
    });
  });

  it('gives every event an aggregate type', () => {
    for (const name of NAMES) {
      expect(AGGREGATE_OF[name]).toBeTruthy();
    }
  });
});
