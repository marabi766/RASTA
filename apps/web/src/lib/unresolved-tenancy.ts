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
 * - another person's page removes every entry that is not its person's — the
 *   account boundary `AccountBoundary` draws — and a logout empties or reduces
 *   all of them, as before.
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
  if (!rest.startsWith('@')) return rest.length > 0 ? { kind: 'LEGACY', scope: rest } : null;
  const [person, owner, ...scope] = rest.slice(1).split('.');
  if (!person || !owner || !TAG.test(person) || !TAG.test(owner) || scope.length === 0) return null;
  const joined = scope.join('.');
  return joined.length > 0 ? { kind: 'TENANT', person, owner, scope: joined } : null;
}

/**
 * Whether an entry whose content names `entryOwner`, under `key`, is this
 * person's to keep: their own under a key of theirs (any organization), or an
 * old-format entry carrying one of their old tags. Anything else — another
 * person's, unreadable, a key that disagrees with its content — is removed.
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

/**
 * Account boundary, a page for `tags`: every entry under `prefix` that is not
 * this person's (`keptFor`), and every one that cannot be read, is removed.
 * The person's own, for every organization, stay.
 */
export function purgeForeign<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: (raw: string, key: StoredKey) => E | null,
): void {
  for (const key of keysUnder(store, prefix)) {
    const located = storedKeyOf(prefix, key);
    const raw = store.getItem(key);
    const entry = located === null || raw === null ? null : parse(raw, located);
    if (located === null || entry === null || !keptFor(tags, located, entry.owner)) {
      store.removeItem(key);
    }
  }
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

/** Whether a located entry naming `entryOwner` is this page's to show. */
export function ownedHere(binding: Binding, legacy: boolean, entryOwner: string): boolean {
  return legacy ? binding.legacy.includes(entryOwner) : entryOwner === binding.owner;
}
