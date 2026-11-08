import { fireEvent, render } from '@testing-library/react';

import { markInventoryOpen, saveUnresolvedInventory } from '@/lib/unresolved-inventory';
import { OTHER_PERSON, PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';

import { AccountBoundary } from './AccountBoundary';

/**
 * An unresolved inventory command (`lib/unresolved-inventory.ts`) does not
 * outlive the person who held it, and a logout reduces it to a marker instead
 * of dropping it — a receipt repeated under a fresh key moves stock twice.
 * Real storage, real DOM events; only the person's tags are handed in.
 */

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const BINDING = bindingOf('owner-tag-1', 'login-1');
const SLOT = keyFor('rasta.unresolved-inventory.', BINDING, `warehouse.WHS_${ULID}`);
const WAREHOUSE = { kind: 'WAREHOUSE', warehouseId: `WHS_${ULID}` } as const;
const ENTRY = {
  command: 'RECEIVE_STOCK',
  submissionId: 'sub_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE',
  body: { productId: `PRD_${ULID}`, quantity: 5, sourceReference: null },
  correlationId: 'COR_ORIGINAL',
  replay: { token: 'stamp', until: Date.now() + 3_000_000 },
} as const;

beforeEach(() => {
  window.sessionStorage.clear();
  markInventoryOpen();
});

const stored = () =>
  JSON.parse(window.sessionStorage.getItem(SLOT) ?? 'null') as Record<string, unknown> | null;

function page(person: string) {
  return render(
    <>
      <AccountBoundary account={{ person, legacy: [] }} />
      <form
        method="post"
        action="/auth/logout"
        data-testid="logout"
        onSubmit={(e) => e.preventDefault()}
      >
        <button type="submit">خروج</button>
      </form>
    </>,
  );
}

it('logout reduces the entry to a marker: no body, no stamp, no login tag', () => {
  saveUnresolvedInventory(WAREHOUSE, ENTRY, BINDING);
  const view = page(PERSON);
  fireEvent.submit(view.getByTestId('logout'));
  expect(stored()).toMatchObject({ marker: true, submissionId: ENTRY.submissionId });
  expect(stored()).not.toHaveProperty('body');
  expect(stored()).not.toHaveProperty('replay');
  expect(stored()).not.toHaveProperty('session');
});

it('nothing is stored once a logout has started', () => {
  const view = page(PERSON);
  fireEvent.submit(view.getByTestId('logout'));
  expect(saveUnresolvedInventory(WAREHOUSE, ENTRY, BINDING).outcome).toBe('UNAVAILABLE');
  expect(stored()).toBeNull();
});

it('a page for another person reduces the previous person’s entry to a content-free held marker, and keeps the same person’s', () => {
  saveUnresolvedInventory(WAREHOUSE, ENTRY, BINDING);
  page(PERSON);
  expect(stored()).not.toBeNull();
  page(OTHER_PERSON);
  expect(stored()).toBeNull();
  // Never removed outright: the fact that an outcome is unknown stays (`lib/unresolved-tenancy.ts`).
  const kept = Object.keys(window.sessionStorage);
  expect(kept).toHaveLength(1);
  expect(JSON.parse(window.sessionStorage.getItem(kept[0]!)!)).toEqual({
    v: 1,
    quarantined: true,
    at: expect.any(Number),
    g: expect.any(String),
  });
});

it('a page with no login removes nothing: the same person may sign back in', () => {
  saveUnresolvedInventory(WAREHOUSE, ENTRY, BINDING);
  render(<AccountBoundary account={null} />);
  expect(stored()).not.toBeNull();
});
