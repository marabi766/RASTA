import type { PlaceOrderFormValues } from './place-order-fields';

/**
 * An order whose outcome is unknown, kept in `sessionStorage` so that a reload,
 * the sort form's GET navigation, or a sign-in in between cannot turn "maybe
 * placed" back into a blank form that mints a new `Idempotency-Key` for the same
 * order.
 *
 * ## What is kept
 *
 * The submission id, the normalized values, the original correlation id and when
 * it was saved — and two one-way tags (`server/submission.ts`,
 * `submissionBinding`) saying whose it was. **No token, no session value, no
 * CSRF value:** the submission id is an identifier the form already carries in
 * the page, and the tags are keyed digests that open nothing.
 *
 * ## What it is for, and not for
 *
 * Only an *unresolved* submission is kept. It is dropped by the explicit "start
 * a new order" action and by a successful order response; a definite refusal
 * does not drop it, because a refusal of a retry says nothing about the first
 * request (`place-order-actions.ts`).
 *
 * Storage can be absent (private mode, a blocked cookie policy, a full quota).
 * Every call here swallows that: the page works exactly as it did before, only
 * without the memory.
 */

const KEY_PREFIX = 'rasta.unresolved-order.';
const VERSION = 1;

/** Looser than the minted shape on purpose: this is a sanity check on stored text, the server is the judge of an id. */
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_FIELD_LENGTH = 128;

export interface UnresolvedOrder {
  readonly submissionId: string;
  readonly values: PlaceOrderFormValues;
  readonly correlationId: string;
  /** Milliseconds since the epoch, browser clock. Used only to age the entry out. */
  readonly savedAt: number;
}

/** The two tags the page computed for the current login; see `submissionBinding`. */
export interface Binding {
  readonly owner: string;
  readonly session: string;
}

interface Stored extends UnresolvedOrder {
  readonly v: typeof VERSION;
  readonly owner: string;
  readonly session: string;
}

export type RestoredOrder =
  /** Same login: the stored id still verifies, so the retry button may be offered. */
  | { readonly kind: 'RETRYABLE'; readonly order: UnresolvedOrder }
  /** Same person, another login: the id is refused by the server now; show it, never re-send it. */
  | { readonly kind: 'VIEW_ONLY'; readonly order: UnresolvedOrder };

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function keyOf(productId: string): string {
  return `${KEY_PREFIX}${productId}`;
}

function text(value: unknown, max = MAX_FIELD_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parse(raw: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const values = entry.values as Record<string, unknown> | null | undefined;
  if (
    entry.v !== VERSION ||
    !text(entry.submissionId) ||
    !SUBMISSION_ID.test(entry.submissionId) ||
    !text(entry.correlationId) ||
    !text(entry.owner) ||
    !text(entry.session) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt) ||
    typeof values !== 'object' ||
    values === null ||
    !text(values.offerId, 64) ||
    !text(values.quantity, 16)
  ) {
    return null;
  }
  return {
    v: VERSION,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
    session: entry.session,
    values: { offerId: values.offerId, quantity: values.quantity },
  };
}

export function saveUnresolvedOrder(
  productId: string,
  order: Omit<UnresolvedOrder, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): void {
  try {
    const stored: Stored = {
      v: VERSION,
      submissionId: order.submissionId,
      values: { offerId: order.values.offerId, quantity: order.values.quantity },
      correlationId: order.correlationId,
      savedAt: now,
      owner: binding.owner,
      session: binding.session,
    };
    storage()?.setItem(keyOf(productId), JSON.stringify(stored));
  } catch {
    // No storage: the page works, without the memory.
  }
}

export function clearUnresolvedOrder(productId: string): void {
  try {
    storage()?.removeItem(keyOf(productId));
  } catch {
    // See above.
  }
}

/**
 * The unresolved order for this product, if there is one this person may see.
 * An unreadable, aged-out or someone else's entry is removed and reads as none.
 */
export function restoreUnresolvedOrder(
  productId: string,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredOrder | null {
  try {
    const store = storage();
    const raw = store?.getItem(keyOf(productId));
    if (!store || raw === null || raw === undefined) return null;

    const entry = parse(raw);
    const aged = entry !== null && now - entry.savedAt > maxAgeSeconds * 1000;
    if (!entry || aged || entry.owner !== binding.owner) {
      store.removeItem(keyOf(productId));
      return null;
    }

    const { submissionId, values, correlationId, savedAt } = entry;
    const order: UnresolvedOrder = { submissionId, values, correlationId, savedAt };
    return { kind: entry.session === binding.session ? 'RETRYABLE' : 'VIEW_ONLY', order };
  } catch {
    return null;
  }
}
