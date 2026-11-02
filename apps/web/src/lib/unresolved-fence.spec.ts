/**
 * PR 405 review 3, R1 and R2, for the seven stores through one table
 * (`src/test/unresolved-stores.ts`), all writing through one primitive
 * (`fencedSlot`, `lib/unresolved-tenancy.ts`).
 *
 * R1: K1 is set aside by the person, K2 takes the same slot, then K1's late
 * answer arrives. Its save, or its clear, must leave K2 exactly as it was, and
 * K1's outcome must stay visible — kept aside as a content-free record that
 * draws the fixed warning, or, when storage refuses even that, held in this
 * document's memory (PM addendum A). The fence is the whole ownership tuple
 * (addendum B), and K2's body, key, deadline and withdrawn state are its own
 * (addendum E).
 *
 * R2: an acknowledgement is bounded and its failure is returned, so a nearly
 * full quota still releases the hold — or says it could not (addendum C for
 * the races).
 */

import { K1, K2, STORES, type StoreUnderTest } from '@/test/unresolved-stores';
import { fingerprintOf } from './record-fingerprint';
import {
  QUARANTINE_MARK,
  legacyKey,
  relocate,
  tenantKey,
  type AccountTags,
  type Binding,
} from './unresolved-tenancy';

const K3 = 'sub_THIRDKEYTHIRDKEYTHIRDK';

const inA: Binding = { person: 'PERSON1', owner: 'OWNER_A', session: 'LOGIN1', legacy: ['OLD_A'] };
const inB: Binding = { ...inA, owner: 'OWNER_B' };
const laterLogin: Binding = { ...inA, session: 'LOGIN2' };
const other: Binding = { person: 'PERSON2', owner: 'OWNER_A', session: 'LOGIN9', legacy: [] };
const tagsOf = ({ person, legacy }: Binding): AccountTags => ({ person, legacy });

const realStorage = window.sessionStorage;

/** A `sessionStorage` that refuses a write past `quota` characters (keys and values), as browsers do. */
class QuotaStorage implements Storage {
  private readonly items = new Map<string, string>();
  constructor(public quota: number) {}
  get length() {
    return this.items.size;
  }
  used(except?: string) {
    let total = 0;
    for (const [key, value] of this.items) if (key !== except) total += key.length + value.length;
    return total;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.used(key) + key.length + value.length > this.quota) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    this.items.set(key, String(value));
  }
}

function installStorage(store: Storage) {
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: store });
}

beforeEach(() => {
  installStorage(realStorage);
  window.sessionStorage.clear();
  for (const store of STORES) store.open();
});

afterAll(() => installStorage(realStorage));

const all = (store: StoreUnderTest) =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith(store.prefix))
    .sort();
const slotKey = (store: StoreUnderTest, binding: Binding) =>
  tenantKey(store.prefix, binding, store.scope);
const setAsideKeys = (store: StoreUnderTest) =>
  all(store).filter((key) => key.startsWith(`${store.prefix}${QUARANTINE_MARK}`));
const held = (store: StoreUnderTest, binding: Binding) => store.quarantine.held(tagsOf(binding));

/** K1 sent and set aside by the person; K2 sent into the same slot. Returns K2's bytes. */
function releasedAndReplaced(store: StoreUnderTest): string {
  expect(store.save(inA, K1, null)).toBe('SAVED');
  store.clear(inA, K1);
  expect(store.save(inA, K2, null)).toBe('SAVED');
  expect(store.answer(inA, K2, 'COR_K2')).toBe('SAVED');
  return window.sessionStorage.getItem(slotKey(store, inA))!;
}

