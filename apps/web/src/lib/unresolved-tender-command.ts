import { isOwnerCommand, type OwnerCommand } from './tender-owner-fields';
import { markerStore, type SaveOutcome, type UnresolvedMarker } from './unresolved-marker';
import type { AccountTags, Binding } from './unresolved-tenancy';
import type { ReplayStamp } from './unresolved-statement';

export type { ReplayStamp, SaveOutcome };

/**
 * An owner's tender command whose outcome is unknown — publishing, deciding the
 * publication's step, proposing, opening or withdrawing the opening — kept as a
 * **marker** (`lib/unresolved-marker.ts`): that it was sent, never what it
 * said (a rejection's reason included).
 *
 * That is enough here because none of these commands takes effect twice under
 * a fresh key: a publication and a decision carry the version the page read
 * (`409` once it moved), a proposal and an opening are idempotent in the
 * service (`alreadyProposed`, `alreadyOpened`), and a second withdrawal finds
 * none (`NO_PROPOSAL`). After a reload the page reads the tender again and the
 * marker stays beside it, view-only, until the person sets it aside.
 *
 * **One slot per tender:** the owner's six commands share it, so a decision
 * whose answer was lost cannot be followed, unseen, by an opening or another
 * publication from the same browser.
 */

export interface OwnerSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
  /** The body the stamp binds by digest, posted beside it (`server/tender-owner-replay.ts`). */
  readonly binding?: string;
}

export type UnresolvedOwnerCommand = UnresolvedMarker<OwnerCommand>;

const store = markerStore('rasta.unresolved-tender-command.', isOwnerCommand);

export const subscribeUnresolvedOwnerCommands = (listener: () => void): (() => void) =>
  store.subscribe(listener);

export const markOwnerCommandsOpen = (): void => store.markOpen();

export const purgeAllUnresolvedOwnerCommands = (): void => store.purgeAll();

export const purgeForeignUnresolvedOwnerCommands = (tags: AccountTags): void =>
  store.purgeForeign(tags);

export const saveUnresolvedOwnerCommand = (
  tenderId: string,
  entry: Omit<UnresolvedOwnerCommand, 'savedAt'>,
  binding: Binding,
  now?: number,
): SaveOutcome => store.save(tenderId, entry, binding, now);

export const clearUnresolvedOwnerCommand = (
  tenderId: string,
  submissionId: string,
  binding: Binding,
): void => store.clear(tenderId, submissionId, binding);

export const restoreUnresolvedOwnerCommand = (
  tenderId: string,
  binding: Binding,
): UnresolvedOwnerCommand | null => store.restore(tenderId, binding);

/** What holds a fresh command of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
export const ownerCommandQuarantine = store.quarantine;
