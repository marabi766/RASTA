import {
  SLOT_OF,
  isContractCommand,
  slotHasSubject,
  type ContractCommand,
  type ContractSlot,
} from './contract-command-fields';
import { isCommandInput, type CommandInput } from './contract-command-input';
import {
  keysUnder,
  locate,
  ownedHere,
  purgeForeign,
  storedKeyOf,
  tenantKey,
  type AccountTags,
  type Binding,
} from './unresolved-tenancy';

/**
 * A contract command whose outcome is unknown, kept in `sessionStorage` so
 * that a reload cannot turn "maybe done" back into a fresh form with a fresh
 * key — `lib/unresolved-statement.ts`'s rules, for signing and cancelling a
 * contract, proposing and signing an amendment and planning and changing a
 * milestone.
 *
 * ## Why a fresh key is not safe here
 *
 * An amendment or a milestone sent under key K can commit unseen; the same
 * form sent again under a new key is a **second amendment** or a **second
 * milestone**. Only the original key with the original body is answered by the
 * service's stored response instead of being executed again. A signature, a
 * cancellation or a change repeated under a new key is refused by the state it
 * left behind (or changes nothing), but its outcome is just as unknown until
 * the page is read again, so it is held the same way and no fresh form is
 * drawn over it.
 *
 * ## What is kept
 *
 * Per slot (`CONTRACT_SLOTS` — the contract's own signature and cancellation,
 * a new amendment, one amendment, a new milestone, one milestone) the
 * command, the submission id, what the person typed exactly as it was sent
 * (`CommandInput`; nothing for a signature), the original correlation id, when
 * it was saved, and its replay stamp (`server/contract-command-replay.ts`, a
 * signed deadline, not a credential), with the two one-way login tags
 * (`submissionBinding`). No token, no session value, no CSRF value.
 *
 * ## One unresolved command per slot, never replaced
 *
 * A contract's sign and cancel forms share its slot: a new submission never
 * **replaces** another submission's record — saving it is refused (`HELD`) and
 * the form is not sent — and a record is cleared only by the submission it
 * belongs to (`clearUnresolvedContractCommand` takes its id), on a definite
 * outcome of that submission. Otherwise a signature whose answer was lost
 * could be overwritten by a cancellation, whose refusal would then erase the
 * signature's key and its warning. Every change is announced to the page's
 * other forms (`subscribeUnresolvedContractCommands`), which stay view-only
 * while another command holds the slot.
 *
 * ## Never silently gone
 *
 * An entry older than the session's lifetime, and every entry at logout, is
 * **reduced** to a marker — no input, no login tag, no stamp — shown view-only
 * as "the outcome is unknown" until the person acknowledges it. A confirmed
 * answer (the action redirects) drops it; otherwise only the person does, with
 * the labelled action the uncertainty view offers once the same request has
 * been tried again or can no longer be. Another person's page drops every
 * entry of anyone else (`purgeForeignUnresolvedContractCommands`).
 */

const KEY_PREFIX = 'rasta.unresolved-contract.';
const VERSION = 1;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;
const MAX_STAMP_LENGTH = 4096;

/**
 * Until when the server will let the same request be sent again: `token` is
 * checked by the action, `until` (milliseconds since the epoch) only decides
 * which controls are drawn.
 */
export interface ReplayStamp {
  readonly token: string;
  readonly until: number;
}

/** A fresh submission id for one contract form, with its signed replay deadline. */
export interface ContractSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedContractCommand {
  readonly command: ContractCommand;
  readonly submissionId: string;
  /** What was typed, as sent; null for a signature, and in a marker. */
  readonly input: CommandInput;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: nothing re-sendable is kept. */
  readonly marker: boolean;
}

/** Where an entry is kept: one slot of one contract. */
export interface ContractScope {
  readonly contractId: string;
  readonly slot: ContractSlot;
  /** The amendment or milestone of an `AMENDMENT` or `MILESTONE` slot; null otherwise. */
  readonly subjectId: string | null;
}