describe.each(STORES)(
  'the $name store: a late answer after release and replacement (R1)',
  (store) => {
    it('a stale save leaves K2 byte for byte and keeps K1’s outcome visible, content-free', () => {
      const k2 = releasedAndReplaced(store);
      expect(store.answer(inA, K1, 'COR_K1_LATE')).toBe('SET_ASIDE');

      expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k2);
      expect(store.restore(inA)?.id).toBe(K2);
      // K1 is kept aside: one record, with nothing of K1 in it — no key, no body, no tag.
      const [aside] = setAsideKeys(store);
      const raw = window.sessionStorage.getItem(aside!)!;
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'g', 'quarantined', 'v']);
      for (const kept of [K1, K2, 'COR_K1_LATE', inA.owner, inA.person, store.scope]) {
        expect(`${aside} ${raw}`).not.toContain(kept);
      }
      // Visible: it holds the next fresh submission of this kind and draws the warning …
      expect(held(store, inA)).toEqual([{ key: aside, fingerprint: fingerprintOf(raw) }]);
      // … while K2's own answers still reach K2.
      expect(store.answer(inA, K2, 'COR_K2_AGAIN')).toBe('SAVED');
      expect(store.restore(inA)?.id).toBe(K2);
    });

    it('a stale clear (K1’s definite answer) leaves K2 byte for byte', () => {
      const k2 = releasedAndReplaced(store);
      store.settle(inA, K1);
      expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k2);
      expect(setAsideKeys(store)).toEqual([]);
    });

    it('a stale “set it aside” of K1 leaves K2 byte for byte', () => {
      const k2 = releasedAndReplaced(store);
      store.clear(inA, K1);
      expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k2);
    });

    it('K2 never starts over K1 while K1 holds the slot: refused, K1 untouched', () => {
      store.save(inA, K1);
      const k1 = window.sessionStorage.getItem(slotKey(store, inA));
      expect(store.save(inA, K2)).toBe('HELD');
      expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k1);
    });

    it('K1’s own answer, while K1 still holds the slot, updates it', () => {
      store.save(inA, K1, null);
      expect(store.answer(inA, K1, 'COR_K1')).toBe('SAVED');
      expect(store.restore(inA)?.id).toBe(K1);
      expect(setAsideKeys(store)).toEqual([]);
    });

    it('the fence is the whole tuple: another organization’s or another person’s answer or clear never touches the slot', () => {
      store.save(inA, K1);
      const k1 = window.sessionStorage.getItem(slotKey(store, inA));
      // The same person acting for B, and another person, with K1's very id.
      expect(store.answer(inB, K1)).toBe('SET_ASIDE');
      expect(store.answer(other, K1)).toBe('SET_ASIDE');
      store.settle(inB, K1);
      store.clear(inB, K1);
      store.settle(other, K1);
      store.clear(other, K1);
      expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k1);
    });

    it('a clear of this slot never erases an old-format entry of another submission, nor a quarantined record', () => {
      // An old-format entry of this person (recognised by an old tag), another submission's.
      store.save({ ...inA, owner: 'OLD_A' }, K3);
      const written = slotKey(store, { ...inA, owner: 'OLD_A' });
      const legacy = window.sessionStorage.getItem(written)!;
      window.sessionStorage.removeItem(written);
      window.sessionStorage.setItem(legacyKey(store.prefix, store.scope), legacy);
      const quarantined = `${store.prefix}${QUARANTINE_MARK}earlier`;
      window.sessionStorage.setItem(quarantined, '{"v":1,"quarantined":true,"at":1}');
      // Nothing of K1 in the tenant slot: every clear of K1 finds only those two.
      store.settle(inA, K1);
      store.clear(inA, K1);
      expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(legacy);
      expect(window.sessionStorage.getItem(quarantined)).toBe('{"v":1,"quarantined":true,"at":1}');
    });

    it('a late answer from another login of the same person does not write over its slot', () => {
      store.save(inA, K1);
      const k1 = window.sessionStorage.getItem(slotKey(store, inA));
      const outcome = store.answer(laterLogin, K1);
      if (store.retries) {
        // The entry carries the login it was sent under: kept aside, the entry as it was.
        expect(outcome).toBe('SET_ASIDE');
        expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k1);
        store.settle(laterLogin, K1);
        expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(k1);
      } else {
        // A marker keeps no login: it is the same person's record either way.
        expect(outcome).toBe('SAVED');
      }
    });

    describe('when K1 cannot be kept aside (addendum A)', () => {
      it('a full quota: K2 untouched, the outcome held in memory and shown, a fresh one refused', () => {
        const k2 = releasedAndReplaced(store);
        // Copy what is stored into a storage with no room left.
        const full = new QuotaStorage(0);
        for (const key of Object.keys(realStorage)) {
          full.quota += key.length + realStorage.getItem(key)!.length;
          full.setItem(key, realStorage.getItem(key)!);
        }
        installStorage(full);
        expect(store.answer(inA, K1, 'COR_K1_LATE')).toBe('UNAVAILABLE');
        expect(full.getItem(slotKey(store, inA))).toBe(k2);
        const memory = held(store, inA);
        expect(memory).toHaveLength(1);
        expect(memory[0]!.key.startsWith(store.prefix)).toBe(false);
        // Every person on this document is held, until each acknowledges it.
        const inMemory = (binding: Binding) =>
          held(store, binding).filter((record) => !record.key.startsWith(store.prefix));
        expect(inMemory(other)).toEqual(memory);
        store.settle(inA, K2);
        expect(store.save(inA, K3)).toBe('HELD');
        expect(store.quarantine.acknowledge(inA.person, memory)).toBe('ACKNOWLEDGED');
        expect(held(store, inA)).toEqual([]);
        expect(inMemory(other)).toEqual(memory);
      });

      it('a logout in between: nothing is written, K2 untouched, the outcome held in memory', () => {
        releasedAndReplaced(store);
        store.purgeAll();
        const after = window.sessionStorage.getItem(slotKey(store, inA));
        expect(store.answer(inA, K1, 'COR_K1_LATE')).toBe('UNAVAILABLE');
        // K2 is exactly what the logout left of it (itself, or its content-free marker).
        expect(window.sessionStorage.getItem(slotKey(store, inA))).toBe(after);
        expect(held(store, inA).some((record) => !record.key.startsWith(store.prefix))).toBe(true);
      });

      it('storage gone altogether: the outcome is held in memory all the same', () => {
        releasedAndReplaced(store);
        Object.defineProperty(window, 'sessionStorage', {
          configurable: true,
          get() {
            throw new DOMException('denied', 'SecurityError');
          },
        });
        expect(store.answer(inA, K1)).toBe('UNAVAILABLE');
        expect(held(store, inA)).toHaveLength(1);
        expect(store.save(inA, K3)).toBe('UNAVAILABLE');
      });
    });
  },
);

