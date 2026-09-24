/**
 * The shape of the `/orders` screens: labels, the stepper's spine, and the
 * fields each order command's form posts.
 *
 * Separate from `server/orders.ts` for the reason `usage-fields.ts` gives: that
 * module reaches the gateway client and `node:crypto`, and the build refuses a
 * client component that imports it.
 *
 * ## What this file does not decide
 *
 * **Which commands a viewer may issue.** marketplace-service answers that per
 * caller in `OrderView.availableActions`, from the transition table, each
 * command's own narrowing and the party rules in `access.ts`. It is not
 * re-derived here, because re-deriving it is wrong: the transition table alone
 * permits `DISPUTED → RECEIPT_CONFIRMED` (for a platform operator resolving a
 * dispute), and a client reading it would offer the *buyer* "confirm receipt"
 * on a disputed order. The screens render what the service sent and nothing
 * else.
 */

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Every command the service may list in `availableActions`. */
export const ORDER_COMMANDS = [
  'CONFIRM',
  'FULFILL',
  'CONFIRM_RECEIPT',
  'RAISE_DISPUTE',
  'RESOLVE_DISPUTE',
  'CANCEL',
  'REVIEW',
] as const;

export type OrderCommand = (typeof ORDER_COMMANDS)[number];

export function isOrderCommand(value: unknown): value is OrderCommand {
  return typeof value === 'string' && (ORDER_COMMANDS as readonly string[]).includes(value);
}

/** What the button says. */
export const COMMAND_LABELS: Readonly<Record<OrderCommand, string>> = {
  CONFIRM: 'پذیرش سفارش',
  FULFILL: 'ثبت تحویل',
  CONFIRM_RECEIPT: 'تأیید دریافت',
  RAISE_DISPUTE: 'ثبت اختلاف',
  RESOLVE_DISPUTE: 'رسیدگی به اختلاف',
  CANCEL: 'لغو سفارش',
  REVIEW: 'ثبت نظر',
};

/**
 * What the person is told the command will do, before they do it.
 *
 * Two of these release or stop money, and a button label alone does not say
 * so. "Confirm receipt" in particular is the only command that lets settlement
 * happen (ADR-038) — a buyer must not press it believing it is a courtesy.
 */
export const COMMAND_CONSEQUENCES: Readonly<Record<OrderCommand, string>> = {
  CONFIRM: 'سفارش را می‌پذیرید و متعهد به تحویل آن می‌شوید.',
  FULFILL: 'اعلام می‌کنید کالا یا خدمت تحویل شده است. سفارش منتظر تأیید خریدار می‌ماند.',
  CONFIRM_RECEIPT:
    'تأیید می‌کنید کالا یا خدمت را دریافت کرده‌اید. این تنها اقدامی است که اجازهٔ تسویه با فروشنده را می‌دهد و بازگشت‌پذیر نیست.',
  RAISE_DISPUTE:
    'تسویه به‌طور کامل متوقف می‌شود تا اپراتور پلتفرم رسیدگی کند. دلیل را روشن بنویسید.',
  RESOLVE_DISPUTE: 'تصمیم شما سرنوشت وجه نگه‌داشته‌شده را معین می‌کند.',
  CANCEL: 'سفارش لغو می‌شود. تا بازگشت کامل وجه، وضعیت «در حال لغو» می‌ماند.',
  REVIEW: 'نظر شما دربارهٔ این سفارش تکمیل‌شده. هر سفارش فقط یک نظر می‌پذیرد.',
};

/** Commands whose effect cannot be walked back, rendered with a second look. */
export const IRREVERSIBLE_COMMANDS: ReadonlySet<OrderCommand> = new Set([
  'CONFIRM_RECEIPT',
  'RESOLVE_DISPUTE',
  'CANCEL',
]);

// ---------------------------------------------------------------------------
// Form fields, per command — each cap copied from marketplace-service `dto.ts`
// ---------------------------------------------------------------------------

export const COMMAND_FIELD = 'command';

/**
 * The limits the service enforces, mirrored as form constraints so a person is
 * told before posting rather than after a `422`. The service still decides:
 * these are copies, and a copy that drifts only makes the form less helpful,
 * never less safe.
 */
