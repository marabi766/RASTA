/**
 * PR 363 reviews 3 and 4, for every store through one table
 * (`src/test/unresolved-stores.ts`): which send an answer belongs to.
 *
 * A re-send goes under the first send's key, so the submission id cannot tell
 * their answers apart, and an earlier send's answer may arrive after a later
 * send left (navigate away while it is out, come back, send the same request
 * again). If the service refused the earlier send and released its key, the
 * later one may commit with its answer lost; the earlier refusal, arriving
 * last, must then remove nothing (review 3). The same holds when the record
 * was set aside or settled in between and made again under the same key from
 * cached form props (review 4): a count restarting at 1 for every new record
 * cannot tell the two first sends apart. So every send has an identity the
 * slot mints — 128 random bits, never derived from a count — written into the
 * entry before it leaves; only that identity's answer may touch it.
 */

import { K1, K2, STORES, type StoreUnderTest } from '@/test/unresolved-stores';
import { QUARANTINE_MARK, tenantKey, type Attempt, type Binding } from './unresolved-tenancy';

const inA: Binding = { person: 'PERSON1', owner: 'OWNER_A', session: 'LOGIN1', legacy: [] };
const inB: Binding = { ...inA, owner: 'OWNER_B' };
const laterLogin: Binding = { ...inA, session: 'LOGIN2' };
const IDENTITY = /^[0-9a-f]{32}$/;

/** Stores whose entries record the login they were sent under (the bid and owner stores keep markers from the start, with none). */
const LOGIN_BOUND = STORES.filter(
  (store) => store.name !== 'bid' && store.name !== 'tender owner command',
);

const slotKey = (store: StoreUnderTest, binding: Binding = inA) =>
  tenantKey(store.prefix, binding, store.scope);
const raw = (store: StoreUnderTest, binding: Binding = inA) =>
  window.sessionStorage.getItem(slotKey(store, binding));
const entry = (store: StoreUnderTest) => JSON.parse(raw(store)!) as Record<string, unknown>;
const setAside = (store: StoreUnderTest) =>
  Object.keys(window.sessionStorage).filter((key) =>
    key.startsWith(`${store.prefix}${QUARANTINE_MARK}`),
  );

beforeEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  for (const store of STORES) store.open();
});

