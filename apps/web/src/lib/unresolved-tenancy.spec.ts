/**
 * Every unresolved store keeps its entries per person and organization (task
 * 100, PR 405 review 1 F1) — the seven of them, through one table, with the
 * tags the server really computes (`submissionBinding`) for one person who
 * acts for A, switches to B and comes back.
 *
 * - B's pages neither show nor resolve A's entry, and B's own entry in the same
 *   scope is not held by it;
 * - nothing of A's is removed by B's account boundary, and back on A it is all
 *   there, exactly as it could act before (retryable only where it was);
 * - an answer of A's that lands after the switch is A's, never B's;
 * - another person's page reduces everything to content-free markers, and a
 *   logout leaves nothing that can be sent again (task 102: nothing is removed
 *   outright — `unresolved-quarantine.spec.ts`);
 * - an entry from before entries were kept per organization is never retagged
 *   and never re-sent: shown view-only and holding its scope for its person,
 *   quarantined — never removed — for anyone else.
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
/* eslint-enable @typescript-eslint/no-require-imports */

type Binding = import('./unresolved-tenancy').Binding;
type AccountTags = import('./unresolved-tenancy').AccountTags;
type WebSession = import('@/server/session').WebSession;
type Kind = import('@/test/unresolved-stores').Kind;

const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';
function sessionFor(org: string, subject = 'USR_1'): WebSession {
  return {
    subject,
    username: 'u',
    organizationId: org,
    // A member of both: the token lists both, and acts for one.
    accessToken: actingAccessToken(org, ['ORGANIZATION_ADMIN'], { org_ids: [A, B] }),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'one-login',
    issuedAt: 1_900_000_000,
  };
}

const inA = submissionBinding(sessionFor(A));
const inB = submissionBinding(sessionFor(B));
const someoneElse = submissionBinding(sessionFor(A, 'USR_2'));
const tagsOf = (binding: Binding): AccountTags => ({
  person: binding.person,
  legacy: binding.legacy,
});

const keys = () => Object.keys(window.sessionStorage).sort();

beforeEach(() => {
  window.sessionStorage.clear();
  for (const store of STORES) store.open();
});

it('one person acting for A and for B: one person tag, two owners, two login tags', () => {
  expect(inB.person).toBe(inA.person);
  expect(inB.owner).not.toBe(inA.owner);
  expect(inB.session).not.toBe(inA.session);
  expect(someoneElse.person).not.toBe(inA.person);
  // Entries from before: either organization's old tag is this person's.
  expect(inB.legacy).toContain(inA.owner);
  expect(inB.legacy).not.toContain(someoneElse.owner);
});

describe.each(STORES)('the $name store', (store) => {
  const keyIn = (binding: Binding) => tenantKey(store.prefix, binding, store.scope);
  const retryable: Kind = store.retries ? 'RETRYABLE' : 'VIEW_ONLY';

  it('A → B → A: B neither shows nor clears A’s entry; back on A it is there as it was', () => {
    expect(store.save(inA, K1)).toBe('SAVED');

    // On B: not shown, and B's account boundary removes nothing of A's.
    expect(store.restore(inB)).toBeNull();
    store.purgeForeign(tagsOf(inB));
    expect(keys()).toEqual([keyIn(inA)]);
    // B's own command in the same scope is B's: not held by A's.
    expect(store.save(inB, K2)).toBe('SAVED');
    expect(store.restore(inB)).toEqual({ kind: retryable, id: K2 });
    // B setting its own aside never touches A's.
    store.clear(inB, K2);
    store.clear(inB, K1);
    expect(keys()).toEqual([keyIn(inA)]);

    // Back on A: the same entry, with what it could do before — and no more.
    store.purgeForeign(tagsOf(inA));
    expect(store.restore(inA)).toEqual({ kind: retryable, id: K1 });
  });

  it('an answer of A’s that lands after the switch is stored as A’s, never shown on B', () => {
    // B's page is up; A's form, still mounted elsewhere, gets its late answer.
    expect(store.restore(inB)).toBeNull();
    store.save(inA, K1, null);
    store.save(inA, K1, 'COR_LATE');
    expect(store.restore(inB)).toBeNull();
    expect(keys()).toEqual([keyIn(inA)]);
    expect(store.restore(inA)?.id).toBe(K1);
  });

  it('another person’s page reduces every entry of this person to a content-free marker', () => {
    store.save(inA, K1);
    store.save(inB, K2);
    store.purgeForeign(tagsOf(someoneElse));
    // Nothing of either entry stays readable — not the content, not the scope, not the tags.
    expect(keys()).toHaveLength(2);
    for (const key of keys()) {
      expect(key.startsWith(`${store.prefix}${QUARANTINE_MARK}`)).toBe(true);
      const raw = window.sessionStorage.getItem(key)!;
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'g', 'quarantined', 'v']);
      for (const kept of [K1, K2, inA.owner, inB.owner, inA.person, store.scope]) {
        expect(`${key} ${raw}`).not.toContain(kept);
      }
    }
    // The fact that two outcomes are unknown stays: the next person is held by both.
    expect(store.save(someoneElse, K2)).not.toBe('SAVED');
  });

  it('a logout leaves nothing that can be sent again, in either organization', () => {
    store.save(inA, K1);
    store.save(inB, K2);
    store.purgeAll();
    store.open();
    for (const binding of [inA, inB]) {
      expect(store.restore(binding)?.kind ?? 'GONE').not.toBe('RETRYABLE');
    }
  });

  describe('an entry from before entries were kept per organization', () => {
    /** Written by the old code: the same content, under the key with no person or owner. */
    function legacyEntry(binding: Binding, id: string): string {
      store.save(binding, id);
      const raw = window.sessionStorage.getItem(keyIn(binding))!;
      window.sessionStorage.removeItem(keyIn(binding));
      window.sessionStorage.setItem(legacyKey(store.prefix, store.scope), raw);
      return raw;
    }

    it('is shown view-only in either organization — never re-sent, even by the login that wrote it', () => {
      const raw = legacyEntry(inA, K1);
      expect(store.restore(inA)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
      expect(store.restore(inB)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
      // Never retagged.
      expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(raw);
    });

    if (store.holds) {
      it('holds its scope: no other submission is sent over it', () => {
        legacyEntry(inA, K1);
        expect(store.save(inB, K2)).not.toBe('SAVED');
        expect(store.save(inA, K1)).not.toBe('SAVED');
        expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      });
    }

    it('is kept by this person’s pages and by another person’s, byte for byte', () => {
      const raw = legacyEntry(inA, K1);
      store.purgeForeign(tagsOf(inB));
      expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      // Another person cannot tell whose it is: quarantined, never removed.
      store.purgeForeign(tagsOf(someoneElse));
      expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(raw);
    });

    it('another person’s is not shown, and is kept byte for byte', () => {
      const raw = legacyEntry(someoneElse, K1);
      expect(store.restore(inA)).toBeNull();
      expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(raw);
    });
  });
});

export {};
