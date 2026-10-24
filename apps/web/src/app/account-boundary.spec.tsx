import { fireEvent, render } from '@testing-library/react';

import { AccountBoundary } from './AccountBoundary';

/**
 * F3: an unresolved order (`lib/unresolved-order.ts`) does not outlive the person
 * who held it. Real storage, real DOM events; only the owner tag is handed in.
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

function keys(): string[] {
  return Object.keys(window.sessionStorage).sort();
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

  it('removes the entries of all products, and nothing else in storage', () => {
    entry(PERSON_1, 'PRD_1');
    entry(PERSON_1, 'PRD_2');
    window.sessionStorage.setItem('unrelated', 'kept');
    const { getByTestId } = logoutPage();

    fireEvent.submit(getByTestId('logout'));

    expect(keys()).toEqual(['unrelated']);
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
  it('removes the previous person’s entries on the first load, keeps the same person’s', () => {
    entry(PERSON_1, 'PRD_1');
    entry(PERSON_2, 'PRD_2');
    entry(PERSON_2, 'PRD_3', 'login-0');

    render(<AccountBoundary account={ACCOUNT_2} />);

    expect(keys()).toEqual(['rasta.unresolved-order.PRD_2', 'rasta.unresolved-order.PRD_3']);
  });

  it('removes entries that cannot be read as anyone’s', () => {
    window.sessionStorage.setItem('rasta.unresolved-order.PRD_9', 'not json');
    render(<AccountBoundary account={ACCOUNT_1} />);
    expect(keys()).toEqual([]);
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
