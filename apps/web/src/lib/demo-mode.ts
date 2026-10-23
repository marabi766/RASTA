import type { OrderCommand } from './order-fields';
import type { StatementCommand } from './statement-fields';

/**
 * What a screen that shows or moves money knows about the payment provider
 * (Q-14), in three states rather than a yes/no.
 *
 * - `SIMULATED` — the provider says it moves no real money: «حالت نمایشی».
 * - `REAL` — the provider says it does: no label.
 * - `UNKNOWN` — it could not be asked, or its answer could not be read. Not a
 *   "no": the screen says it does not know, and withholds what moves money
 *   (`mayOffer`), as the wallet withholds its top-up form.
 */
export type DemoMode = 'SIMULATED' | 'REAL' | 'UNKNOWN';

/**
 * What an action does with money, by what the service behind it actually does
 * — not by how financial it sounds.
 *
 * - `NONE` — records a decision or a fact. No hold is created, released or
 *   captured, nothing settles and nothing is refunded, whatever comes of it
 *   later by another, separate act.
 * - `HOLD` — holds the buyer's money in escrow.
 * - `SETTLEMENT` — starts the release of escrow to the seller.
 * - `REFUND` — starts the return of escrow to the buyer.
 * - `SETTLEMENT_OR_REFUND` — one or the other, by the choice made in the form.
 * - `REWARD_CREDIT` — the fact it records is a reward trigger: economic-service
 *   grants by itself whatever reward rule applies, and a monetised one credits
 *   the organization's wallet. No rule, no money — but the portal cannot see
 *   the rules, so it counts the credit as possible.
 * - `DEPOSIT` — takes money into the wallet through the provider.
 */
export type MoneyEffect =
  'NONE' | 'HOLD' | 'SETTLEMENT' | 'REFUND' | 'SETTLEMENT_OR_REFUND' | 'REWARD_CREDIT' | 'DEPOSIT';

interface MoneyEffects {
  readonly order: Readonly<Record<OrderCommand, MoneyEffect>>;
  readonly placeOrder: MoneyEffect;
  readonly statement: Readonly<Record<StatementCommand, MoneyEffect>>;
  readonly maintenanceApproval: MoneyEffect;
  readonly repairCompletion: MoneyEffect;
  readonly usageRecord: MoneyEffect;
  readonly walletTopUp: MoneyEffect;
}

/**
 * Every action a money screen offers, classified once (Q-14): while the
 * provider is `UNKNOWN`, `mayOffer` withholds exactly the ones that are not
 * `NONE`, and nothing else — a disclosure outage must not stop work that moves
 * no money. Each entry names the service method whose effect it records.
 *
 * The same entry decides twice: when the page draws the form, and again when
 * the form comes back, in its server action just before the command is sent
 * (`mayDispatch`, `server/money-gate.ts`) — a form drawn while the provider was
 * known is not a licence to move money once it is not (review of PR 361 r4).
 *
 * Every event an economic-service consumer acts on is here, by the command
 * that publishes it (review of PR 361 r3): `MAINTENANCE_APPROVED`
 * (`maintenanceApproval`), `STATEMENT_APPROVED` (`statement.APPROVE`),
 * `MAINTENANCE_COMPLETED` (`repairCompletion`) and `USAGE_RECORDED`
 * (`usageRecord`) — `CONSUMED_EVENTS`, economic-service `events/consumed.ts`.
 *
 * The wallet's top-up (`walletTopUp`) is drawn by the wallet's own provider
 * read, whose sentence it needs, rather than by this entry; its action asks
 * that same read again before it sends.
 */
