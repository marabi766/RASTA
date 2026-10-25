/**
 * Whose an unresolved submission is, for every store that keeps one in
 * `sessionStorage` (`lib/unresolved-order.ts`, `-dispute`, `-return`,
 * `-statement`, `-contract-command`, `-bid`, `-tender-command`) — one rule,
 * here, so the seven cannot drift apart (task 100).
 *
 * ## Per person and organization
 *
 * An entry is stored under a key that names its person and its owner — this
 * person acting for this organization (`submissionBinding`):
 * `<prefix>@<person>.<owner>.<scope>`. So the same person's entries for two
 * organizations never share a key, and:
 *
 * - a page for organization B neither shows nor resolves A's entry — it never
 *   reads A's key;
 * - nothing is removed by a switch: back on A, every entry A left is still
 *   there, with whatever it may still do (a retry under its own key and stamp)
 *   and nothing more;
 * - another person's page reduces every entry that is not its person's to a
 *   content-free marker — the account boundary `AccountBoundary` draws — and a
 *   logout reduces them too: content goes, the unknown outcome stays (below).
 *
 * ## Entries written before this
 *
 * An entry under the old key, `<prefix><scope>`, names an owner tag computed
 * from the login's organization, while the request it remembers acted for the
 * token's — which a switch made elsewhere could already have moved. It cannot
 * say which organization it was sent for, so it is never retagged and never
 * guessed: it is kept for its person (its tag is one of `binding.legacy`), held
 * against a fresh submission in its scope, and only ever shown view-only — the
 * same "the outcome is unknown, check before acting" view a record from an
 * earlier login gets.
 *
 * ## What cannot be attributed: quarantined, never removed (PR 405 review 2, F1)
 *
 * An old entry's owner tag is a one-way digest of a person and the organization
 * it was written under; it holds no person id. Its person recognises it only
 * while their token still lists that organization (`binding.legacy`), so once
 * the membership has ended — or for anyone else — it cannot be told whose it
 * is. It is then **quarantined**, for everybody on this device (this tab's
 * `sessionStorage`), and so is everything else under a store's prefix that is
 * not the page person's own (`ownEntry`): an entry that does not read, a key
 * that does not parse, another person's entry, and the content-free marker an
 * entry is reduced to (`QUARANTINE_MARK`).
 *
 * - **Never removed, never overwritten.** An entry that cannot be attributed
 *   stays exactly as it is. Where an account boundary, a logout or an expiry
 *   must drop content (another person's offer, quantity or text), the entry is
 *   reduced to a marker with nothing in it but the time — the content goes,
 *   the fact that an outcome is unknown stays. A save never writes over one:
 *   a key that holds one is moved aside first, byte for byte (`relocate`).
 * - **Never shown, never sent, never guessed into a tenant.** Its content is
 *   not read for display; nothing re-sends it.
 * - **It holds its kind.** While one is held for the page's person, no fresh
 *   submission of that store's kind is saved — so none is sent — and the form
 *   is replaced by a fixed warning (`app/UnresolvedQuarantine.tsx`).
 * - **Release.** Only by the person's explicit acknowledgement of the duplicate
 *   risk, fenced to the exact records the warning was drawn for (key and bytes,
 *   `acknowledge`): it lifts the hold **for that person**, resends nothing, and
 *   removes nothing — another person on the device is still warned. A record
 *   that changed after the warning was drawn is not covered. The one other
 *   release is the owner service's answer to THAT request, which only an entry
 *   that verifies for its person can receive (its own form, under its own key
 *   and stamp): a retry's refusal, or a list that does not show it, is neither.
 */

/** The tags the page computed for this person, organization and login (`server/submission.ts`). */
export interface Binding {
  readonly person: string;
  readonly owner: string;
  readonly session: string;
  /** Owner tags an entry stored under the old key may carry for this person. */
  readonly legacy: readonly string[];
}

/** What an account boundary needs: who the page is for, whatever organization. */
export type AccountTags = Pick<Binding, 'person' | 'legacy'>;

const TAG = /^[A-Za-z0-9_-]{1,128}$/;

/** Under a store's prefix: a quarantined record that is no entry of anyone's (`quarantine`, `relocate`). */
export const QUARANTINE_MARK = '!q.';
/** Under a store's prefix: what one person acknowledged (`acknowledge`). */
const ACK_MARK = '!ack.';

/** A quarantined record, exactly: where it is and what it holds. */
export interface Held {
  readonly key: string;
  readonly raw: string;
}

/** How a store reads one of its entries; null when it does not read. */
export type EntryParser<E extends { readonly owner: string }> = (
  raw: string,
  key: StoredKey,
) => E | null;

/** The key an entry for `scope` is stored under, for this person and organization. */
export function tenantKey(
  prefix: string,
  binding: Pick<Binding, 'person' | 'owner'>,
  scope: string,
) {
  return `${prefix}@${binding.person}.${binding.owner}.${scope}`;
}

