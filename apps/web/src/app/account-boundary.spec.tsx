import { fireEvent, render } from '@testing-library/react';

import { AccountBoundary } from './AccountBoundary';

/**
 * F3: an unresolved order's content (`lib/unresolved-order.ts`) does not outlive
 * the person who held it — and the fact that its outcome is unknown is never
 * removed (PR 405 review 2, F1). Real storage, real DOM events; only the owner
 * tag is handed in.
 */

const PERSON_1 = 'owner-tag-1';
const PERSON_2 = 'owner-tag-2';

/**
 * The entries below are in the format from before entries were kept per
 * organization (`lib/unresolved-tenancy.ts`): kept for the person whose old
 * tags they carry. `lib/unresolved-tenancy.spec.tsx` covers the per-organization
 * keys.
 */
const ACCOUNT_1 = { person: 'person-1', legacy: [PERSON_1] };
const ACCOUNT_2 = { person: 'person-2', legacy: [PERSON_2] };

function entry(owner: string, productId: string, session = 'login-1') {
  window.sessionStorage.setItem(
    `rasta.unresolved-order.${productId}`,
    JSON.stringify({
      v: 1,
      submissionId: 'sub_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE',
      values: { offerId: 'OFR_1', quantity: '3' },
      correlationId: 'COR_ORIGINAL',
      savedAt: Date.now(),
      owner,
      session,
    }),
  );
}

/** An entry in today's format: keyed by its person and owner (`lib/unresolved-tenancy.ts`). */
function tenantEntry(person: string, owner: string, productId: string) {
  window.sessionStorage.setItem(
    `rasta.unresolved-order.@${person}.${owner}.${productId}`,
    JSON.stringify({
      v: 1,
      submissionId: 'sub_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE',
      values: { offerId: 'OFR_SECRET', quantity: '3' },
      correlationId: 'COR_ORIGINAL',
      savedAt: Date.now(),
      owner,
      session: 'login-1',
    }),
  );
}

function keys(): string[] {
  return Object.keys(window.sessionStorage).sort();
}

/** The content-free markers an entry was reduced to (PR 405 review 2, F1). */
function markers(): string[] {
  return keys().filter((key) => key.startsWith('rasta.unresolved-order.!q.'));
}

beforeEach(() => window.sessionStorage.clear());

describe('logout purges every remembered order', () => {
  function logoutPage() {
    return render(
      <>
        <AccountBoundary account={ACCOUNT_1} />
        <form
          method="post"
          action="/auth/logout"
          data-testid="logout"
          onSubmit={(e) => e.preventDefault()}
        >
          <button type="submit">خروج</button>
        </form>
        <form
          method="get"
          action="/marketplace/PRD_1"
          data-testid="sort"
          onSubmit={(e) => e.preventDefault()}
        >
          <button type="submit">sort</button>
        </form>
      </>,
    );
  }

  it('reduces the entries of all products to content-free markers, and touches nothing else', () => {
    tenantEntry('person-1', 'owner-1', 'PRD_1');
    tenantEntry('person-1', 'owner-1', 'PRD_2');
    entry(PERSON_1, 'PRD_3');
    const old = window.sessionStorage.getItem('rasta.unresolved-order.PRD_3');
    window.sessionStorage.setItem('unrelated', 'kept');
    const { getByTestId } = logoutPage();

    fireEvent.submit(getByTestId('logout'));

    // Nothing of what was ordered stays readable; that two outcomes are unknown does.
    expect(markers()).toHaveLength(2);
    for (const key of markers()) {
      expect(window.sessionStorage.getItem(key)).not.toMatch(/OFR_SECRET|PRD_|owner-1|person-1/);
    }
    // An entry from before entries were kept per organization is never written over.
    expect(window.sessionStorage.getItem('rasta.unresolved-order.PRD_3')).toBe(old);
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
    expect(keys()).toHaveLength(4);
  });

  it('is not triggered by another form on the page', () => {
    entry(PERSON_1, 'PRD_1');
    const { getByTestId } = logoutPage();

    fireEvent.submit(getByTestId('sort'));

    expect(keys()).toEqual(['rasta.unresolved-order.PRD_1']);
  });

  it('stops listening when the page goes away', () => {
    entry(PERSON_1, 'PRD_1');
    const { unmount } = logoutPage();
    unmount();
    const later = document.createElement('form');
    later.action = '/auth/logout';
    document.body.appendChild(later);

    fireEvent.submit(later);

    expect(keys()).toEqual(['rasta.unresolved-order.PRD_1']);
    later.remove();
  });
});

describe('a page for another person purges what is not theirs', () => {
  it('reduces the previous person’s entries to content-free markers on the first load, keeps the same person’s', () => {
    tenantEntry('person-1', 'owner-1', 'PRD_1');
    tenantEntry('person-2', 'owner-2', 'PRD_4');
    entry(PERSON_2, 'PRD_2');
    entry(PERSON_2, 'PRD_3', 'login-0');

    render(<AccountBoundary account={ACCOUNT_2} />);

    expect(markers()).toHaveLength(1);
    expect(keys().filter((key) => !markers().includes(key))).toEqual([
      'rasta.unresolved-order.@person-2.owner-2.PRD_4',
      'rasta.unresolved-order.PRD_2',
      'rasta.unresolved-order.PRD_3',
    ]);
    expect(window.sessionStorage.getItem(markers()[0]!)).not.toMatch(/OFR_SECRET|PRD_1|person-1/);
  });

  it('keeps — never removes — what it cannot tell to be anyone’s: another person’s old entry, one that does not read', () => {
    entry(PERSON_1, 'PRD_1');
    const old = window.sessionStorage.getItem('rasta.unresolved-order.PRD_1');
    window.sessionStorage.setItem('rasta.unresolved-order.PRD_9', 'not json');
    render(<AccountBoundary account={ACCOUNT_2} />);
    expect(window.sessionStorage.getItem('rasta.unresolved-order.PRD_1')).toBe(old);
    expect(window.sessionStorage.getItem('rasta.unresolved-order.PRD_9')).toBe('not json');
  });

  it('a page with no login (the sign-in page) removes nothing: the same person may sign back in', () => {
    entry(PERSON_1, 'PRD_1');
    render(<AccountBoundary account={null} />);
    expect(keys()).toEqual(['rasta.unresolved-order.PRD_1']);
  });

  it('never throws when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => render(<AccountBoundary account={ACCOUNT_1} />)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
