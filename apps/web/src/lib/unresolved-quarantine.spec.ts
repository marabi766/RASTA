/**
 * PR 405 review 2, F1: current membership is not historical ownership. An
 * entry written before entries were kept per organization carries an owner tag
 * computed from the organization it was written under; when that membership
 * has ended, nothing this person's token lists can recognise it — and it must
 * not be removed, shown, guessed into a tenant, or let a fresh submission of
 * its kind through unwarned. The seven stores, through one table, with
 * memberships that CHANGE between the save and the read: A and B when it was
 * written, B only when it is read.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { submissionBinding } =
  require('@/server/submission') as typeof import('@/server/submission');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
const { legacyKey, QUARANTINE_MARK, tenantKey } =
  require('./unresolved-tenancy') as typeof import('./unresolved-tenancy');
const { K1, K2, STORES } =
  require('@/test/unresolved-stores') as typeof import('@/test/unresolved-stores');
const { restoreUnresolvedOrder } =
  require('./unresolved-order') as typeof import('./unresolved-order');
/* eslint-enable @typescript-eslint/no-require-imports */

type Binding = import('./unresolved-tenancy').Binding;
type AccountTags = import('./unresolved-tenancy').AccountTags;
type WebSession = import('@/server/session').WebSession;

const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';

function sessionFor(acting: string, memberships: string[], subject = 'USR_1'): WebSession {
  return {
    subject,
    username: 'u',
    organizationId: acting,
    accessToken: actingAccessToken(acting, ['ORGANIZATION_ADMIN'], { org_ids: memberships }),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'one-login',
    issuedAt: 1_900_000_000,
  };
}

/** When the entry was written: a member of A and B, acting for A. */
const then = submissionBinding(sessionFor(A, [A, B]));
/** When it is read: A's membership has ended; the token lists B only. */
const now = submissionBinding(sessionFor(B, [B]));
/** Another person on the same device. */
const other = submissionBinding(sessionFor(B, [B], 'USR_2'));
const tagsOf = (binding: Binding): AccountTags => ({
  person: binding.person,
  legacy: binding.legacy,
});

beforeEach(() => {
  window.sessionStorage.clear();
  for (const store of STORES) store.open();
});

it('the reader cannot recognise the entry: its tag is not among the ones its token lists', () => {
  expect(now.person).toBe(then.person);
  expect(now.legacy).not.toContain(then.owner);
});