/** The key an entry for `scope` was stored under before entries were kept per organization. */
export function legacyKey(prefix: string, scope: string): string {
  return `${prefix}${scope}`;
}

export type StoredKey =
  | {
      readonly kind: 'TENANT';
      readonly person: string;
      readonly owner: string;
      readonly scope: string;
    }
  | { readonly kind: 'LEGACY'; readonly scope: string };

/** What a key under `prefix` names; null when it is not one of this store's keys or does not parse. */
export function storedKeyOf(prefix: string, key: string): StoredKey | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  // A quarantine marker or an acknowledgement: no entry of anyone's.
  if (rest.startsWith('!')) return null;
  if (!rest.startsWith('@')) return rest.length > 0 ? { kind: 'LEGACY', scope: rest } : null;
  const [person, owner, ...scope] = rest.slice(1).split('.');
  if (!person || !owner || !TAG.test(person) || !TAG.test(owner) || scope.length === 0) return null;
  const joined = scope.join('.');
  return joined.length > 0 ? { kind: 'TENANT', person, owner, scope: joined } : null;
}

/**
 * Whether an entry whose content names `entryOwner`, under `key`, is this
 * person's own: under a key of theirs (any organization), or an old-format
 * entry carrying one of their old tags. Anything else — another person's,
 * unreadable, a key that disagrees with its content — is quarantined for them
 * (see above), never removed.
 */
export function keptFor(tags: AccountTags, key: StoredKey, entryOwner: string): boolean {
  if (key.kind === 'LEGACY') return tags.legacy.includes(entryOwner);
  return key.person === tags.person && key.owner === entryOwner;
}

/** Every key under `prefix`, in the order storage lists them. */
export function keysUnder(store: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** The person's own entry, readable and under a key that agrees with it (`keptFor`). */
export function ownEntry<E extends { readonly owner: string }>(
  prefix: string,
  key: string,
  raw: string | null,
  tags: AccountTags,
  parse: EntryParser<E>,
): boolean {
  const located = storedKeyOf(prefix, key);
  const entry = located === null || raw === null ? null : parse(raw, located);
  return located !== null && entry !== null && keptFor(tags, located, entry.owner);
}

let sequence = 0;

/** A key no record has used: the time, a counter and a random part. */
function freshQuarantineKey(store: Storage, prefix: string, now: number): string {
  for (;;) {
    sequence += 1;
    const random = Math.floor(Math.random() * 2 ** 32).toString(36);
    const key = `${prefix}${QUARANTINE_MARK}${now.toString(36)}.${sequence.toString(36)}.${random}`;
    if (store.getItem(key) === null) return key;
  }
}

/**
 * Drops the content of the entry under `key` and keeps the fact that an
 * outcome is unknown: a marker with nothing in it but the time, under a key
 * that names nobody and no scope. For an entry whose content may not outlive
 * the moment (another person's, at an account boundary; anything at a logout;
 * an expired one).
 */
export function reduceToQuarantine(
  store: Storage,
  prefix: string,
  key: string,
  now: number = Date.now(),
): void {
  store.setItem(
    freshQuarantineKey(store, prefix, now),
    JSON.stringify({ v: 1, quarantined: true, at: now }),
  );
  store.removeItem(key);
}

/**
 * Moves the record under `key` aside, byte for byte, so the key can take a new
 * entry without writing over it; acknowledgements of it follow it.
 */
export function relocate(
  store: Storage,
  prefix: string,
  key: string,
  now: number = Date.now(),
): void {
  const raw = store.getItem(key);
  if (raw === null) return;
  const moved = freshQuarantineKey(store, prefix, now);
  store.setItem(moved, raw);
  for (const ackKey of keysUnder(store, `${prefix}${ACK_MARK}`)) {
    const acks = acknowledgements(store, ackKey);
    if (acks.some((ack) => ack.key === key && ack.raw === raw)) {
      store.setItem(
        ackKey,
        JSON.stringify(
          acks.map((ack) => (ack.key === key && ack.raw === raw ? { key: moved, raw } : ack)),
        ),
      );
    }
  }
  store.removeItem(key);
}

/**
 * Account boundary, a page for `tags`: another person's readable entry is
 * reduced to a marker (`reduceToQuarantine`) — its offer, quantity or text do
 * not stay for the next person, the fact that its outcome is unknown does.
 * The person's own, for every organization, stay; so does every record that
 * cannot be attributed, untouched — it may be this person's from an
 * organization their token no longer lists. Nothing is removed outright.
 */
export function purgeForeign<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
  now: number = Date.now(),
): void {
  for (const key of keysUnder(store, prefix)) {
    const located = storedKeyOf(prefix, key);
    const raw = store.getItem(key);
    if (located?.kind !== 'TENANT' || located.person === tags.person || raw === null) continue;
    if (parse(raw, located) !== null) reduceToQuarantine(store, prefix, key, now);
  }
}

