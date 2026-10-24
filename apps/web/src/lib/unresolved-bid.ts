import { isBidCommand, type BidCommand } from './bid-fields';
import { markerStore, type SaveOutcome, type UnresolvedMarker } from './unresolved-marker';
import type { AccountTags, Binding } from './unresolved-tenancy';
import type { ReplayStamp } from './unresolved-statement';

export type { ReplayStamp, SaveOutcome };

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

/** A fresh submission id for one bid form, with its signed replay deadline. */
export interface BidSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export type UnresolvedBid = UnresolvedMarker<BidCommand>;

/** One record per tender (`lib/unresolved-marker.ts`). */
const store = markerStore('rasta.unresolved-bid.', isBidCommand);

/** Called on every save and clear; returns the unsubscribe. */
export const subscribeUnresolvedBids = (listener: () => void): (() => void) =>
  store.subscribe(listener);

export const markBidsOpen = (): void => store.markOpen();

/** Logout: nothing is saved from here on; unreadable entries are removed, markers stay. */
export const purgeAllUnresolvedBids = (): void => store.purgeAll();

/** A page for this person: entries of anyone else, and unreadable ones, are removed; theirs stay, for every organization. */
export const purgeForeignUnresolvedBids = (tags: AccountTags): void => store.purgeForeign(tags);

export const saveUnresolvedBid = (
  tenderId: string,
  entry: Omit<UnresolvedBid, 'savedAt'>,
  binding: Binding,
  now?: number,
): SaveOutcome => store.save(tenderId, entry, binding, now);

/** Forgets the record of `submissionId` — and only that one. */
export const clearUnresolvedBid = (
  tenderId: string,
  submissionId: string,
  binding: Binding,
): void => store.clear(tenderId, submissionId, binding);

/** The unresolved bid command on this tender, if this person has one; anything else is removed. */
export const restoreUnresolvedBid = (tenderId: string, binding: Binding): UnresolvedBid | null =>
  store.restore(tenderId, binding);