describe.each(STORES)('the $name store, A’s membership ended between save and read', (store) => {
  const old = () => legacyKey(store.prefix, store.scope);

  /** Written by the old code for A: the same content, under the key with no person or owner. */
  function legacyEntry(): string {
    store.save(then, K1);
    const key = tenantKey(store.prefix, then, store.scope);
    const raw = window.sessionStorage.getItem(key)!;
    window.sessionStorage.removeItem(key);
    window.sessionStorage.setItem(old(), raw);
    return raw;
  }

  it('cleanup (the account boundary on B) keeps it byte for byte', () => {
    const raw = legacyEntry();
    store.purgeForeign(tagsOf(now));
    expect(window.sessionStorage.getItem(old())).toBe(raw);
  });

  it('restoration on B keeps it byte for byte, and shows none of it', () => {
    const raw = legacyEntry();
    expect(store.restore(now)).toBeNull();
    expect(window.sessionStorage.getItem(old())).toBe(raw);
  });

  it('a fresh submission of its kind is not sent over it unacknowledged', () => {
    const raw = legacyEntry();
    store.restore(now);
    expect(store.save(now, K2)).not.toBe('SAVED');
    expect(window.sessionStorage.getItem(old())).toBe(raw);
  });

  /** The store's quarantine, the way the form's gate reads it. */
  const quarantine = () => store.quarantine;
  const heldNow = (binding: Binding) => store.quarantine.held(tagsOf(binding));

  it('is held for every person on the device — this one and another — and shown to none', () => {
    const raw = legacyEntry();
    expect(heldNow(now)).toEqual([{ key: old(), raw }]);
    expect(heldNow(other)).toEqual([{ key: old(), raw }]);
    expect(store.restore(other)).toBeNull();
    expect(store.save(other, K2)).not.toBe('SAVED');
  });

  it('released only by this person’s acknowledgement, fenced to the exact record: nothing removed, nothing sent, nobody else released', () => {
    const raw = legacyEntry();
    const fence = heldNow(now);
    quarantine().acknowledge(now.person, fence);
    expect(heldNow(now)).toEqual([]);
    // The record itself stays, byte for byte, and still holds another person.
    expect(window.sessionStorage.getItem(old())).toBe(raw);
    expect(heldNow(other)).toEqual([{ key: old(), raw }]);
    // This person may now start a fresh one — under their own key, never over it.
    expect(store.save(now, K2)).toBe('SAVED');
    expect(window.sessionStorage.getItem(old())).toBe(raw);
    expect(store.restore(now)?.id).toBe(K2);
  });

  it('an acknowledgement covers only what it was drawn for: a record that changed, or a new one, holds again', () => {
    const raw = legacyEntry();
    const fence = heldNow(now);
    // The record changes between drawing the warning and the acknowledgement.
    window.sessionStorage.setItem(old(), `${raw} `);
    quarantine().acknowledge(now.person, fence);
    expect(heldNow(now)).toEqual([{ key: old(), raw: `${raw} ` }]);
    // An acknowledgement for a record that is gone covers nothing that comes later.
    window.sessionStorage.setItem(old(), raw);
    quarantine().acknowledge(now.person, heldNow(now));
    window.sessionStorage.setItem(`${store.prefix}${QUARANTINE_MARK}later`, '{"v":1}');
    expect(heldNow(now)).toEqual([
      { key: `${store.prefix}${QUARANTINE_MARK}later`, raw: '{"v":1}' },
    ]);
  });

  it('an acknowledgement is of those bytes: the same key holding something else holds again', () => {
    const raw = legacyEntry();
    quarantine().acknowledge(now.person, heldNow(now));
    expect(heldNow(now)).toEqual([]);
    window.sessionStorage.setItem(old(), `${raw} `);
    expect(heldNow(now)).toEqual([{ key: old(), raw: `${raw} ` }]);
  });

  it('the person’s own “set it aside” leaves it: only what is theirs is cleared', () => {
    const raw = legacyEntry();
    store.clear(now, K1);
    expect(window.sessionStorage.getItem(old())).toBe(raw);
  });

  it('logout leaves it byte for byte', () => {
    const raw = legacyEntry();
    store.purgeAll();
    store.open();
    expect(window.sessionStorage.getItem(old())).toBe(raw);
    expect(store.save(now, K2)).not.toBe('SAVED');
  });
});

/**
 * Every other way a record could go (PM addenda, task 102): what does not read,
 * a save over a key that holds something else, a logout, another person's page,
 * an expiry and a late answer. Nothing is removed outright; content goes only
 * into a content-free marker; the unknown outcome always holds.
 */