export const ORDER_FIELD_LIMITS = {
  /** `raiseDisputeSchema.reason` — at least a sentence, for whoever resolves it. */
  disputeReason: { min: 10, max: 1000 },
  /** `resolveDisputeSchema.resolution`. */
  resolution: { min: 10, max: 1000 },
  /** `cancelOrderSchema.reason`. */
  cancelReason: { min: 3, max: 500 },
  /** `fulfillOrderSchema.trackingReference`. */
  trackingReference: { max: 128 },
  /** `fulfillOrderSchema.note`, `confirmReceiptSchema.note`. */
  note: { max: 1000 },
  /** `submitReviewSchema.comment`. */
  reviewComment: { max: 2000 },
} as const;

export const DISPUTE_OUTCOMES = ['SETTLE', 'REFUND'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const DISPUTE_OUTCOME_LABELS: Readonly<Record<DisputeOutcome, string>> = {
  SETTLE: 'تسویه با فروشنده',
  REFUND: 'بازگشت وجه به خریدار',
};

/** `RESPONSIBILITY_ATTRIBUTION` — stated by the operator every time (ADR-052). */
export const RESPONSIBILITIES = ['SUPPLIER', 'BUYER', 'PLATFORM', 'UNDETERMINED'] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];

export const RESPONSIBILITY_LABELS: Readonly<Record<Responsibility, string>> = {
  SUPPLIER: 'فروشنده',
  BUYER: 'خریدار',
  PLATFORM: 'پلتفرم',
  UNDETERMINED: 'نامشخص',
};

/** Every field any order command form may post. One record, blank per form. */
export interface OrderCommandFormValues {
  readonly command: string;
  readonly reason: string;
  readonly note: string;
  readonly trackingReference: string;
  readonly outcome: string;
  readonly resolution: string;
  readonly responsibility: string;
  readonly rating: string;
  readonly comment: string;
  /**
   * `'yes'` when the person ticked "I understand this cannot be undone", on
   * the commands in {@link IRREVERSIBLE_COMMANDS}. Checked by the portal's
   * own action and never sent to the service — no DTO has it, and every
   * marketplace input schema is `.strict()`.
   */
  readonly acknowledge: string;
}

export type OrderCommandField = Exclude<keyof OrderCommandFormValues, 'command'>;

export const EMPTY_ORDER_COMMAND_FORM: OrderCommandFormValues = {
  command: '',
  reason: '',
  note: '',
  trackingReference: '',
  outcome: '',
  resolution: '',
  responsibility: '',
  rating: '',
  comment: '',
  acknowledge: '',
};

// ---------------------------------------------------------------------------
// Status and the stepper
// ---------------------------------------------------------------------------

export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'در انتظار نگه‌داشت وجه',
  FUNDS_HELD: 'وجه نگه‌داشته شد',
  CONFIRMED: 'پذیرفته‌شده توسط فروشنده',
  AWAITING_RECEIPT_CONFIRMATION: 'تحویل‌شده، منتظر تأیید خریدار',
  RECEIPT_CONFIRMED: 'دریافت تأیید شد',
  SETTLING: 'در حال تسویه',
  COMPLETED: 'تکمیل‌شده',
  DISPUTED: 'در اختلاف',
  CANCELLING: 'در حال لغو',
  CANCELLED: 'لغوشده',
  FAILED: 'ناموفق',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * The order's normal path, in order — the stepper's spine.
 *
 * **Funds are held before the supplier confirms.** It is the second step, not
 * a detail of settlement: by the time a supplier sees "confirm", the buyer's
 * money is already committed, and a stepper drawn as "placed → confirmed →
 * delivered → received" would hide the one step a buyer most needs to see.
 */
export const ORDER_SPINE = [
  'PENDING',
  'FUNDS_HELD',
  'CONFIRMED',
  'AWAITING_RECEIPT_CONFIRMATION',
  'RECEIPT_CONFIRMED',
  'SETTLING',
  'COMPLETED',
] as const;

export type SpineStatus = (typeof ORDER_SPINE)[number];

