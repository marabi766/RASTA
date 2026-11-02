/**
 * PR 363 review 3, finding 1, for every store through one table
 * (`src/test/unresolved-stores.ts`): which send an answer belongs to.
 *
 * A re-send goes under the first send's key, so the submission id cannot tell
 * their answers apart, and the first send's answer may arrive after a re-send
 * left (navigate away while it is out, come back, send the same request
 * again). If the service refused the first send and released its key, the
 * re-send may commit with its answer lost; the first send's refusal, arriving
 * last, must then remove nothing. Every entry carries the generation of its
 * newest send (`lib/unresolved-tenancy.ts`), written before the send leaves;
 * only that generation's answer may touch it (PM addenda B–F).
 */

import { K1, K2, STORES, type StoreUnderTest } from '@/test/unresolved-stores';
import {
  FIRST_ATTEMPT,
  QUARANTINE_MARK,
  tenantKey,
  type Attempt,
  type Binding,
} from './unresolved-tenancy';

const inA: Binding = { person: 'PERSON1', owner: 'OWNER_A', session: 'LOGIN1', legacy: [] };
const inB: Binding = { ...inA, owner: 'OWNER_B' };
const laterLogin: Binding = { ...inA, session: 'LOGIN2' };
const SECOND = (FIRST_ATTEMPT + 1) as Attempt;

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
  it('the first send writes generation 1; a re-send records the next one before it leaves', () => {
    expect(store.save(inA, K1)).toBe('SAVED');
    expect(entry(store).attempt).toBe(1);
    expect(store.advance(inA, K1)).toBe(2);
    expect(entry(store).attempt).toBe(2);
    expect(store.advance(inA, K1)).toBe(3);
  });

  it("Codex's sequence: the first send's late refusal, after a re-send left, removes nothing", () => {
    store.save(inA, K1);
    expect(store.advance(inA, K1)).toBe(SECOND);
    const before = raw(store);
    // The first send's definite refusal arrives last.
    store.settle(inA, K1, FIRST_ATTEMPT, 'REFUSED');
    expect(raw(store)).toBe(before);
    // So does a first send's confirmed outcome: only the newest send's answer counts.
    store.settle(inA, K1, FIRST_ATTEMPT, 'CONFIRMED');
    expect(raw(store)).toBe(before);
    expect(store.restore(inA)).toMatchObject({ id: K1 });
  });

  it("the newest send's own answer still settles it", () => {
    store.save(inA, K1);
    store.settle(inA, K1, FIRST_ATTEMPT, 'REFUSED');
    expect(raw(store)).toBeNull();

    store.save(inA, K2);
    store.advance(inA, K2);
    store.settle(inA, K2, SECOND, 'CONFIRMED');
    expect(raw(store)).toBeNull();
  });

  it("a late answer in doubt of an earlier send never rewrites a later send's entry", () => {
    store.save(inA, K1, null);
    store.advance(inA, K1);
    const before = raw(store);
    expect(store.answer(inA, K1, 'COR_FIRST', FIRST_ATTEMPT)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(before);
    expect(setAside(store)).toEqual([]);
    // The newest send's answer in doubt updates it, at its own generation.
    expect(store.answer(inA, K1, 'COR_SECOND', SECOND)).toBe('SAVED');
    expect(entry(store)).toMatchObject({ correlationId: 'COR_SECOND', attempt: 2 });
  });

  it('after a confirmed success, a late answer in doubt neither recreates the entry nor sets anything aside', () => {
    store.save(inA, K1);
    store.advance(inA, K1);
    store.settle(inA, K1, SECOND, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_LATE', FIRST_ATTEMPT)).toBe('SUPERSEDED');
    expect(window.sessionStorage.length).toBe(0);
    expect(store.quarantine.held(inA)).toEqual([]);
  });

  it('after a refusal, or the person setting it aside, a late answer in doubt is kept aside — never written back into the slot', () => {
    store.save(inA, K1);
    store.clear(inA, K1);
    expect(store.answer(inA, K1, 'COR_LATE', FIRST_ATTEMPT)).toBe('SET_ASIDE');
    expect(raw(store)).toBeNull();
    expect(setAside(store)).toHaveLength(1);
  });

  it('advancing changes only the generation: body, stamp, time saved — and so expiry — stay the first send’s', () => {
    store.save(inA, K1);
    const before = entry(store);
    store.advance(inA, K1);
    expect(entry(store)).toEqual({ ...before, attempt: 2 });
    expect(raw(store)).toBe(JSON.stringify({ ...before, attempt: 2 }));
  });

  it('a generation that cannot be recorded: null — the form sends nothing — and the entry as it was', () => {
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

  it('an entry without a generation (written before generations existed) is removed by no answer until a re-send stamps one', () => {
    store.save(inA, K1);
    const older = entry(store);
    delete older.attempt;
    window.sessionStorage.setItem(slotKey(store), JSON.stringify(older));
    const before = raw(store);
    store.settle(inA, K1, FIRST_ATTEMPT, 'REFUSED');
    store.settle(inA, K1, FIRST_ATTEMPT, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_LATE', FIRST_ATTEMPT)).toBe('SUPERSEDED');
    expect(raw(store)).toBe(before);
    // Only a re-send from it, its generation recorded first, may then settle it.
    expect(store.advance(inA, K1)).toBe(SECOND);
    store.settle(inA, K1, SECOND, 'CONFIRMED');
    expect(raw(store)).toBeNull();
  });

  it('bound to the slot: another organization and another submission settle nothing', () => {
    store.save(inA, K1);
    const before = raw(store);
    store.settle(inB, K1, FIRST_ATTEMPT, 'REFUSED');
    store.settle(inA, K2, FIRST_ATTEMPT, 'REFUSED');
    expect(store.advance(inB, K1)).toBeNull();
    expect(store.advance(inA, K2)).toBeNull();
    expect(raw(store)).toBe(before);
  });

  it("a replacement record: the earlier submission's late answers touch nothing of it", () => {
    store.save(inA, K1);
    store.clear(inA, K1);
    store.save(inA, K2);
    const replacement = raw(store);
    store.settle(inA, K1, FIRST_ATTEMPT, 'REFUSED');
    store.settle(inA, K1, FIRST_ATTEMPT, 'CONFIRMED');
    expect(store.answer(inA, K1, 'COR_LATE', FIRST_ATTEMPT)).toBe('SET_ASIDE');
    expect(raw(store)).toBe(replacement);
  });
});

describe.each(LOGIN_BOUND)('$name, bound to its login', (store) => {
  it('another login settles nothing and records no generation', () => {
    store.save(inA, K1);
    const before = raw(store);
    store.settle(laterLogin, K1, FIRST_ATTEMPT, 'REFUSED');
    store.settle(laterLogin, K1, FIRST_ATTEMPT, 'CONFIRMED');
    expect(store.advance(laterLogin, K1)).toBeNull();
    expect(raw(store)).toBe(before);
  });

  it('after a logout reduced it (a marker in the slot, or set aside), no late answer removes, rewrites or recreates it', () => {
    store.save(inA, K1);
    store.purgeAll();
    store.open();
    const reduced = raw(store);
    if (reduced !== null) expect(JSON.parse(reduced)).not.toHaveProperty('attempt');
    const snapshot = JSON.stringify(Object.entries(window.sessionStorage).sort());
    store.settle(inA, K1, FIRST_ATTEMPT, 'REFUSED');
    store.settle(inA, K1, FIRST_ATTEMPT, 'CONFIRMED');
    expect(JSON.stringify(Object.entries(window.sessionStorage).sort())).toBe(snapshot);
    store.answer(inA, K1, 'COR_LATE', FIRST_ATTEMPT);
    expect(raw(store)).toBe(reduced);
  });
});
