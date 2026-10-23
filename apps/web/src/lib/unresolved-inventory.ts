import {
  SCOPE_COMMANDS,
  hasFields,
  isInventoryCommand,
  parseInventoryForm,
  valuesOfBody,
  type InventoryBody,
  type InventoryCommand,
  type InventoryScope,
} from './inventory-commands';
import type { Binding } from './unresolved-order';

/**
 * An inventory command whose outcome is unknown, kept in `sessionStorage` so
 * that a reload cannot turn "maybe done" back into a fresh form with a fresh
 * key — `lib/unresolved-return.ts`'s rules, for the operator commands of
 * `/inventory`.
 *
 * ## Why a fresh key is not safe here
 *
 * A receipt or an adjustment sent under key K can commit unseen; the same
 * quantity sent again under a new key moves stock **a second time**, and a
 * warehouse or a shipment created twice is a second warehouse or shipment. Only
 * the original key with the original body is answered by the service's stored
 * response (`INVENTORY_IDEMPOTENCY_TTL_HOURS`) instead of being executed again.
 * A dispatch or a delivery repeated under a new key is refused by the state it
 * left behind, but its outcome is just as unknown until the page is read again,
 * so it is held the same way.
 *
 * ## What is kept
 *
 * Per slot — the warehouse list, one warehouse, one shipment — the command,
 * the submission id, a typed command's body exactly as it was sent (what makes
 * the retry the same request), the original correlation id, when it was saved,
 * and its replay stamp (`server/inventory-replay.ts`, a signed deadline, not a
 * credential), with the two one-way login tags (`submissionBinding`). No token,
 * no session value, no CSRF value.
 *
 * ## One unresolved command per slot, never replaced
 *
 * The receipt, the adjustment and the new-shipment forms of a warehouse share
 * its slot, and a shipment's dispatch and delivery share its own: a new
 * submission never **replaces** another submission's record — saving it is
 * refused (`HELD`) and the form is not sent — and a record is cleared only by
 * the submission it belongs to, on a definite outcome of that submission. Every
 * change is announced to the page's other forms (`subscribeUnresolvedInventory`),
 * which stay view-only while another command holds the slot.
 *
 * ## Never silently gone
 *
 * An entry older than the session's lifetime, and every entry at logout, is
 * **reduced** to a marker — no body, no login tag, no stamp — shown view-only
 * as "the outcome is unknown" until the person acknowledges it. A confirmed
 * answer (the action redirects) drops it; otherwise only the person does.
 * Another person's page drops every entry of anyone else
 * (`purgeForeignUnresolvedInventory`).
 */

const KEY_PREFIX = 'rasta.unresolved-inventory.';
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

/** A fresh submission id for one inventory form, with its signed replay deadline. */
export interface InventorySubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedInventory {
  readonly command: InventoryCommand;
  readonly submissionId: string;
  /** A typed command's body as sent; null for a shipment move, and in a marker. */
  readonly body: InventoryBody | null;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: nothing re-sendable is kept. */
  readonly marker: boolean;
}

type Stored = Omit<UnresolvedInventory, 'marker'> & {
  readonly v: typeof VERSION;
  readonly marker: boolean;
  readonly scope: string;
  readonly owner: string;
  readonly session?: string;
};

export type RestoredInventory =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly entry: UnresolvedInventory }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly entry: UnresolvedInventory };

let accountClosing = false;

/** Same-tab listeners: the forms of a page, told when a slot changes (`sessionStorage` is per tab). */
const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedInventory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markInventoryClosing(): void {
  accountClosing = true;
}

export function markInventoryOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeOf(scope: InventoryScope): string {
  switch (scope.kind) {
    case 'WAREHOUSES':
      return 'warehouses';
    case 'WAREHOUSE':
      return `warehouse.${scope.warehouseId}`;
    case 'SHIPMENT':
      return `shipment.${scope.shipmentId}`;
  }
}

function keyOf(scope: InventoryScope): string {
  return `${KEY_PREFIX}${scopeOf(scope)}`;
}