/** How each spine step is labelled on the stepper — shorter than the status. */
export const SPINE_LABELS: Readonly<Record<SpineStatus, string>> = {
  PENDING: 'ثبت سفارش',
  FUNDS_HELD: 'نگه‌داشت وجه',
  CONFIRMED: 'پذیرش فروشنده',
  AWAITING_RECEIPT_CONFIRMATION: 'تحویل',
  RECEIPT_CONFIRMED: 'تأیید دریافت',
  SETTLING: 'تسویه',
  COMPLETED: 'پایان',
};

/** A status off the spine — the order left the normal path. */
export const BRANCH_STATUSES = ['DISPUTED', 'CANCELLING', 'CANCELLED', 'FAILED'] as const;

export type StepState = 'done' | 'current' | 'upcoming' | 'not-reached';

export interface StepperStep {
  readonly status: SpineStatus;
  readonly label: string;
  readonly state: StepState;
}

/** What the stepper needs from the order. Timestamps are ISO strings or null. */
export interface StepperOrder {
  readonly status: string;
  readonly confirmedAt: string | null;
  readonly fulfilledAt: string | null;
  readonly receiptConfirmedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * The spine, marked with where this order actually is.
 *
 * On the spine, position decides: earlier steps are done, the status is
 * current, later ones upcoming.
 *
 * Off it — disputed, cancelling, cancelled, failed — position no longer says
 * anything, so each step is marked done **only where the order carries proof it
 * happened**: a `confirmedAt`, a `fulfilledAt`, a `receiptConfirmedAt`. Every
 * other step is `not-reached`, not `upcoming`: an order under dispute is not on
 * its way to settlement, and drawing the remaining steps as "next" would tell
 * the person something the service has not said.
 *
 * `FUNDS_HELD` has no timestamp of its own; it is inferred as done when a
 * later step is, because no command can reach `CONFIRMED` without it.
 */
export function stepperFor(order: StepperOrder): readonly StepperStep[] {
  const position = (ORDER_SPINE as readonly string[]).indexOf(order.status);

  if (position >= 0) {
    return ORDER_SPINE.map((status, index) => ({
      status,
      label: SPINE_LABELS[status],
      state: index < position ? 'done' : index === position ? 'current' : 'upcoming',
    }));
  }

  const evidence: Partial<Record<SpineStatus, boolean>> = {
    CONFIRMED: order.confirmedAt !== null,
    AWAITING_RECEIPT_CONFIRMATION: order.fulfilledAt !== null,
    RECEIPT_CONFIRMED: order.receiptConfirmedAt !== null,
    COMPLETED: order.completedAt !== null,
  };
  // The order exists, so it was placed; funds were held if anything after it
  // happened.
  evidence.PENDING = true;
  evidence.FUNDS_HELD = Boolean(evidence.CONFIRMED);

  return ORDER_SPINE.map((status) => ({
    status,
    label: SPINE_LABELS[status],
    state: evidence[status] ? 'done' : 'not-reached',
  }));
}

/** Why the order left the normal path, for the banner above the stepper. */
export const BRANCH_EXPLANATIONS: Readonly<Record<string, string>> = {
  DISPUTED:
    'این سفارش در اختلاف است. تسویه متوقف شده و تا تصمیم اپراتور پلتفرم هیچ وجهی جابه‌جا نمی‌شود.',
  CANCELLING: 'این سفارش در حال لغو است. تا بازگشت کامل وجه به خریدار، لغو کامل نشده است.',
  CANCELLED: 'این سفارش لغو شده است.',
  FAILED: 'این سفارش ناموفق بود و هیچ وجهی جابه‌جا نشد.',
};

// ---------------------------------------------------------------------------
// Which side of the list
// ---------------------------------------------------------------------------

export const ORDER_LIST_ROLES = ['BUYER', 'SUPPLIER'] as const;
export type OrderListRole = (typeof ORDER_LIST_ROLES)[number];

export const ORDER_LIST_ROLE_LABELS: Readonly<Record<OrderListRole, string>> = {
  BUYER: 'سفارش‌هایی که ثبت کرده‌ایم',
  SUPPLIER: 'سفارش‌هایی که به ما داده شده',
};