/** Every record under `prefix` that is not this person's own entry: quarantined for them. */
export function quarantinedFor<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): Held[] {
  const held: Held[] = [];
  for (const key of keysUnder(store, prefix)) {
    if (key.startsWith(`${prefix}${ACK_MARK}`)) continue;
    const raw = store.getItem(key);
    if (raw !== null && !ownEntry(prefix, key, raw, tags, parse)) held.push({ key, raw });
  }
  return held;
}

function acknowledgements(store: Storage, ackKey: string): Held[] {
  try {
    const value: unknown = JSON.parse(store.getItem(ackKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is Held =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Held).key === 'string' &&
        typeof (item as Held).raw === 'string',
    );
  } catch {
    return [];
  }
}

/** The quarantined records this person has not acknowledged: what holds their next submission of this kind. */
export function heldFor<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): Held[] {
  const acks = acknowledgements(store, `${prefix}${ACK_MARK}${tags.person}`);
  return quarantinedFor(store, prefix, tags, parse).filter(
    (record) => !acks.some((ack) => ack.key === record.key && ack.raw === record.raw),
  );
}

/**
 * This person accepts the duplicate risk for exactly `fence` — the records the
 * warning was drawn for. Only those still there with the same bytes are
 * covered; nothing is removed or sent, and nobody else's hold is lifted.
 */
export function acknowledge(
  store: Storage,
  prefix: string,
  person: string,
  fence: readonly Held[],
): void {
  if (!TAG.test(person)) return;
  const ackKey = `${prefix}${ACK_MARK}${person}`;
  const still = (record: Held) => store.getItem(record.key) === record.raw;
  const kept = acknowledgements(store, ackKey).filter(still);
  const added = fence.filter(
    (record) =>
      record.key.startsWith(prefix) &&
      !record.key.startsWith(`${prefix}${ACK_MARK}`) &&
      still(record) &&
      !kept.some((ack) => ack.key === record.key && ack.raw === record.raw),
  );
  store.setItem(ackKey, JSON.stringify([...kept, ...added.map(({ key, raw }) => ({ key, raw }))]));
}

/**
 * Frees this page's own key for a new entry: a record there that is not this
 * person's readable entry (`ownEntry`) is moved aside first, never written over.
 */
export function freeOwnKey<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  key: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): void {
  const raw = store.getItem(key);
  if (raw !== null && !ownEntry(prefix, key, raw, tags, parse)) relocate(store, prefix, key);
}

/** What a form of one kind needs to know and do about quarantined records (`app/UnresolvedQuarantine.tsx`). */
export interface QuarantineSource {
  held(tags: AccountTags): readonly Held[];
  acknowledge(person: string, fence: readonly Held[]): void;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The quarantine of the store under `prefix`, read from this tab's `sessionStorage`. */
export function quarantineOf<E extends { readonly owner: string }>(
  prefix: string,
  parse: EntryParser<E>,
): QuarantineSource {
  return {
    held(tags) {
      try {
        const store = sessionStore();
        return store ? heldFor(store, prefix, tags, parse) : [];
      } catch {
        return [];
      }
    },
    acknowledge(person, fence) {
      try {
        const store = sessionStore();
        if (store) acknowledge(store, prefix, person, fence);
      } catch {
        // Unavailable storage: nothing acknowledged, the hold stays.
      }
    },
  };
}

/**
 * Where this page's entry for `scope` is: under this organization's key, or —
 * when there is none — under the old key, which is then `legacy` and may only
 * be shown. Null when neither holds anything.
 */
export function locate(
  store: Storage,
  prefix: string,
  binding: Binding,
  scope: string,
): { readonly key: string; readonly raw: string; readonly legacy: boolean } | null {
  const own = tenantKey(prefix, binding, scope);
  const raw = store.getItem(own);
  if (raw !== null) return { key: own, raw, legacy: false };
  const old = legacyKey(prefix, scope);
  const legacyRaw = store.getItem(old);
  return legacyRaw === null ? null : { key: old, raw: legacyRaw, legacy: true };
}

/**
 * Whether a fresh submission of this store's kind may be saved for `tags`:
 * nothing quarantined is held for them (`heldFor`). The save of an entry this
 * page already keeps — a late answer of the same submission — does not ask.
 */
export function mayStartFresh<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): boolean {
  return heldFor(store, prefix, tags, parse).length === 0;
}

/** Whether a located entry naming `entryOwner` is this page's to show. */
export function ownedHere(binding: Binding, legacy: boolean, entryOwner: string): boolean {
  return legacy ? binding.legacy.includes(entryOwner) : entryOwner === binding.owner;
}
