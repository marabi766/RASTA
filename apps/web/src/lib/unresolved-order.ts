import { canonicalQuantity, type PlaceOrderFormValues } from './place-order-fields';
import {
  fencedSlot,
  keysUnder,
  locate,
  ownedHere,
  purgeForeign,
  reduceToQuarantine,
  storedKeyOf,
  type AccountTags,
  type AnswerOutcome,
  type Binding,
  type StartOutcome,
} from './unresolved-tenancy';

export type { AccountTags, AnswerOutcome, Binding, StartOutcome };

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
 * request (`place-order-actions.ts`). Each of those names the submission it
 * is about, and touches nothing else (`fencedSlot`, PR 405 review 3, R1): an
 * answer that arrives after the person set its order aside and started
 * another never writes over or removes the other — it is kept aside, a
 * content-free record that holds the next fresh order and draws the warning.
 *
 * Nothing else removes one (PR 405 review 2, F1; `lib/unresolved-tenancy.ts`):
 * a logout, another person's page and an expiry drop its content but leave a
 * content-free marker in its place, and an entry this person cannot be shown
 * — one from an organization their token no longer lists, another person's,
 * one that does not read — stays as it is. Each of these holds every fresh
 * order on this device until the person acknowledges the risk of a duplicate
 * (`orderQuarantine`).
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
  /**
   * Same person, another login — or an entry from before entries were kept per
   * organization (`lib/unresolved-tenancy.ts`): the id is refused by the server
   * now, or may be another organization's; show it, never re-send it.
   */
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

/** `parse` for `lib/unresolved-tenancy.ts`, which hands the key too. */
const parseEntry = (raw: string): Stored | null => parse(raw);

/** The one slot per product, fenced to its submission (`lib/unresolved-tenancy.ts`). */
const slot = fencedSlot(KEY_PREFIX, parseEntry, { closing: () => accountClosing });

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
export const orderQuarantine = slot.quarantine;

/**
 * Account boundary, logout: nothing of an unresolved order's content outlives
 * the person who signed out, whatever product it was for — but the fact that
 * an order's outcome is unknown does: each readable entry is reduced to a
 * content-free marker, which holds the next fresh order on this device until
 * acknowledged. A record that does not read is left as it is. (A session that
 * merely *expires* is not a logout: the same person's next login keeps theirs,
 * below.)
 */
export function purgeAllUnresolvedOrders(now: number = Date.now()): void {
  markAccountClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of keysUnder(store, KEY_PREFIX)) {
      // An entry from before entries were kept per organization stays as it is: whose it
      // is cannot be told here, and it is never written over (PR 405 review 2, F1).
      if (storedKeyOf(KEY_PREFIX, key)?.kind !== 'TENANT') continue;
      const raw = store.getItem(key);
      if (raw !== null && parse(raw) !== null) {
        reduceToQuarantine(store, KEY_PREFIX, key, now);
      }
    }
  } catch {
    // See above.
  }
}

/**
 * Account boundary, a page for this person: another person's entries are
 * reduced to content-free markers; nothing is removed. The same person keeps
 * theirs, for every organization (`lib/unresolved-tenancy.ts`), and after a
 * re-login (view-only, `restoreUnresolvedOrder`).
 */
export function purgeForeignUnresolvedOrders(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, parseEntry);
  } catch {
    // See above.
  }
}

/** What is stored for `order`: the first send's values and time when the slot already keeps it. */
function recordOf(
  order: Omit<UnresolvedOrder, 'savedAt'>,
  earlier: Stored | null,
  binding: Binding,
  now: number,
): string {
  const stored: Stored = {
    v: VERSION,
    submissionId: order.submissionId,
    // The body is the first send's, whatever a later answer carries: the retry is the same request.
    values: earlier
      ? earlier.values
      : { offerId: order.values.offerId, quantity: order.values.quantity },
    correlationId: order.correlationId,
    // Written before the send, when there is no correlation id yet.
    ...(order.correlationId === null ? { pending: true as const } : {}),
    savedAt: earlier ? earlier.savedAt : now,
    owner: binding.owner,
    session: binding.session,
  };
  return JSON.stringify(stored);
}

/**
 * Before the first send. `SAVED`: stored. `HELD`: another order's entry holds
 * this product's slot, or a quarantined record holds this kind for this
 * person (`orderQuarantine`) — nothing was written, and nothing may be sent.
 * `UNAVAILABLE`: storage refused it, or a logout has started.
 */
export function saveUnresolvedOrder(
  productId: string,
  order: Omit<UnresolvedOrder, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): StartOutcome {
  return slot.start(binding, productId, order.submissionId, (earlier) =>
    recordOf(order, earlier, binding, now),
  );
}

/**
 * An answer to `order.submissionId` that is still in doubt: its entry is
 * updated while the slot holds it; otherwise the slot is left as it is and the
 * answer is kept aside (`SET_ASIDE`; `lib/unresolved-tenancy.ts`).
 */
export function answerUnresolvedOrder(
  productId: string,
  order: Omit<UnresolvedOrder, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): AnswerOutcome {
  return slot.answer(
    binding,
    productId,
    order.submissionId,
    (earlier) => recordOf(order, earlier, binding, now),
    now,
  );
}

/** The order `submissionId` was placed or definitely refused: its entry, and only that one, is dropped. */
export function settleUnresolvedOrder(
  productId: string,
  submissionId: string,
  binding: Binding,
): void {
  slot.settle(binding, productId, submissionId);
}

/**
 * The person's "start a new order": drops the entry the page showed —
 * `submissionId`'s, this organization's or an old-format one of theirs — and
 * nothing else. Another order's entry, another organization's, and anything
 * that cannot be attributed (quarantined) stay.
 */
export function clearUnresolvedOrder(
  productId: string,
  submissionId: string,
  binding: Binding,
): void {
  slot.release(binding, productId, submissionId);
}

/**
 * The unresolved order for this product, if there is one this person may see
 * here, for this organization. Another organization's is not read at all. An
 * entry that does not read, or is not this person's, reads as none and stays
 * as it is (quarantined); an expired one of theirs reads as none and is
 * reduced to a content-free marker — never removed outright.
 */
export function restoreUnresolvedOrder(
  productId: string,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredOrder | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, productId) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw);
    if (!entry || !ownedHere(binding, found.legacy, entry.owner)) return null;
    if (now - entry.savedAt > maxAgeSeconds * 1000) {
      reduceToQuarantine(store, KEY_PREFIX, found.key, now);
      return null;
    }

    const { submissionId, values, correlationId, savedAt } = entry;
    const order: UnresolvedOrder = { submissionId, values, correlationId, savedAt };
    // An old-format entry may have been sent for another organization: never re-sent.
    const retryable = !found.legacy && entry.session === binding.session;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', order };
  } catch {
    return null;
  }
}
