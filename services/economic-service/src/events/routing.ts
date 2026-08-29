import type { z } from 'zod';
import { ECONOMIC_EVENTS, ECONOMIC_EVENT_SCHEMAS, type EconomicEventName } from './events';

/**
 * Where each economic event goes on the wire (ADR-036).
 *
 * Two questions live in this file, and they are **not** the same question:
 *
 * - **Aggregate identity** — what is this event *about*? Answered by
 *   `AGGREGATE_OF`, written into the envelope, and used by an auditor or a
 *   read model to attribute the event to the entity that owns it.
 * - **Partition ordering** — what must this event stay *in order with*?
 *   Answered by `PARTITION_KEY_POLICY` and used as the Kafka message key.
 *
 * They agree for most events and deliberately disagree for four.
 * `FUNDS_HELD` is *about* a `WalletHold`; what it must stay ordered with is
 * the transaction the hold secures. Collapsing the two into one field is what
 * scattered a single transaction's events across four partitions and produced
 * Q-26.
 */

/** The validated shape of one event's payload. */
export type EconomicPayload<N extends EconomicEventName> = z.infer<
  (typeof ECONOMIC_EVENT_SCHEMAS)[N]
>;

/**
 * The aggregate each event is *about*.
 *
 * Typed against the event union rather than `Record<string, string>`, which is
 * what the previous version was: a missing entry there was `undefined` at
 * runtime and compiled fine.
 */
export const AGGREGATE_OF = {
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
} as const satisfies Record<EconomicEventName, string>;

/**
 * What an event is ordered by.
 *
 * `PAYMENT_INTENT` exists because two payment events genuinely have no
 * transaction: `PaymentIntent.transaction_id` is nullable and only filled at
 * capture, and a failed payment never gets one at all. They keep their own
 * aggregate key rather than being handed an invented transaction id.
 */
export const PARTITION_SCOPES = {
  TRANSACTION: 'TRANSACTION',
  WALLET: 'WALLET',
  JOURNAL: 'JOURNAL',
  PAYMENT_INTENT: 'PAYMENT_INTENT',
  REWARD: 'REWARD',
  REWARD_SUBJECT: 'REWARD_SUBJECT',
} as const;

export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

/** Reads the ordering key out of one event's own validated payload. */
type PartitionRule<N extends EconomicEventName> = (
  payload: EconomicPayload<N>,
) => PartitionDecision;

/**
 * The one place an economic event's Kafka key is decided.
 *
 * A mapped type over the event union, so adding a name to `ECONOMIC_EVENTS`
 * without deciding how it is ordered fails `pnpm typecheck` rather than
 * quietly inheriting the aggregate id. Each rule receives its own event's
 * payload type, so reading a field the event does not have does not compile
 * either.
 */
export const PARTITION_KEY_POLICY: { [N in EconomicEventName]: PartitionRule<N> } = {
  // ---- Transaction lifecycle -----------------------------------------------
  // Everything that belongs to one transaction shares one partition, so a
  // consumer rebuilding it sees hold, release, commission and settlement in
  // the order they happened (ADR-036).
  FUNDS_HELD: (payload) => ({ scope: 'TRANSACTION', key: payload.transactionId }),
  FUNDS_RELEASED: (payload) => ({ scope: 'TRANSACTION', key: payload.transactionId }),
  PAYMENT_COMPLETED: (payload) => ({ scope: 'TRANSACTION', key: payload.transactionId }),
  COMMISSION_APPLIED: (payload) => ({ scope: 'TRANSACTION', key: payload.transactionId }),
  SETTLEMENT_COMPLETED: (payload) => ({ scope: 'TRANSACTION', key: payload.transactionId }),

  /**
   * A journal that records a transaction is ordered with it; one that does
   * not is ordered by itself.
   *
   * Both branches are real today. A hold, a settlement and a top-up all post
   * a journal against a transaction. A `REWARD_GRANT` posts one against
   * nothing — `reward.service.ts` credits the wallet without a transaction,
   * because a reward is not born of a trade.
   *
   * This is a declared discriminator, not a fallback: `transactionId` is
   * `nullable` in both the Prisma model and the payload schema, so the two
   * cases are part of the contract rather than a guess about a missing value.
   */
  JOURNAL_POSTED: (payload) =>
    payload.transactionId
      ? { scope: 'TRANSACTION', key: payload.transactionId }
      : { scope: 'JOURNAL', key: payload.journalId },

  // ---- Aggregate-only lifecycles -------------------------------------------
  WALLET_OPENED: (payload) => ({ scope: 'WALLET', key: payload.walletId }),

  /**
   * No transaction exists yet.
   *
   * `PaymentIntent.transaction_id` is written at capture, and these two
   * events are published before it (authorised) or instead of it (failed, no
   * ledger movement at all). Neither payload carries a `transactionId`, and
   * giving them one would be writing a false id into a financial payload.
   */
  PAYMENT_AUTHORIZED: (payload) => ({
    scope: 'PAYMENT_INTENT',
    key: payload.paymentIntentId,
  }),
  PAYMENT_FAILED: (payload) => ({ scope: 'PAYMENT_INTENT', key: payload.paymentIntentId }),

  REWARD_GRANTED: (payload) => ({ scope: 'REWARD', key: payload.rewardId }),
  /** The subject's reward balance, which is what this event is a change to. */
  REWARD_LEVEL_CHANGED: (payload) => ({
    scope: 'REWARD_SUBJECT',
    key: `${payload.organizationId}:${payload.userId}`,
  }),
};

/**
 * Decides the partition key for one already-validated payload.
 *
 * Refuses an empty key rather than passing it on. Kafka round-robins a
 * message with no key, which is precisely the loss of ordering this policy
 * exists to prevent — and it would happen silently.
 */
export function resolvePartitionKey<N extends EconomicEventName>(
  eventName: N,
  payload: EconomicPayload<N>,
): PartitionDecision {
  // The lookup is exhaustive by construction; TypeScript cannot correlate the
  // generic parameter with the mapped type's value, hence the assertion.
  const rule = PARTITION_KEY_POLICY[eventName] as PartitionRule<N>;
  const decision = rule(payload);

  if (!decision.key) {
    throw new Error(
      `${eventName} resolved an empty ${decision.scope} partition key; ` +
        'publishing it would let Kafka round-robin the message and lose ordering',
    );
  }

  return decision;
}

/** Every event this service publishes, for exhaustive iteration in tests. */
export const ECONOMIC_EVENT_NAMES = Object.values(ECONOMIC_EVENTS);