describe.each(STORES)('the $name store: a bounded acknowledgement (R2)', (store) => {
  /** 2,000 characters of records this person cannot be shown, in a 3,000-character quota. */
  function heldUnderQuota(): { storage: QuotaStorage; fence: ReturnType<typeof held> } {
    const storage = new QuotaStorage(3000);
    installStorage(storage);
    storage.setItem(legacyKey(store.prefix, 'ELSEWHERE'), `{"v":"x","pad":"${'x'.repeat(1950)}"}`);
    const fence = held(store, inA);
    expect(fence).toHaveLength(1);
    return { storage, fence };
  }

  it('records that fit, a quota nearly full: the acknowledgement still fits, and only then a fresh save is allowed', () => {
    heldUnderQuota();
    expect(store.save(inA, K2)).toBe('HELD');
    expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
    expect(held(store, inA)).toEqual([]);
    expect(store.save(inA, K2)).toBe('SAVED');
  });

  it('what it keeps is bounded, whatever the record’s size: a key and a fingerprint', () => {
    const big = `{"v":"x","pad":"${'x'.repeat(50_000)}"}`;
    window.sessionStorage.setItem(legacyKey(store.prefix, 'BIG'), big);
    expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
    const ack = window.sessionStorage.getItem(`${store.prefix}!ack.${inA.person}`)!;
    expect(ack.length).toBeLessThan(200);
    expect(ack).not.toContain('xxxx');
  });

  it('no room even for that: the failure is returned, the hold stays, nothing fresh is saved', () => {
    const { storage, fence } = heldUnderQuota();
    // Not one more character fits.
    storage.quota = storage.used();
    expect(store.quarantine.acknowledge(inA.person, fence)).toBe('FAILED');
    expect(held(store, inA)).toEqual(fence);
    expect(store.save(inA, K2)).toBe('HELD');
  });

  describe('races (addendum C)', () => {
    const old = () => legacyKey(store.prefix, 'ELSEWHERE');
    beforeEach(() => window.sessionStorage.setItem(old(), '{"v":"unreadable"}'));

    it('a record that changed after the warning was drawn is not covered', () => {
      const fence = held(store, inA);
      window.sessionStorage.setItem(old(), '{"v":"unreadable","changed":true}');
      expect(store.quarantine.acknowledge(inA.person, fence)).toBe('CHANGED');
      expect(held(store, inA).map((record) => record.key)).toEqual([old()]);
    });

    it('a new generation — a later record, even with the same content — holds again', () => {
      expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
      releasedAndReplaced(store);
      store.answer(inA, K1);
      store.answer(inA, K1);
      // Two late answers: two records, never the same bytes, neither covered.
      const fresh = held(store, inA);
      expect(fresh).toHaveLength(2);
      expect(new Set(fresh.map((record) => record.fingerprint)).size).toBe(2);
    });

    it('a relocation carries the acknowledgement with the bytes', () => {
      expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
      relocate(window.sessionStorage, store.prefix, old());
      expect(window.sessionStorage.getItem(old())).toBeNull();
      expect(held(store, inA)).toEqual([]);
    });

    it('a relocation that fails part way never lifts a hold', () => {
      const storage = new QuotaStorage(10_000);
      installStorage(storage);
      storage.setItem(old(), '{"v":"unreadable"}');
      expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
      // Room for the copy, none for moving the acknowledgement with it.
      const realSet = storage.setItem.bind(storage);
      storage.setItem = (key, value) => {
        if (key.includes('!ack.')) throw new DOMException('full', 'QuotaExceededError');
        realSet(key, value);
      };
      expect(() => relocate(storage, store.prefix, old())).toThrow();
      // The original is still there and still acknowledged; the copy is held.
      expect(storage.getItem(old())).toBe('{"v":"unreadable"}');
      expect(held(store, inA).map((record) => record.key)).toEqual([
        expect.stringContaining(QUARANTINE_MARK),
      ]);
    });

    it('another person’s hold is not lifted by this one’s acknowledgement', () => {
      expect(store.quarantine.acknowledge(inA.person, held(store, inA))).toBe('ACKNOWLEDGED');
      expect(held(store, other).map((record) => record.key)).toEqual([old()]);
    });

    it('a fence naming another prefix or an acknowledgement is not covered', () => {
      const foreign = [{ key: 'rasta.unresolved-elsewhere.X', fingerprint: fingerprintOf('x') }];
      expect(store.quarantine.acknowledge(inA.person, foreign)).toBe('CHANGED');
      expect(held(store, inA)).toHaveLength(1);
    });
  });
});