export const MONEY_EFFECTS: MoneyEffects = {
  order: {
    // marketplace-service `OrderService.confirm`: FUNDS_HELD → CONFIRMED, the
    // supplier's acceptance. The hold placed with the order stays where it is;
    // `orderSaga` (temporal/workflows.ts) only waits on.
    CONFIRM: 'NONE',
    // `OrderService.fulfill`: → AWAITING_RECEIPT_CONFIRMATION, delivery
    // recorded. "Nothing here releases money" (ADR-038 § 2); the saga waits
    // for the buyer.
    FULFILL: 'NONE',
    // `OrderService.confirmReceipt`: → RECEIPT_CONFIRMED, "the only fact that
    // permits settlement" — the saga goes straight on to economic-service's
    // authorise-settlement and settle (`settleOrder`), releasing escrow.
    CONFIRM_RECEIPT: 'SETTLEMENT',
    // `OrderService.raiseDispute`: → DISPUTED; the saga mirrors it with
    // economic-service `TransactionService.dispute`, a status change with no
    // journal. It stops settlement — stopping money is not moving it, and a
    // buyer must keep this door while the provider is unknown.
    RAISE_DISPUTE: 'NONE',
    // `OrderService.resolveDispute`: SETTLE → RECEIPT_CONFIRMED (the saga
    // settles), REFUND → CANCELLING (the saga refunds).
    RESOLVE_DISPUTE: 'SETTLEMENT_OR_REFUND',
    // `OrderService.cancel`: → CANCELLING; the saga `compensate`s with
    // economic-service `TransactionService.refund`, which returns the escrow.
    CANCEL: 'REFUND',
    // `OrderService.submitReview`: a review row on a COMPLETED order.
    REVIEW: 'NONE',
  },
  // `OrderService.place`, then the saga's first step `placeHold`: the
  // obligation and the escrow hold on the buyer's wallet, in one call.
  placeOrder: 'HOLD',
  statement: {
    // contract-service statement commands. Drafting, submitting and rejecting
    // stay within contract-service.
    DRAFT: 'NONE',
    SUBMIT: 'NONE',
    REJECT: 'NONE',
    // The last approval publishes STATEMENT_APPROVED; economic-service
    // `StatementSettlementConsumer` records a PENDING_SETTLEMENT obligation —
    // "no hold, no journal, no balance change" (ADR-068 § 6). Settling it is
    // `POST /v1/settlements`, a separate act this portal never offers.
    APPROVE: 'NONE',
  },
  // maintenance-service `RequestService.approve` publishes MAINTENANCE_APPROVED;
  // economic-service `SettlementAuthorityConsumer` records a
  // PENDING_SETTLEMENT obligation and "moves no money" (ADR-032), settled by
  // the same separate `POST /v1/settlements`.
  maintenanceApproval: 'NONE',
  // maintenance-service `RepairOrderService.complete` publishes
  // MAINTENANCE_COMPLETED; economic-service `RewardTriggerConsumer` confirms it
  // with its owner and grants every applicable reward rule, unasked
  // (`RewardService.grantFor`): a monetised one (`creditPerPointMinor`) credits
  // the wallet with a REWARD_GRANT journal. Withheld whatever the rules are —
  // reading them to offer it anyway would be a second read that can fail too.
  repairCompletion: 'REWARD_CREDIT',
  // fleet-service `UsageService.record` publishes USAGE_RECORDED, the other
  // reward trigger of the same consumer, with the same credit.
  usageRecord: 'REWARD_CREDIT',
  // economic-service `PaymentService.topUp`: a capture through the provider
  // onto the wallet.
  walletTopUp: 'DEPOSIT',
};

/**
 * Why a server action refused a form `mayOffer` would now withhold
 * (`mayDispatch`, `server/money-gate.ts`): nothing was sent.
 */
export type ProviderRefusal = 'PROVIDER_UNKNOWN';

/**
 * Whether a screen may offer an action: one that moves money, not while the
 * provider is unknown. An effect the table does not name counts as money.
 */
export function mayOffer(mode: DemoMode, effect: MoneyEffect | undefined): boolean {
  return effect === 'NONE' || mode !== 'UNKNOWN';
}

/**
 * The mode a read of the administrators' provider disclosure says — the
 * wallet's, which reads it anyway for the notice above its top-up form — by
 * `fetchDemoMode`'s rule: `UNKNOWN` for anything but an answer.
 */
export function demoModeOf(read: {
  readonly kind: string;
  readonly data?: { readonly simulated: boolean };
}): DemoMode {
  if (read.kind !== 'OK' || read.data === undefined) return 'UNKNOWN';
  return read.data.simulated ? 'SIMULATED' : 'REAL';
}