/** Which commands a slot holds (`SCOPE_COMMANDS`). */
function belongs(scope: string, command: InventoryCommand): boolean {
  const kind: InventoryScope['kind'] = scope.startsWith('warehouse.')
    ? 'WAREHOUSE'
    : scope.startsWith('shipment.')
      ? 'SHIPMENT'
      : 'WAREHOUSES';
  return SCOPE_COMMANDS[kind].includes(command);
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

/**
 * A kept body, read the way the form reads what it sends: the same parser, on
 * the values the body spells, so a stored body that the action would refuse is
 * dropped as unreadable rather than re-sent. A shipment move keeps none.
 */
function bodyOf(command: InventoryCommand, value: unknown): InventoryBody | null | undefined {
  if (!hasFields(command)) return value === null ? null : undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const parsed = parseInventoryForm(command, valuesOfBody(command, value as InventoryBody));
    return parsed.ok ? parsed.body : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a body, spelled as the retry spells it and read again, is the same body. */
function roundTrips(command: InventoryCommand, body: InventoryBody | null): boolean {
  if (!hasFields(command)) return body === null;
  if (body === null) return false;
  const again = bodyOf(command, JSON.parse(JSON.stringify(body)));
  return again !== undefined && JSON.stringify(again) === JSON.stringify(body);
}

function parse(raw: string, scope: string): Stored | null {
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
    entry.scope !== scope ||
    !isInventoryCommand(entry.command) ||
    !belongs(scope, entry.command) ||
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
    scope,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  } as const;
  if (entry.marker === true) return { ...common, marker: true, replay: null, body: null };

  const replay = replayOf(entry.replay);
  const body = bodyOf(entry.command, entry.body);
  // The command is known to have been sent but its record cannot be read back
  // as something re-sendable: that is "outcome unknown", never "nothing sent" —
  // it is held as a marker, not dropped, so no fresh key is offered over it.
  if (entry.marker !== false || !tag(entry.session) || replay === undefined || body === undefined) {
    return { ...common, marker: true, replay: null, body: null };
  }
  return { ...common, marker: false, session: entry.session, replay, body };
}

/** What a marker keeps: nothing of the body, the login or the stamp. */
function markerOf(entry: Stored): string {
  return JSON.stringify({
    v: VERSION,
    marker: true,
    scope: entry.scope,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  });
}

function ownKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function stored(store: Storage, key: string): Stored | null {
  const raw = store.getItem(key);
  return raw === null ? null : parse(raw, key.slice(KEY_PREFIX.length));
}

/** Logout: every entry reduced to a marker; unreadable ones removed. */
export function purgeAllUnresolvedInventory(): void {
  markInventoryClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) {
      const entry = stored(store, key);
      if (entry) store.setItem(key, markerOf(entry));
      else store.removeItem(key);
    }
  } catch {
    // Unavailable storage holds nothing to purge.
  }
  changed();
}

/** A page for `owner`: entries of anyone else, and unreadable ones, are removed. */
export function purgeForeignUnresolvedInventory(owner: string): void {
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) {
      const entry = stored(store, key);
      if (!entry || entry.owner !== owner) store.removeItem(key);
    }
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

export function saveUnresolvedInventory(
  scope: InventoryScope,
  entry: Omit<UnresolvedInventory, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): SaveOutcome {
  if (accountClosing) return 'UNAVAILABLE';
  try {
    const store = storage();
    if (!store) return 'UNAVAILABLE';
    const key = keyOf(scope);
    if (!belongs(scopeOf(scope), entry.command)) return 'UNAVAILABLE';
    const parsed = stored(store, key);
    // Someone else's is not this person's to keep (`purgeForeignUnresolvedInventory`).
    const earlier = parsed?.owner === binding.owner ? parsed : null;
    // Another submission's record — even a marker — is never replaced.
    if (earlier !== null && earlier.submissionId !== entry.submissionId) return 'HELD';
    // A body that would not be read back as itself cannot be retried as the
    // same request: it is not sent at all.
    if (!roundTrips(entry.command, entry.body)) return 'UNAVAILABLE';
    // A marker is never turned back into something that can be re-sent.
    if (earlier?.marker) return 'SAVED';
    const same = earlier !== null;
    store.setItem(
      key,
      JSON.stringify({
        v: VERSION,
        marker: false,
        scope: scopeOf(scope),
        command: entry.command,
        submissionId: entry.submissionId,
        // The body is the first send's, whatever a later answer carries.
        body: same ? earlier.body : entry.body,
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
 * submission holds stays. An unreadable record is left to
 * `restoreUnresolvedInventory`, which removes it.
 */
export function clearUnresolvedInventory(scope: InventoryScope, submissionId: string): void {
  try {
    const store = storage();
    if (!store) return;
    const entry = stored(store, keyOf(scope));
    if (entry?.submissionId !== submissionId) return;
    store.removeItem(keyOf(scope));
  } catch {
    // See above.
    return;
  }
  changed();
}

/**
 * The unresolved inventory command in this slot, if this person has one.
 * Unreadable, or someone else's: removed, read as none. Older than the
 * session's lifetime: reduced to the marker, and read as that — never as none.
 */
export function restoreUnresolvedInventory(
  scope: InventoryScope,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredInventory | null {
  try {
    const store = storage();
    const key = keyOf(scope);
    if (!store || store.getItem(key) === null) return null;

    const entry = stored(store, key);
    if (!entry || entry.owner !== binding.owner) {
      store.removeItem(key);
      return null;
    }
    const { command, submissionId, correlationId, savedAt } = entry;
    if (entry.marker || now - savedAt > maxAgeSeconds * 1000) {
      if (!entry.marker) store.setItem(key, markerOf(entry));
      return {
        kind: 'VIEW_ONLY',
        entry: {
          command,
          submissionId,
          correlationId,
          savedAt,
          body: null,
          replay: null,
          marker: true,
        },
      };
    }
    const restored: UnresolvedInventory = {
      command,
      submissionId,
      body: entry.body,
      correlationId,
      savedAt,
      replay: entry.replay,
      marker: false,
    };
    const retryable =
      entry.session === binding.session && entry.replay !== null && now < entry.replay.until;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', entry: restored };
  } catch {
    return null;
  }
}