it('the fingerprint is the SHA-256 of the exact text, with its length: two texts share one only if equal', () => {
  // `node:crypto` over the same UTF-16BE bytes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  for (const text of [
    '',
    'a',
    'x'.repeat(27),
    'x'.repeat(28),
    'x'.repeat(32),
    'é'.repeat(16),
    '😀'.repeat(40),
  ]) {
    const bytes = Buffer.alloc(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      bytes.writeUInt16BE(text.charCodeAt(index), index * 2);
    }
    expect(fingerprintOf(text)).toBe(
      `${text.length.toString(36)}.${createHash('sha256').update(bytes).digest('hex')}`,
    );
  }
  expect(fingerprintOf('{"v":1}')).not.toBe(fingerprintOf('{"v":1} '));
});

describe('an answer keeps the first send’s body (addendum E)', () => {
  it('order: the values sent first, whatever a later answer carries', () => {
    const order = jest.requireActual<typeof import('./unresolved-order')>('./unresolved-order');
    const first = { submissionId: K1, values: { offerId: 'OFR_1', quantity: '3' } };
    expect(order.saveUnresolvedOrder('PRD_1', { ...first, correlationId: null }, inA)).toBe(
      'SAVED',
    );
    const late = { submissionId: K1, values: { offerId: 'OFR_2', quantity: '9' } };
    expect(order.answerUnresolvedOrder('PRD_1', { ...late, correlationId: 'COR' }, inA)).toBe(
      'SAVED',
    );
    expect(order.restoreUnresolvedOrder('PRD_1', inA, 3600)?.order).toMatchObject({
      submissionId: K1,
      values: { offerId: 'OFR_1', quantity: '3' },
      correlationId: 'COR',
    });
  });

  it('dispute: the text sent first, and a withdrawn replay stays withdrawn', () => {
    const dispute =
      jest.requireActual<typeof import('./unresolved-dispute')>('./unresolved-dispute');
    const entry = (reason: string, replay: { token: string; until: number } | null) => ({
      command: 'DISPUTE' as const,
      submissionId: K1,
      values: { reason, resolution: '' },
      correlationId: 'COR',
      replay,
    });
    const stamp = { token: 'stamp', until: Date.now() + 60_000 };
    expect(dispute.saveUnresolvedDispute('TXN_1', entry('متن نخست اعتراض', stamp), inA)).toBe(
      'SAVED',
    );
    // The server said the deadline passed: the stamp is withdrawn …
    expect(dispute.answerUnresolvedDispute('TXN_1', entry('متن دیگر', null), inA)).toBe('SAVED');
    // … and a later answer carrying one does not bring it back, nor its text.
    expect(dispute.answerUnresolvedDispute('TXN_1', entry('متن سوم', stamp), inA)).toBe('SAVED');
    expect(dispute.restoreUnresolvedDispute('TXN_1', inA, 3600)?.dispute).toMatchObject({
      values: { reason: 'متن نخست اعتراض' },
      replay: null,
    });
  });
});