type Stored = Omit<UnresolvedContractCommand, 'marker'> & {
  readonly v: typeof VERSION;
  readonly marker: boolean;
  readonly owner: string;
  readonly session?: string;
};

export type RestoredContractCommand =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly entry: UnresolvedContractCommand }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly entry: UnresolvedContractCommand };

let accountClosing = false;

/** Same-tab listeners: the forms of a page, told when a slot changes (`sessionStorage` is per tab). */
const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedContractCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markContractCommandsClosing(): void {
  accountClosing = true;
}

export function markContractCommandsOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeText(scope: ContractScope): string {
  return `${scope.contractId}.${scope.slot}.${scope.subjectId ?? '-'}`;
}

/** Whether `command` is held in `scope`'s slot — a record of another slot is not this one's. */
function fits(scope: ContractScope, command: ContractCommand): boolean {
  return (
    SLOT_OF[command] === scope.slot && slotHasSubject(scope.slot) === (scope.subjectId !== null)
  );
}

function tag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH;
}

function replayOf(value: unknown): ReplayStamp | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const stamp = value as Record<string, unknown>;
  if (
    typeof stamp.token !== 'string' ||
    stamp.token.length === 0 ||
    stamp.token.length > MAX_STAMP_LENGTH ||
    typeof stamp.until !== 'number' ||
    !Number.isFinite(stamp.until)
  ) {
    return undefined;
  }
  return { token: stamp.token, until: stamp.until };
}

function parse(raw: string, scope: ContractScope): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    entry.v !== VERSION ||
    !isContractCommand(entry.command) ||
    !fits(scope, entry.command) ||
    !tag(entry.submissionId) ||
    !SUBMISSION_ID.test(entry.submissionId) ||
    !(entry.correlationId === null || tag(entry.correlationId)) ||
    !tag(entry.owner) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt)
  ) {
    return null;
  }
  const common = {
    v: VERSION,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  } as const;
  if (entry.marker === true) return { ...common, marker: true, replay: null, input: null };

  const replay = replayOf(entry.replay);
  if (
    entry.marker !== false ||
    !tag(entry.session) ||
    replay === undefined ||
    !isCommandInput(entry.command, entry.input)
  ) {
    return null;
  }
  return { ...common, marker: false, session: entry.session, replay, input: entry.input };
}

/** What a marker keeps: nothing of the input, the login or the stamp. */
function markerOf(entry: Stored): string {
  return JSON.stringify({
    v: VERSION,
    marker: true,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  });
}

/** The scope a stored key's scope text names, or null — for the purges, which read every slot. */
function scopeOfText(rest: string): ContractScope | null {
  const parts = rest.split('.');
  if (parts.length < 3) return null;
  const subject = parts.pop() as string;
  const slot = parts.pop() as ContractSlot;
  const contractId = parts.join('.');
  if (contractId.length === 0) return null;
  return { contractId, slot, subjectId: subject === '-' ? null : subject };
}

function parseIn(raw: string, scopeText: string): Stored | null {
  const scope = scopeOfText(scopeText);
  return scope === null ? null : parse(raw, scope);
}

function stored(store: Storage, key: string): Stored | null {
  const raw = store.getItem(key);
  const located = storedKeyOf(KEY_PREFIX, key);
  return raw === null || located === null ? null : parseIn(raw, located.scope);
}

/** Logout: every entry reduced to a marker; unreadable ones removed. */
export function purgeAllUnresolvedContractCommands(): void {
  markContractCommandsClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of keysUnder(store, KEY_PREFIX)) {
      const entry = stored(store, key);
      if (entry) store.setItem(key, markerOf(entry));
      else store.removeItem(key);
    }
  } catch {
    // Unavailable storage holds nothing to purge.
  }
  changed();
}

/**
 * A page for this person: entries of anyone else, and unreadable ones, are
 * removed; theirs stay, for every organization (`lib/unresolved-tenancy.ts`).
 */