describe.each(STORES)('the $name store: no path removes an unknown outcome', (store) => {
  const own = (binding: Binding) => tenantKey(store.prefix, binding, store.scope);
  const all = () =>
    Object.keys(window.sessionStorage)
      .filter((key) => key.startsWith(store.prefix) && !key.startsWith(`${store.prefix}!ack.`))
      .sort();

  it.each([
    ['under the old key, not JSON', (prefix: string) => legacyKey(prefix, 'X'), '{not json'],
    ['under the old key, another version', (prefix: string) => legacyKey(prefix, 'X'), '{"v":99}'],
    ['under a key that does not parse', (prefix: string) => `${prefix}@onlyone`, '{"v":1}'],
    [
      'under this person’s own key, not readable',
      (prefix: string) => tenantKey(prefix, now, 'ELSEWHERE'),
      '{"v":"unreadable"}',
    ],
  ])('a record %s: kept byte for byte by every path, and holds', (_label, keyOf, raw) => {
    const key = keyOf(store.prefix);
    window.sessionStorage.setItem(key, raw);
    store.purgeForeign(tagsOf(now));
    store.restore(now);
    store.purgeForeign(tagsOf(other));
    expect(window.sessionStorage.getItem(key)).toBe(raw);
    expect(store.save(now, K2)).not.toBe('SAVED');
    store.purgeAll();
    store.open();
    expect(window.sessionStorage.getItem(key)).toBe(raw);
  });

  it('a save never writes over what this page’s own key holds: moved aside byte for byte, acknowledgement and all', () => {
    // The page's own key holds something that is not this person's readable entry.
    window.sessionStorage.setItem(own(now), '{"v":"corrupt"}');
    expect(store.save(now, K2)).not.toBe('SAVED');
    store.quarantine.acknowledge(now.person, [{ key: own(now), raw: '{"v":"corrupt"}' }]);
    expect(store.save(now, K2)).toBe('SAVED');
    const moved = all().filter((key) => key.startsWith(`${store.prefix}${QUARANTINE_MARK}`));
    expect(moved).toHaveLength(1);
    expect(window.sessionStorage.getItem(moved[0]!)).toBe('{"v":"corrupt"}');
    // The acknowledgement followed it: this person is not asked again for it.
    expect(store.save(now, K2)).toBe('SAVED');
  });

  it('another person’s page: the content goes, a marker stays and holds', () => {
    store.save(then, K1);
    store.purgeForeign(tagsOf(other));
    const keys = all();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith(`${store.prefix}${QUARANTINE_MARK}`)).toBe(true);
    expect(store.save(other, K2)).not.toBe('SAVED');
  });

  it('a logout leaves nothing that can be sent again, and removes nothing outright', () => {
    store.save(then, K1);
    expect(all()).toHaveLength(1);
    store.purgeAll();
    store.open();
    expect(all()).toHaveLength(1);
    expect(store.restore(then)?.kind ?? 'GONE').not.toBe('RETRYABLE');
  });

  it('a late answer of a submission already kept is stored even while something is held', () => {
    store.save(now, K1, null);
    window.sessionStorage.setItem(legacyKey(store.prefix, 'ELSEWHERE'), '{not json');
    expect(store.save(now, K1, 'COR_LATE')).toBe('SAVED');
    expect(store.restore(now)?.id).toBe(K1);
  });

  it('a record that verifies for this person keeps today’s behaviour: not quarantined for them', () => {
    // Written under A while A is still listed: its old tag is one of this person's.
    const raw = (() => {
      store.save(then, K1);
      const key = own(then);
      const value = window.sessionStorage.getItem(key)!;
      window.sessionStorage.removeItem(key);
      window.sessionStorage.setItem(legacyKey(store.prefix, store.scope), value);
      return value;
    })();
    const stillMember = submissionBinding(sessionFor(B, [A, B]));
    expect(store.restore(stillMember)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
    expect(store.quarantine.held(tagsOf(stillMember))).toEqual([]);
    expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(raw);
  });
});

it.each(STORES.map((store) => [store.name, store] as const))(
  'the %s store: the same login’s old cookie copy makes its old entry this person’s — recognised, never quarantined',
  (_name, store) => {
    // The build before task 100 tagged this login's entry with its login organization A; the
    // session, brought into step, acts for B only and keeps A as its former copy (`session.ts`).
    store.save(then, K1);
    const key = tenantKey(store.prefix, then, store.scope);
    const raw = window.sessionStorage.getItem(key)!;
    window.sessionStorage.removeItem(key);
    window.sessionStorage.setItem(legacyKey(store.prefix, store.scope), raw);
    const sameLogin = submissionBinding({ ...sessionFor(B, [B]), formerOrganizationId: A });
    expect(sameLogin.legacy).toContain(then.owner);
    expect(store.quarantine.held(tagsOf(sameLogin))).toEqual([]);
    expect(store.restore(sameLogin)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
    // Without that copy (a new login) it is quarantined, as above.
    expect(store.quarantine.held(tagsOf(now))).toHaveLength(1);
  },
);

it('an expired order is reduced to a marker that holds, never removed', () => {
  const order = STORES.find(({ name }) => name === 'order')!;
  order.save(now, K1);
  // Read long after: past the session's lifetime.
  expect(restoreUnresolvedOrder('PRD_1', now, 60, Date.now() + 10 * 60 * 1000)).toBeNull();
  const keys = Object.keys(window.sessionStorage);
  expect(keys).toHaveLength(1);
  expect(keys[0]!.startsWith(`${order.prefix}${QUARANTINE_MARK}`)).toBe(true);
  expect(order.save(now, K2)).not.toBe('SAVED');
});

export {};
