import { canonicalQuantity, type PlaceOrderFormValues } from './place-order-fields';
import {
  freeOwnKey,
  keysUnder,
  legacyKey,
  locate,
  mayStartFresh,
  ownedHere,
  purgeForeign,
  quarantineOf,
  reduceToQuarantine,
  storedKeyOf,
  tenantKey,
  type AccountTags,
  type Binding,
} from './unresolved-tenancy';

export type { AccountTags, Binding };

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

/** The entry under this page's own key, when it reads and is this page's. */
function parseOwned(raw: string, binding: Binding): Stored | null {
  const entry = parse(raw);
  return entry !== null && entry.owner === binding.owner ? entry : null;
}

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
export const orderQuarantine = quarantineOf(KEY_PREFIX, parseEntry);

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

/**
 * True when the entry is stored. False: storage refused it, a logout has
 * started, or — for a fresh order — a quarantined record holds this kind for
 * this person (`orderQuarantine`): then nothing may be sent.
 */
export function saveUnresolvedOrder(
  productId: string,
  order: Omit<UnresolvedOrder, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): boolean {
  if (accountClosing) return false;
  try {
    const store = storage();
    if (!store) return false;
    const key = tenantKey(KEY_PREFIX, binding, productId);
    const kept = store.getItem(key);
    const same = kept !== null && parseOwned(kept, binding)?.submissionId === order.submissionId;
    if (!same && !mayStartFresh(store, KEY_PREFIX, binding, parseEntry)) return false;
    // Never written over: whatever else the key holds is moved aside first.
    freeOwnKey(store, KEY_PREFIX, key, binding, parseEntry);
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
    store.setItem(key, JSON.stringify(stored));
    return true;
  } catch {
    // Unavailable or full: the caller decides what that means.
    return false;
  }
}

/**
 * Drops this page's entry for the product: this organization's, and an entry
 * from before entries were kept per organization that the page showed in its
 * place — only when it is this person's. Another organization's stays, and so
 * does anything that cannot be attributed (quarantined).
 */
export function clearUnresolvedOrder(productId: string, binding: Binding): void {
  try {
    const store = storage();
    if (!store) return;
    const own = tenantKey(KEY_PREFIX, binding, productId);
    const ownRaw = store.getItem(own);
    if (ownRaw !== null && parseOwned(ownRaw, binding) !== null) store.removeItem(own);
    const old = legacyKey(KEY_PREFIX, productId);
    const oldRaw = store.getItem(old);
    const oldEntry = oldRaw === null ? null : parse(oldRaw);
    if (oldEntry !== null && ownedHere(binding, true, oldEntry.owner)) store.removeItem(old);
  } catch {
    // See above.
  }
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
