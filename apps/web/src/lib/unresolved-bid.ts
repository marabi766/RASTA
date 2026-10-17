import { isBidCommand, type BidCommand } from './bid-fields';
import type { ReplayStamp } from './unresolved-statement';

export type { ReplayStamp };

/**
 * A bid command whose outcome is unknown, remembered in `sessionStorage` so a
 * reload cannot turn "maybe done" back into a fresh form as if nothing had
 * been sent — `lib/unresolved-statement.ts`'s rules, with one difference that
 * the bid's sealing decides.
 *
 * ## What is kept: nothing of the bid
 *
 * A bid's content is sealed by construction-service and read by nobody before
 * the opening, the bidder included (ADR-066 § 4). The portal does not keep a
 * copy of it either: a record here holds the command, the submission id, the
 * original correlation id, when it was saved and the owner's one-way tag
 * (`submissionBinding`) — **no price, no answer, no note**, no token, no
 * session value. So a record can never be re-sent after a reload; it is the
 * outcome-unknown marker from the start, shown until the person, having read
 * the bid's receipt the page now shows, sets it aside.
 *
 * That is safe here where it would not be for a statement draft, because no
 * bid command can take effect twice under a fresh key: the service keeps one
 * bid per organization and tender (a second submission is `409
 * ALREADY_EXISTS`), and a replacement or a withdrawal carries the revision it
 * was drawn on (`409 OPTIMISTIC_LOCK_FAILED` once the bid moved). The page's
 * read of `…/bids/mine` says what the service holds.
 *
 * Within the page that sent it, the same request may still be sent again under
 * its key while the form keeps it in memory (`BidCommandForm`); a submission
 * is then answered with its stored receipt.
 *
 * ## One unresolved command per tender, never replaced
 *
 * A tender's submit, replace and withdraw forms share one slot: a new
 * submission never replaces another's record (saving it is refused, `HELD`,
 * and the form is not sent), and a record is cleared only by the submission it
 * belongs to. Another person's page drops every entry of anyone else
 * (`purgeForeignUnresolvedBids`); a logout writes nothing more and leaves the
 * markers, which hold nothing of the bid.
 */

const KEY_PREFIX = 'rasta.unresolved-bid.';
const VERSION = 1;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;

/** A fresh submission id for one bid form, with its signed replay deadline. */
export interface BidSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedBid {
  readonly command: BidCommand;
  readonly submissionId: string;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
}

interface Stored extends UnresolvedBid {
  readonly v: typeof VERSION;
  readonly owner: string;
}

let accountClosing = false;

const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedBids(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markBidsOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const keyOf = (tenderId: string): string => `${KEY_PREFIX}${tenderId}`;

function tag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH;
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
  const keys = Object.keys(entry).sort().join(',');
  if (
    keys !== 'command,correlationId,owner,savedAt,submissionId,v' ||
    entry.v !== VERSION ||
    !isBidCommand(entry.command) ||
    !tag(entry.submissionId) ||
    !SUBMISSION_ID.test(entry.submissionId) ||
    !(entry.correlationId === null || tag(entry.correlationId)) ||
    !tag(entry.owner) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt)
  ) {
    return null;
  }
  return {
    v: VERSION,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  };
}

function ownKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Logout: nothing is saved from here on; unreadable entries are removed, markers stay. */
export function purgeAllUnresolvedBids(): void {
  accountClosing = true;
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) {
      const raw = store.getItem(key);
      if (raw === null || parse(raw) === null) store.removeItem(key);
    }
  } catch {
    // Unavailable storage holds nothing to purge.
  }
  changed();
}

/** A page for `owner`: entries of anyone else, and unreadable ones, are removed. */
export function purgeForeignUnresolvedBids(owner: string): void {
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

/**
 * `SAVED`: stored. `HELD`: another submission's record holds this tender — it
 * is left exactly as it was, and this one must not be sent. `UNAVAILABLE`:
 * storage refused it, or a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

export function saveUnresolvedBid(
  tenderId: string,
  entry: Omit<UnresolvedBid, 'savedAt'>,
  owner: string,
  now: number = Date.now(),
): SaveOutcome {
  if (accountClosing) return 'UNAVAILABLE';
  try {
    const store = storage();
    if (!store) return 'UNAVAILABLE';
    const previous = store.getItem(keyOf(tenderId));
    const parsed = previous === null ? null : parse(previous);
    const earlier = parsed?.owner === owner ? parsed : null;
    if (earlier !== null && earlier.submissionId !== entry.submissionId) return 'HELD';
    const record: Stored = {
      v: VERSION,
      command: entry.command,
      submissionId: entry.submissionId,
      correlationId: entry.correlationId,
      // The entry dates from the first send.
      savedAt: earlier?.savedAt ?? now,
      owner,
    };
    store.setItem(keyOf(tenderId), JSON.stringify(record));
    changed();
    return 'SAVED';
  } catch {
    return 'UNAVAILABLE';
  }
}

/** Forgets the record of `submissionId` — and only that one. */
export function clearUnresolvedBid(tenderId: string, submissionId: string): void {
  try {
    const store = storage();
    const raw = store?.getItem(keyOf(tenderId));
    if (!store || raw === null || raw === undefined) return;
    if (parse(raw)?.submissionId !== submissionId) return;
    store.removeItem(keyOf(tenderId));
  } catch {
    return;
  }
  changed();
}

/** The unresolved bid command on this tender, if this person has one; anything else is removed. */
export function restoreUnresolvedBid(tenderId: string, owner: string): UnresolvedBid | null {
  try {
    const store = storage();
    const raw = store?.getItem(keyOf(tenderId));
    if (!store || raw === null || raw === undefined) return null;
    const entry = parse(raw);
    if (!entry || entry.owner !== owner) {
      store.removeItem(keyOf(tenderId));
      return null;
    }
    const { command, submissionId, correlationId, savedAt } = entry;
    return { command, submissionId, correlationId, savedAt };
  } catch {
    return null;
  }
}