export function purgeForeignUnresolvedContractCommands(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, (raw, key) => parseIn(raw, key.scope));
  } catch {
    // See above.
  }
}

/**
 * `SAVED`: stored. `HELD`: another submission's record holds this slot — it is
 * left exactly as it was, and this one must not be sent. `UNAVAILABLE`: storage
 * refused it, or a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

export function saveUnresolvedContractCommand(
  scope: ContractScope,
  entry: Omit<UnresolvedContractCommand, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): SaveOutcome {
  if (accountClosing || !fits(scope, entry.command)) return 'UNAVAILABLE';
  try {
    const store = storage();
    if (!store) return 'UNAVAILABLE';
    const found = locate(store, KEY_PREFIX, binding, scopeText(scope));
    const parsed = found === null ? null : parse(found.raw, scope);
    // Someone else's is not this person's to keep (`purgeForeignUnresolvedContractCommands`).
    const earlier =
      found !== null && parsed !== null && ownedHere(binding, found.legacy, parsed.owner)
        ? parsed
        : null;
    // Another submission's record — even a marker — is never replaced; nor is
    // a record from before records were kept per organization, which is only
    // ever shown (it may have been another organization's).
    if (earlier !== null && (found?.legacy || earlier.submissionId !== entry.submissionId)) {
      return 'HELD';
    }
    // A marker is never turned back into something that can be re-sent.
    if (earlier?.marker) return 'SAVED';
    const same = earlier !== null;
    store.setItem(
      tenantKey(KEY_PREFIX, binding, scopeText(scope)),
      JSON.stringify({
        v: VERSION,
        marker: false,
        command: entry.command,
        submissionId: entry.submissionId,
        input: entry.input,
        correlationId: entry.correlationId,
        // The entry dates from the first send.
        savedAt: same ? earlier.savedAt : now,
        // Once withdrawn — the server said the deadline passed — never restored.
        replay: same && earlier.replay === null ? null : entry.replay,
        owner: binding.owner,
        session: binding.session,
      }),
    );
    changed();
    return 'SAVED';
  } catch {
    return 'UNAVAILABLE';
  }
}

/**
 * Forgets the record of `submissionId` — and only that one: a record another
 * submission holds stays, and so does every other organization's. An
 * unreadable record is left to `restoreUnresolvedContractCommand`, which
 * removes it.
 */
export function clearUnresolvedContractCommand(
  scope: ContractScope,
  submissionId: string,
  binding: Binding,
): void {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, scopeText(scope)) : null;
    if (!store || found === null) return;
    if (parse(found.raw, scope)?.submissionId !== submissionId) return;
    store.removeItem(found.key);
  } catch {
    // See above.
    return;
  }
  changed();
}

/**
 * The unresolved command in this slot, if this person has one. Unreadable, or
 * someone else's: removed, read as none. Older than the session's lifetime:
 * reduced to the marker, and read as that — never as none.
 */
export function restoreUnresolvedContractCommand(
  scope: ContractScope,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredContractCommand | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, scopeText(scope)) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw, scope);
    if (!entry || !ownedHere(binding, found.legacy, entry.owner)) {
      store.removeItem(found.key);
      return null;
    }
    const { command, submissionId, correlationId, savedAt } = entry;
    if (entry.marker || now - savedAt > maxAgeSeconds * 1000) {
      if (!entry.marker) store.setItem(found.key, markerOf(entry));
      return {
        kind: 'VIEW_ONLY',
        entry: {
          command,
          submissionId,
          correlationId,
          savedAt,
          input: null,
          replay: null,
          marker: true,
        },
      };
    }
    const restored: UnresolvedContractCommand = {
      command,
      submissionId,
      input: entry.input,
      correlationId,
      savedAt,
      replay: entry.replay,
      marker: false,
    };
    // An old-format record may have been sent for another organization: never re-sent.
    const retryable =
      !found.legacy &&
      entry.session === binding.session &&
      entry.replay !== null &&
      now < entry.replay.until;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', entry: restored };
  } catch {
    return null;
  }
}
