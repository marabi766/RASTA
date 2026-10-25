/**
 * The shape of the two dispute commands on `/transactions/[id]`: their names,
 * field names, the limits they mirror, the roles and states they are offered
 * in, and the words a person reads about them.
 *
 * Separate from `server/transactions.ts` for the reason `order-fields.ts` is
 * separate from `server/orders.ts`: that module reaches the gateway client and
 * `node:crypto`, and the build refuses a client component that imports it.
 *
 * Every rule here is a **copy** of economic-service's
 * (`services/economic-service/src/transaction/*`), kept only so a person is not
 * offered a control the service would refuse. The service decides on every
 * request; `transactions.contract.spec.ts` fails the moment a copy and its
 * original disagree.
 *
 * ## What the portal does not add
 *
 * No dispute categories, deadlines or outcomes: economic-service takes one free
 * text (`reason` to dispute, `resolution` to resolve) and nothing else, and
 * resolving has exactly one effect — the transaction goes back to
 * `PENDING_SETTLEMENT`. It does not settle and it does not refund; releasing
 * the money stays a separate act (`transaction.controller.ts`).
 */

export const DISPUTE_COMMANDS = ['DISPUTE', 'RESOLVE_DISPUTE'] as const;
export type DisputeCommand = (typeof DISPUTE_COMMANDS)[number];

export function isDisputeCommand(value: string | undefined): value is DisputeCommand {
  return (DISPUTE_COMMANDS as readonly string[]).includes(value ?? '');
}

/** The hidden field that says which command a form is. */
export const DISPUTE_COMMAND_FIELD = 'command';

export const DISPUTE_FIELDS = ['reason', 'resolution'] as const;
export type DisputeField = (typeof DISPUTE_FIELDS)[number];
export type DisputeFormValues = Readonly<Record<DisputeField, string>>;

export const EMPTY_DISPUTE_FORM: DisputeFormValues = { reason: '', resolution: '' };

/** The one field each command sends (`disputeTransactionSchema`, `resolveDisputeSchema`). */
export const DISPUTE_COMMAND_FIELDS: Readonly<Record<DisputeCommand, DisputeField>> = {
  DISPUTE: 'reason',
  RESOLVE_DISPUTE: 'resolution',
};

/** Copied from `transaction/dto.ts` (both `.trim().min(10).max(1000)`); the service enforces them again. */
export const DISPUTE_FIELD_LIMITS: Readonly<Record<DisputeField, { min: number; max: number }>> = {
  reason: { min: 10, max: 1000 },
  resolution: { min: 10, max: 1000 },
};

/**
 * The states each command is legal from (`transaction/state-machine.ts`:
 * `HELD` and `PENDING_SETTLEMENT` have a `DISPUTE` edge, `DISPUTED` alone has
 * `RESOLVE_DISPUTE`). From any other state the service answers
 * `409 INVALID_STATE_TRANSITION`, so no form is drawn.
 */
export const DISPUTE_FROM_STATES: Readonly<Record<DisputeCommand, readonly string[]>> = {
  DISPUTE: ['HELD', 'PENDING_SETTLEMENT'],
  RESOLVE_DISPUTE: ['DISPUTED'],
};

/** The state a successful command leaves the transaction in — what a confirmed answer must show. */
export const DISPUTE_TARGET_STATE: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE: 'DISPUTED',
  RESOLVE_DISPUTE: 'PENDING_SETTLEMENT',
};

/**
 * `@Roles` on each route (`transaction.controller.ts`): `get` and `dispute`
 * admit the three financial administrator roles, `resolveDispute` only the two
 * platform ones.
 */
export const TRANSACTION_READ_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
] as const;

export const DISPUTE_COMMAND_ROLES: Readonly<Record<DisputeCommand, readonly string[]>> = {
  DISPUTE: ['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'],
  RESOLVE_DISPUTE: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
};

/**
 * `PLATFORM_ROLES` (`access/access.ts`): the roles that may commit an
 * organization other than their own. Everyone else may commit only the payer —
 * `canCommitOrganization(transaction.organizationId)` — so the payee's
 * administrator is refused `403` on `dispute`.
 */
export const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/** Refused by `assertNotAuditor()` before anything else, whatever else the person holds. */
export const NEVER_ROLE = 'AUDITOR';

export const DISPUTE_COMMAND_LABELS: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE: 'ثبت اعتراض',
  RESOLVE_DISPUTE: 'رسیدگی به اعتراض',
};

/** What each command does, in the service's own terms — nothing more is promised. */
export const DISPUTE_COMMAND_CONSEQUENCES: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE:
    'با ثبت اعتراض، تسویهٔ این تراکنش به‌طور کامل متوقف می‌شود و هیچ مهلت یا سازوکار خودکاری آن را برنمی‌دارد؛ ' +
    'فقط رسیدگی صریح یک شخص یا بازگشت وجه آن را از این وضعیت بیرون می‌برد.',
  RESOLVE_DISPUTE:
    'با رسیدگی، تراکنش به صف «در انتظار تسویه» برمی‌گردد. این کار تسویه نمی‌کند و وجهی را بازنمی‌گرداند؛ ' +
    'تسویه اقدامی جدا و بعدی است.',
};

export const DISPUTE_FIELD_LABELS: Readonly<Record<DisputeField, string>> = {
  reason: 'دلیل اعتراض',
  resolution: 'شرح تصمیم',
};

/**
 * The transaction type disputed only through its order (Q-138, answered by the
 * Product Owner on 2026-10-16): a marketplace order's own dispute flow
 * (`/orders/[id]`) records outcome and responsibility, so the transaction page
 * offers neither opening nor resolving a dispute on such a transaction and
 * links to the order instead.
 */
export const ORDER_DISPUTED_TRANSACTION_TYPE = 'MARKETPLACE_ORDER';

/**
 * Where a transaction is disputed instead of here, or null when it is disputed
 * here. The order id is taken only from what the transaction view carries:
 * marketplace-service records its obligation with `sourceType: 'ORDER'` and
 * the order id as `sourceReference`. Anything else links to the order list.
 */
export function disputedThroughOrder(transaction: {
  readonly transactionType: string;
  readonly sourceType: string | null;
  readonly sourceReference: string | null;
}): { readonly href: string; readonly orderId: string | null } | null {
  if (transaction.transactionType !== ORDER_DISPUTED_TRANSACTION_TYPE) return null;
  const orderId =
    transaction.sourceType === 'ORDER' &&
    transaction.sourceReference !== null &&
    transaction.sourceReference.trim() !== ''
      ? transaction.sourceReference
      : null;
  return { href: orderId ? `/orders/${encodeURIComponent(orderId)}` : '/orders', orderId };
}

/**
 * What a dispute form's submission is bound to: the transaction, and — for a
 * resolution — **the dispute the page showed** (`disputeId` on
 * `GET /v1/transactions/:id`, docs/23 D-053). A decision is about one dispute;
 * economic-service applies a resolution that names it only while the
 * transaction still holds that dispute, under its row lock. Signed into the
 * submission's replay stamp (`server/dispute-replay.ts`), so the first send and
 * every retry name the same dispute — never one read again later.
 */
export interface DisputeTarget {
  readonly transactionId: string;
  /** The dispute a resolution decides; null for opening one, which decides none. */
  readonly disputeId: string | null;
}

export function disputeTargetOf(
  transaction: { readonly id: string; readonly disputeId: string | null },
  command: DisputeCommand,
): DisputeTarget {
  return {
    transactionId: transaction.id,
    disputeId: command === 'RESOLVE_DISPUTE' ? transaction.disputeId : null,
  };
}