describe.each(STORES)('$name', (store) => {
  it('the first send writes an identity of its own; every re-send records a new one before it leaves', () => {
    expect(store.save(inA, K1)).toBe('SAVED');
    const first = store.started(inA, K1);
    expect(first).toMatch(IDENTITY);
    expect(entry(store).attempt).toBe(first);
    const second = store.advance(inA, K1);
    expect(second).toMatch(IDENTITY);
    expect(entry(store).attempt).toBe(second);
    const third = store.advance(inA, K1);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(entry(store).attempt).toBe(third);
  });

  it("review 3's sequence: the first send's late refusal, after a re-send left, removes nothing", () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    expect(store.advance(inA, K1)).not.toBeNull();
    const before = raw(store);
    // The first send's definite refusal arrives last.
    store.settle(inA, K1, first, 'REFUSED');
    expect(raw(store)).toBe(before);
    // So does a first send's confirmed outcome: only the answer of the send that wrote it counts.
    store.settle(inA, K1, first, 'CONFIRMED');
    expect(raw(store)).toBe(before);
    expect(store.restore(inA)).toMatchObject({ id: K1 });
  });

  it("review 4's sequence: set aside, made again under the same key — the old send's late refusal keeps the new record", () => {
    // 1. Send K; its refusal is delayed (the server released the key).
    expect(store.save(inA, K1)).toBe('SAVED');
    const oldSend = store.started(inA, K1);
    // 2–3. The person sets the record aside (a middle-click keeps this document alive).
    store.clear(inA, K1);
    expect(raw(store)).toBeNull();
    // 4. Cached form props still carry K and its stamp: K is made again and sent.
    expect(store.save(inA, K1)).toBe('SAVED');
    const newSend = store.started(inA, K1);
    expect(newSend).not.toBe(oldSend);
    const recreated = raw(store);
    // 5. The old refusal arrives: it says nothing of the new send, which may have committed.
    store.settle(inA, K1, oldSend, 'REFUSED');
    expect(raw(store)).toBe(recreated);
    store.settle(inA, K1, oldSend, 'CONFIRMED');
    expect(raw(store)).toBe(recreated);
    // Nor does its late answer in doubt rewrite it.
    expect(store.answer(inA, K1, 'COR_OLD', oldSend)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(recreated);
    expect(store.restore(inA)).toMatchObject({ id: K1 });
    // The new send's own refusal still settles it.
    store.settle(inA, K1, newSend, 'REFUSED');
    expect(raw(store)).toBeNull();
  });

  it('settled, then made again under the same key: the earlier send’s answers touch nothing of the new record', () => {
    store.save(inA, K1);
    const oldSend = store.started(inA, K1);
    store.settle(inA, K1, oldSend, 'REFUSED');
    expect(raw(store)).toBeNull();
    store.save(inA, K1);
    const recreated = raw(store);
    store.settle(inA, K1, oldSend, 'REFUSED');
    expect(store.answer(inA, K1, 'COR_OLD', oldSend)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(recreated);
  });

  it('a re-send of the old record, then set aside and made again: neither earlier send settles the new record', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    const resend = store.advance(inA, K1)!;
    store.clear(inA, K1);
    store.save(inA, K1);
    const recreated = raw(store);
    store.settle(inA, K1, first, 'REFUSED');
    store.settle(inA, K1, resend, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_OLD', resend)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(recreated);
  });

  it('the send that wrote the entry still settles it', () => {
    store.save(inA, K1);
    store.settle(inA, K1, store.started(inA, K1), 'REFUSED');
    expect(raw(store)).toBeNull();

    store.save(inA, K2);
    const resend = store.advance(inA, K2)!;
    store.settle(inA, K2, resend, 'CONFIRMED');
    expect(raw(store)).toBeNull();
  });

  it("a late answer in doubt of an earlier send never rewrites a later send's entry", () => {
    store.save(inA, K1, null);
    const first = store.started(inA, K1);
    const second = store.advance(inA, K1)!;
    const before = raw(store);
    expect(store.answer(inA, K1, 'COR_FIRST', first)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(before);
    expect(setAside(store)).toEqual([]);
    // The newest send's answer in doubt updates it, under its own identity.
    expect(store.answer(inA, K1, 'COR_SECOND', second)).toBe('SAVED');
    expect(entry(store)).toMatchObject({ correlationId: 'COR_SECOND', attempt: second });
  });

  it('after a confirmed success, a late answer in doubt neither recreates the entry nor sets anything aside', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    store.settle(inA, K1, store.advance(inA, K1)!, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_LATE', first)).toBe('SUPERSEDED');
    expect(window.sessionStorage.length).toBe(0);
    expect(store.quarantine.held(inA)).toEqual([]);
  });

  it('after a refusal, or the person setting it aside, a late answer in doubt is kept aside — never written back into the slot', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    store.clear(inA, K1);
    expect(store.answer(inA, K1, 'COR_LATE', first)).toBe('SET_ASIDE');
    expect(raw(store)).toBeNull();
    expect(setAside(store)).toHaveLength(1);
  });

  it('advancing changes only the identity: body, stamp, time saved — and so expiry — stay the first send’s', () => {
    store.save(inA, K1);
    const before = entry(store);
    const next = store.advance(inA, K1);
    expect(entry(store)).toEqual({ ...before, attempt: next });
    expect(raw(store)).toBe(JSON.stringify({ ...before, attempt: next }));
  });

  it('an identity that cannot be recorded: null — the form sends nothing — and the entry as it was', () => {
    store.save(inA, K1);
    const before = raw(store);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(store.advance(inA, K1)).toBeNull();
    jest.restoreAllMocks();
    expect(raw(store)).toBe(before);
    // Nor once a logout has started.
    store.purgeAll();
    expect(store.advance(inA, K1)).toBeNull();
  });

  it('a first send whose entry does not read back: UNAVAILABLE — nothing is sent', () => {
    // A storage that drops the write without an error: the identity would be one no
    // record carries, so its refusal could settle nothing — and its record is not there.
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(store.save(inA, K1)).toBe('UNAVAILABLE');
    jest.restoreAllMocks();
    expect(raw(store)).toBeNull();
  });

  it('no cryptographic generator: nothing is saved — so nothing is sent — and no re-send is admitted', () => {
    store.save(inA, K2);
    const before = raw(store);
    jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('no generator');
    });
    expect(store.advance(inA, K2)).toBeNull();
    expect(raw(store)).toBe(before);
    window.sessionStorage.clear();
    expect(store.save(inA, K1)).toBe('UNAVAILABLE');
    expect(raw(store)).toBeNull();
  });

  it.each([
    ['none', undefined],
    ['a number (the r4 generation)', 1],
    ['a malformed identity', 'ABC'],
  ])(
    'an entry whose identity is %s is removed by no answer until a re-send stamps one',
    (_, written) => {
      store.save(inA, K1);
      const first = store.started(inA, K1);
      const older = entry(store);
      if (written === undefined) delete older.attempt;
      else older.attempt = written;
      window.sessionStorage.setItem(slotKey(store), JSON.stringify(older));
      const before = raw(store);
      store.settle(inA, K1, first, 'REFUSED');
      store.settle(inA, K1, first, 'CONFIRMED');
      store.settle(inA, K1, '1' as Attempt, 'REFUSED');
      expect(store.answer(inA, K1, 'COR_LATE', first)).toBe('SUPERSEDED');
      expect(store.answer(inA, K1, 'COR_LATE', null)).toBe('SUPERSEDED');
      expect(raw(store)).toBe(before);
      // Only a re-send from it, its identity recorded first, may then settle it.
      const resend = store.advance(inA, K1)!;
      expect(resend).toMatch(IDENTITY);
      store.settle(inA, K1, resend, 'CONFIRMED');
      expect(raw(store)).toBeNull();
    },
  );

  it('a send nothing remembered (null) touches no entry', () => {
    store.save(inA, K1);
    const before = raw(store);
    expect(store.answer(inA, K1, 'COR_LATE', null)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(before);
  });

  it('bound to the slot: another organization and another submission settle nothing', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    const before = raw(store);
    store.settle(inB, K1, first, 'REFUSED');
    store.settle(inA, K2, first, 'REFUSED');
    expect(store.advance(inB, K1)).toBeNull();
    expect(store.advance(inA, K2)).toBeNull();
    expect(raw(store)).toBe(before);
  });

  it("a replacement record: the earlier submission's late answers touch nothing of it", () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    store.clear(inA, K1);
    store.save(inA, K2);
    const replacement = raw(store);
    store.settle(inA, K1, first, 'REFUSED');
    store.settle(inA, K1, first, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_LATE', first)).toBe('SET_ASIDE');
    expect(raw(store)).toBe(replacement);
  });
});

