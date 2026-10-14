import { canonicalQuantity, type PlaceOrderFormValues } from './place-order-fields';

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
 * Reads and removals swallow that. Saving does not: it reports whether the entry
 * is really there, and the form does not send without the PENDING entry — an
 * order that may commit with no memory of its key would be placed twice by a
 * reload.
 *
 * ## After logout starts
 *
 * `markAccountClosing` (the logout submit) is an in-memory flag for this document:
 * from then on nothing is written, so an answer that arrives before the old
 * document unloads cannot put the signed-out person's order back after the purge.
 */

const KEY_PREFIX = 'rasta.unresolved-order.';
const VERSION = 1;

/** Looser than the minted shape on purpose: this is a sanity check on stored text, the server is the judge of an id. */
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_FIELD_LENGTH = 128;

export interface UnresolvedOrder {
  readonly submissionId: string;
  readonly values: PlaceOrderFormValues;
  /** Null while the first send has not been answered: the entry is then PENDING. */
  readonly correlationId: string | null;
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
  /** Saved before the action was sent; the outcome of the send is not known. */
  readonly pending?: true;
  readonly owner: string;
  readonly session: string;
}

export type RestoredOrder =
  /** Same login: the stored id still verifies, so the retry button may be offered. */
  | { readonly kind: 'RETRYABLE'; readonly order: UnresolvedOrder }
  /** Same person, another login: the id is refused by the server now; show it, never re-send it. */
  | { readonly kind: 'VIEW_ONLY'; readonly order: UnresolvedOrder };

/** Set when a logout starts; this document writes no entry after it. Cleared by a page drawn for a login. */
let accountClosing = false;

export function markAccountClosing(): void {
  accountClosing = true;
}

export function markAccountOpen(): void {
  accountClosing = false;
}

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
    !(entry.correlationId === null || text(entry.correlationId)) ||
    !text(entry.owner) ||
    !text(entry.session) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt) ||
    typeof values !== 'object' ||
    values === null ||
    !text(values.offerId, 64) ||
    typeof values.quantity !== 'string'
  ) {
    return null;
  }
  // The same rule the action applies, so nothing it would have accepted is refused
  // here — an entry written with the text as typed still reads as the count it was.
  const quantity = canonicalQuantity(values.quantity);
  if (quantity === null) return null;
  return {
    v: VERSION,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
    session: entry.session,
    values: { offerId: values.offerId, quantity },
  };
}

/** Every key this module owns, in the order storage lists them. */
function ownKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Account boundary, logout: nothing of an unresolved order outlives the person
 * who signed out, whatever product it was for. (A session that merely *expires*
 * is not a logout: the same person's next login keeps theirs, below.)
 */
export function purgeAllUnresolvedOrders(): void {
  markAccountClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) store.removeItem(key);
  } catch {
    // See above.
  }
}

/**
 * Account boundary, a page for `owner`: entries of anyone else — and entries
 * that cannot be read as anyone's — are removed. The same person after a
 * re-login keeps theirs (view-only, `restoreUnresolvedOrder`).
 */
export function purgeForeignUnresolvedOrders(owner: string): void {
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) {
      const raw = store.getItem(key);
      const entry = raw === null ? null : parse(raw);
      if (!entry || entry.owner !== owner) store.removeItem(key);
    }
  } catch {
    // See above.
  }
}

/** True when the entry is stored. False: storage refused it, or a logout has started. */
export function saveUnresolvedOrder(
  productId: string,
  order: Omit<UnresolvedOrder, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): boolean {
  if (accountClosing) return false;
  try {
    const stored: Stored = {
      v: VERSION,
      submissionId: order.submissionId,
      values: { offerId: order.values.offerId, quantity: order.values.quantity },
      correlationId: order.correlationId,
      // Written before the send, when there is no correlation id yet.
      ...(order.correlationId === null ? { pending: true as const } : {}),
      savedAt: now,
      owner: binding.owner,
      session: binding.session,
    };
    const store = storage();
    if (!store) return false;
    store.setItem(keyOf(productId), JSON.stringify(stored));
    return true;
  } catch {
    // Unavailable or full: the caller decides what that means.
    return false;
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
