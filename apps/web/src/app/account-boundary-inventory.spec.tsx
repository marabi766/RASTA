import { fireEvent, render } from '@testing-library/react';

import { markInventoryOpen, saveUnresolvedInventory } from '@/lib/unresolved-inventory';

import { AccountBoundary } from './AccountBoundary';

/**
 * An unresolved inventory command (`lib/unresolved-inventory.ts`) does not
 * outlive the person who held it, and a logout reduces it to a marker instead
 * of dropping it — a receipt repeated under a fresh key moves stock twice.
 * Real storage, real DOM events; only the owner tag is handed in.
 */

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const SLOT = `rasta.unresolved-inventory.warehouse.WHS_${ULID}`;
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

function page(owner: string) {
  return render(
    <>
      <AccountBoundary owner={owner} />
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
  saveUnresolvedInventory(WAREHOUSE, ENTRY, { owner: 'owner-tag-1', session: 'login-1' });
  const view = page('owner-tag-1');
  fireEvent.submit(view.getByTestId('logout'));
  expect(stored()).toMatchObject({ marker: true, submissionId: ENTRY.submissionId });
  expect(stored()).not.toHaveProperty('body');
  expect(stored()).not.toHaveProperty('replay');
  expect(stored()).not.toHaveProperty('session');
});

it('nothing is stored once a logout has started', () => {
  const view = page('owner-tag-1');
  fireEvent.submit(view.getByTestId('logout'));
  expect(
    saveUnresolvedInventory(WAREHOUSE, ENTRY, { owner: 'owner-tag-1', session: 'login-1' }),
  ).toBe('UNAVAILABLE');
  expect(stored()).toBeNull();
});

it('a page for another person removes the previous person’s entry, and keeps the same person’s', () => {
  saveUnresolvedInventory(WAREHOUSE, ENTRY, { owner: 'owner-tag-1', session: 'login-1' });
  page('owner-tag-1');
  expect(stored()).not.toBeNull();
  page('owner-tag-2');
  expect(stored()).toBeNull();
});

it('a page with no login removes nothing: the same person may sign back in', () => {
  saveUnresolvedInventory(WAREHOUSE, ENTRY, { owner: 'owner-tag-1', session: 'login-1' });
  render(<AccountBoundary owner={null} />);
  expect(stored()).not.toBeNull();
});