describe.each(LOGIN_BOUND)('$name, bound to its login', (store) => {
  it('another login settles nothing and records no identity', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    const before = raw(store);
    store.settle(laterLogin, K1, first, 'REFUSED');
    store.settle(laterLogin, K1, first, 'CONFIRMED');
    expect(store.advance(laterLogin, K1)).toBeNull();
    expect(raw(store)).toBe(before);
  });

  it('after a logout reduced it (a marker in the slot, or set aside), no late answer removes, rewrites or recreates it', () => {
    store.save(inA, K1);
    const first = store.started(inA, K1);
    store.purgeAll();
    store.open();
    const reduced = raw(store);
    if (reduced !== null) expect(JSON.parse(reduced)).not.toHaveProperty('attempt');
    const snapshot = JSON.stringify(Object.entries(window.sessionStorage).sort());
    store.settle(inA, K1, first, 'REFUSED');
    store.settle(inA, K1, first, 'CONFIRMED');
    expect(JSON.stringify(Object.entries(window.sessionStorage).sort())).toBe(snapshot);
    store.answer(inA, K1, 'COR_LATE', first);
    expect(raw(store)).toBe(reduced);
  });
});

describe('identities are never reused', () => {
  it('across every store, 200 records made, set aside and made again under one key', () => {
    const seen = new Set<string>();
    for (const store of STORES) {
      for (let round = 0; round < 25; round += 1) {
        expect(store.save(inA, K1)).toBe('SAVED');
        seen.add(store.started(inA, K1));
        store.clear(inA, K1);
      }
    }
    expect(seen.size).toBe(STORES.length * 25);
    for (const identity of seen) expect(identity).toMatch(IDENTITY);
  });
});
