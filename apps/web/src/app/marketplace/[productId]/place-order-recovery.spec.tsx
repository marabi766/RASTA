import { Component, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { refuseBeforeBody } from '@/server/request-gate';
import { sealSession, type WebSession } from '@/server/session';
import type { Offer } from '@/server/marketplace';

import {
  markAccountOpen,
  purgeAllUnresolvedOrders,
  purgeForeignUnresolvedOrders,
} from '@/lib/unresolved-order';

import { PlaceOrderForm, type PlaceOrderFormProps } from './PlaceOrderForm';
import type { PlaceOrderFormState } from './place-order-form-state';
import { OTHER_PERSON as OTHER_PERSON_TAG, bindingOf, keyFor } from '@/test/unresolved-binding';
import { QUARANTINE_TITLE } from '@/app/UnresolvedQuarantine';

/**
 * What survives a reload, the sort form's GET navigation, a call the gate
 * refuses and a re-login — with the real `useActionState`, the real storage
 * module and, for the expired session, the real request gate in front of the
 * action. Only the action's own body is scripted: it is the one thing a
 * component test cannot run.
 */

const submit = jest.fn<Promise<PlaceOrderFormState>, [PlaceOrderFormState, FormData]>();
/** `GET /auth/session`, which the form asks only after a send whose call itself failed. */
const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();
jest.mock('./place-order-actions', () => ({
  submitPlaceOrder: (previous: PlaceOrderFormState, form: FormData) => submit(previous, form),
}));

// A plain anchor: `next/link`'s viewport prefetch updates state outside `act`, which is noise here.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const SECRET = 'a-session-secret-that-is-long-enough-to-be-one';
const SESSION_MAX_AGE = 3600;

const SESSION: WebSession = {
  subject: 'user-1',
  username: 'buyer',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value-AAA',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value-BBB',
  csrfToken: 'csrf-token-value-CCC',
  issuedAt: Math.floor(Date.now() / 1000),
};

const OFFER: Offer = {
  id: 'OFR_1',
  productId: 'PRD_1',
  supplierOrganizationId: 'ORG-DEH-0002',
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 2,
  supplierQualification: 'UNAVAILABLE',
};

const KEY = 'sub_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE';
const PAGE_KEY = 'sub_PAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPA';

const LOGIN_1 = bindingOf('owner-1', 'login-1');
const LOGIN_2 = bindingOf('owner-1', 'login-2');
const OTHER_PERSON = bindingOf('owner-2', 'login-9', OTHER_PERSON_TAG);
/** Where the page's own entry for PRD_1 is kept: this person, this organization. */
const STORAGE_KEY = keyFor('rasta.unresolved-order.', LOGIN_1, 'PRD_1'); // gitleaks:allow

function pageProps(overrides: Partial<PlaceOrderFormProps> = {}): PlaceOrderFormProps {
  return {
    offers: [OFFER],
    csrfToken: SESSION.csrfToken,
    // A page load mints a new id every time: this is the id a reload would send.
    submissionId: PAGE_KEY,
    newOrderHref: '/marketplace/PRD_1',
    productId: 'PRD_1',
    binding: LOGIN_1,
    sessionMaxAgeSeconds: SESSION_MAX_AGE,
    ...overrides,
  };
}

/** A page load: the form mounts, then looks in storage. */
function loadPage(overrides: Partial<PlaceOrderFormProps> = {}) {
  return render(<PlaceOrderForm {...pageProps(overrides)} />);
}

function fillAndSend(container: HTMLElement) {
  fireEvent.change(container.querySelector('select[name="offerId"]') as HTMLSelectElement, {
    target: { value: 'OFR_1' },
  });
  fireEvent.change(container.querySelector('[name="quantity"]') as HTMLInputElement, {
    target: { value: '3' },
  });
  return act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

function retry(container: HTMLElement) {
  return act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

const UNCONFIRMED: PlaceOrderFormState = {
  kind: 'UNCONFIRMED',
  correlationId: 'COR_ORIGINAL',
  submissionId: KEY,
  values: { offerId: 'OFR_1', quantity: '3' },
};

function stored(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function plant(overrides: Record<string, unknown> = {}, binding = LOGIN_1) {
  window.sessionStorage.setItem(
    keyFor('rasta.unresolved-order.', binding, 'PRD_1'),
    JSON.stringify({
      v: 1,
      submissionId: KEY,
      values: { offerId: 'OFR_1', quantity: '3' },
      correlationId: 'COR_ORIGINAL',
      savedAt: Date.now(),
      owner: binding.owner,
      session: binding.session,
      ...overrides,
    }),
  );
}

/** What Next's client throws when the portal's gate answers an action POST with JSON. */
const UNEXPECTED_RESPONSE = 'An unexpected response was received from the server.';

/**
 * The action POST as the real gate sees it: `Next-Action` header, a session
 * cookie, and nothing else of the portal in front of the action.
 */
function postThroughGate(cookie: string | undefined): void {
  const headers: Record<string, string> = { 'next-action': 'abc', 'content-length': '300' };
  const refusal = refuseBeforeBody({
    method: 'POST',
    pathname: '/marketplace/PRD_1',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    sessionCookie: cookie,
    maxBytesRaw: undefined,
    sessionConfig: () => ({ secret: SECRET, maxAgeSeconds: SESSION_MAX_AGE }),
  });
  if (refusal) throw new Error(UNEXPECTED_RESPONSE);
}

class Catch extends Component<{ children: ReactNode; onError: (error: unknown) => void }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

beforeEach(() => {
  submit.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
  markAccountOpen();
});

describe('the record is a precondition of sending, and logout is final (r6)', () => {
  it('storage that refuses the PENDING entry: the action is never called, a fixed text is shown', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      const { container } = loadPage();
      await fillAndSend(container);

      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByText(/سفارش ارسال نشد/)).toBeInTheDocument();
      expect(screen.getByText(/مرورگر دیگری/)).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it('unavailable storage (the property itself throws): the action is never called', async () => {
    const getter = jest.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      const { container } = loadPage();
      await fillAndSend(container);

      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByText(/سفارش ارسال نشد/)).toBeInTheDocument();
    } finally {
      getter.mockRestore();
    }
  });

  it('pending send → logout purge → UNCONFIRMED arrives: nothing is stored', async () => {
    let answer!: (state: PlaceOrderFormState) => void;
    submit.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { container } = loadPage();
    await fillAndSend(container);
    expect(stored()).toMatchObject({ pending: true });

    purgeAllUnresolvedOrders();
    expect(stored()).toBeNull();

    await act(async () => answer(UNCONFIRMED));

    // Nothing of the order is stored again; only the content-free marker of its unknown outcome stays.
    expect(stored()).toBeNull();
    expect(Object.keys(window.sessionStorage)).toEqual([
      expect.stringMatching(/^rasta\.unresolved-order\.!q\./),
    ]);
  });
});

describe('an unresolved order survives a navigation (F1)', () => {
  it('is remembered the moment the first send comes back unconfirmed, with no token or session value', async () => {
    submit.mockResolvedValueOnce(UNCONFIRMED);
    const { container } = loadPage();
    await fillAndSend(container);

    expect(screen.getByText(/ممکن است سفارش ثبت شده باشد/)).toBeInTheDocument();
    expect(stored()).toMatchObject({
      submissionId: KEY,
      values: { offerId: 'OFR_1', quantity: '3' },
      correlationId: 'COR_ORIGINAL',
    });
    const raw = window.sessionStorage.getItem(STORAGE_KEY) ?? '';
    for (const secret of [
      SESSION.accessToken,
      SESSION.refreshToken,
      SESSION.csrfToken,
      SESSION.subject,
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('a reload shows the uncertainty view again, with the original key — not the new page’s', async () => {
    submit.mockResolvedValueOnce(UNCONFIRMED);
    const first = loadPage();
    await fillAndSend(first.container);
    first.unmount();

    const reloaded = loadPage();
    await waitFor(() =>
      expect(screen.getByText(/ممکن است سفارش ثبت شده باشد/)).toBeInTheDocument(),
    );
    expect(reloaded.container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(reloaded.container.querySelector('[name="offerId"]')).toHaveValue('OFR_1');
    expect(reloaded.container.querySelector('[name="quantity"]')).toHaveValue('3');
    expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
  });

  it('the sort form’s navigation is a reload too: another page id, the same remembered key', async () => {
    plant();
    const { container } = loadPage({
      submissionId: 'sub_SORTSORTSORTSORTSORTSORTSORTSORTSORTSORT00',
    });
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
    expect(container.querySelector('[name="submission"]')).not.toHaveValue(PAGE_KEY);
  });

  it('a retry sends the remembered key and values', async () => {
    plant();
    submit.mockResolvedValueOnce({ ...UNCONFIRMED, retryUnknown: true });
    const { container } = loadPage();
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
    await retry(container);

    const [previous, form] = submit.mock.calls[0] as [PlaceOrderFormState, FormData];
    expect(previous).toMatchObject({ kind: 'UNCONFIRMED', submissionId: KEY });
    expect(form.get('submission')).toBe(KEY);
    expect(form.get('offerId')).toBe('OFR_1');
    expect(form.get('quantity')).toBe('3');
  });

  it('«start a new order» forgets it, and the next page is a blank form', async () => {
    plant();
    const { container, unmount } = loadPage();
    const link = await screen.findByRole('link', { name: 'شروع سفارش تازه' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    unmount();

    const next = loadPage();
    expect(next.container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(screen.queryByText(/ممکن است سفارش ثبت شده باشد/)).toBeNull();
    expect(container).toBeDefined();
  });

  it('a successful retry (the action redirects) forgets it', async () => {
    plant();
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;push;/orders/ORD_1?placed=1;307;',
    });
    submit.mockRejectedValueOnce(redirect);
    const caught = jest.fn();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { container } = render(
        <Catch onError={caught}>
          <PlaceOrderForm {...pageProps()} />
        </Catch>,
      );
      await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
      await retry(container);
    } finally {
      spy.mockRestore();
    }

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // Rethrown untouched, so the router can follow it.
    expect(caught).toHaveBeenCalledWith(redirect);
  });

  it('keeps it after a refused retry: a refusal proves nothing about the first request', async () => {
    plant();
    submit.mockResolvedValueOnce({ ...UNCONFIRMED, retryRefused: true });
    const { container } = loadPage();
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
    await retry(container);

    expect(screen.getByText(/ارسال دوباره رد شد/)).toBeInTheDocument();
    expect(stored()).toMatchObject({ submissionId: KEY, correlationId: 'COR_ORIGINAL' });
  });

  it('after a re-login the stored id is shown but cannot be sent, and the orders list comes first', async () => {
    plant({}, LOGIN_1);
    const { container } = loadPage({ binding: LOGIN_2 });

    await waitFor(() =>
      expect(screen.getByText(/در نشست پیشین فرستاده شده بود/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /فهرست سفارش/ })).toHaveAttribute('href', '/orders');
    expect(screen.queryByRole('button')).toBeNull();
    // Still remembered: only «start a new order» or a successful order clears it.
    expect(stored()).not.toBeNull();
    expect(container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(submit).not.toHaveBeenCalled();
  });

  it('another person’s entry is not shown — this person is warned instead — and the account boundary reduces it to a content-free marker', async () => {
    plant({}, OTHER_PERSON);
    const theirs = keyFor('rasta.unresolved-order.', OTHER_PERSON, 'PRD_1');
    const { container } = loadPage();

    // The device quarantine (PR 405 review 2, F1): no fresh order over an unknown outcome.
    await waitFor(() => expect(screen.queryByText(QUARANTINE_TITLE)).not.toBeNull());
    expect(container.querySelector('[name="submission"]')).toBeNull();
    expect(screen.queryByText(/ممکن است سفارش ثبت شده باشد/)).toBeNull();
    // `AccountBoundary` on this person's first page.
    purgeForeignUnresolvedOrders({ person: LOGIN_1.person, legacy: [] });
    expect(window.sessionStorage.getItem(theirs)).toBeNull();
    expect(Object.keys(window.sessionStorage)).toEqual([
      expect.stringMatching(/^rasta\.unresolved-order\.!q\./),
    ]);
  });

  it('an entry older than the session lifetime is reduced to a marker that holds, never removed outright', async () => {
    plant({ savedAt: Date.now() - (SESSION_MAX_AGE + 5) * 1000 });
    loadPage();

    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(Object.keys(window.sessionStorage)).toEqual([
      expect.stringMatching(/^rasta\.unresolved-order\.!q\./),
    ]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['the wrong shape', JSON.stringify({ v: 1, submissionId: 'x' })],
    ['a submission id that is not one', JSON.stringify({ v: 1, submissionId: '<img src=x>' })],
  ])('an entry that is %s is never shown, kept as it is, and holds', async (_name, raw) => {
    window.sessionStorage.setItem(STORAGE_KEY, raw);
    const { container } = loadPage();
    await waitFor(() => expect(screen.queryByText(QUARANTINE_TITLE)).not.toBeNull());
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(container.innerHTML).not.toContain('<img src=x>');
  });

  it('is kept per product', async () => {
    plant();
    const { container } = loadPage({ productId: 'PRD_2' });
    await Promise.resolve();
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(stored()).not.toBeNull();
  });

  describe('when storage is unavailable', () => {
    afterEach(() => jest.restoreAllMocks());

    it('does not place an order it cannot remember (r6), and the page still loads', async () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      submit.mockResolvedValueOnce(UNCONFIRMED);

      const { container } = loadPage();
      expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
      await fillAndSend(container);

      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByText(/سفارش ارسال نشد/)).toBeInTheDocument();
    });

    it('works when there is no sessionStorage at all', async () => {
      const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => {
          throw new Error('SecurityError');
        },
      });
      try {
        const { container } = loadPage();
        expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
      } finally {
        if (original) Object.defineProperty(window, 'sessionStorage', original);
      }
    });
  });
});

describe('a session that ended behind an unresolved order (F2)', () => {
  const EXPIRED = sealSession({ ...SESSION, issuedAt: 1_000 }, SECRET);

  // The portal's own answer behind the same cookie: the session has ended.
  beforeEach(() => sessionProbe.mockResolvedValue({ status: 401 }));

  it('the real gate refuses the action POST, and the uncertainty view stays with its original data', async () => {
    plant();
    // The real gate in front of the action: an expired cookie never reaches it.
    submit.mockImplementation(async () => {
      postThroughGate(EXPIRED);
      throw new Error('the action must not run behind a refused gate');
    });
    const { container } = loadPage();
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));

    await retry(container);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(sessionProbe).toHaveBeenCalledWith('/auth/session');
    expect(screen.getByText(/نشست شما پایان یافته است. دوباره وارد شوید/)).toBeInTheDocument();
    expect(screen.getByText(/فهرست سفارش‌ها را\s*ببینید/)).toBeInTheDocument();
    expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
    expect(screen.getAllByText(/ممکن است سفارش ثبت شده باشد/).length).toBeGreaterThan(0);
    // Nothing to re-send with, until the person signs in again.
    expect(screen.queryByRole('button')).toBeNull();
    expect(stored()).toMatchObject({ submissionId: KEY });
  });

  it('the same refusal happens for a missing cookie', async () => {
    plant();
    submit.mockImplementation(async () => {
      postThroughGate(undefined);
      throw new Error('the action must not run behind a refused gate');
    });
    const { container } = loadPage();
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
    await retry(container);
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
  });

  it('survives the re-login: the new login sees the order, and cannot re-send the old key', async () => {
    plant();
    submit.mockImplementation(async () => {
      postThroughGate(EXPIRED);
      throw new Error('unreachable');
    });
    const first = loadPage();
    await waitFor(() =>
      expect(first.container.querySelector('[name="submission"]')).toHaveValue(KEY),
    );
    await retry(first.container);
    first.unmount();

    // Signed in again: a new page, a new login's tags.
    submit.mockReset();
    const second = loadPage({ binding: LOGIN_2 });
    await waitFor(() =>
      expect(screen.getByText(/در نشست پیشین فرستاده شده بود/)).toBeInTheDocument(),
    );
    expect(second.container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(screen.queryByRole('button')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('a first send the gate refuses is uncertain too: nothing says the order did not commit', async () => {
    submit.mockImplementation(async () => {
      postThroughGate(EXPIRED);
      throw new Error('unreachable');
    });
    const { container } = loadPage();
    await fillAndSend(container);

    expect(screen.getAllByText(/ممکن است سفارش ثبت شده باشد/).length).toBeGreaterThan(0);
    // `/auth/session` says 401 behind the same cookie: ended, and said so.
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(stored()).toMatchObject({ submissionId: PAGE_KEY });
  });
});

/**
 * A call that itself fails says nothing about the session: only `/auth/session`
 * answering 401 does. Anything else — its 503 for a refresh unavailable for now,
 * a 204, no answer — leaves the order unknown with its retry, which sends the
 * same key and the same body (the dispute form's rule, PR 319 review 1,
 * finding 4 and review 2, finding 3).
 */
describe('a send whose call fails while the session has not been said to end', () => {
  const LOST = () => Promise.reject(new Error(UNEXPECTED_RESPONSE));

  it.each([
    ['/auth/session answers 503 (refresh unavailable)', () => Promise.resolve({ status: 503 })],
    ['/auth/session answers 204', () => Promise.resolve({ status: 204 })],
    ['/auth/session gets no answer', () => Promise.reject(new TypeError('network'))],
  ])(
    'a retry: %s → unknown, the retry stays and resends the same request',
    async (_name, probe) => {
      plant();
      submit.mockImplementationOnce(LOST);
      sessionProbe.mockImplementationOnce(probe);
      const { container } = loadPage();
      await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));

      await retry(container);

      expect(sessionProbe).toHaveBeenCalledWith('/auth/session');
      expect(screen.getByText(/ارسال دوباره نیز نتیجهٔ روشنی نداشت/)).toBeInTheDocument();
      expect(screen.queryByText(/نشست شما پایان یافته است/)).toBeNull();
      expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
      expect(stored()).toMatchObject({ submissionId: KEY });

      // The retry is kept, and it is the same request: same key, same body.
      submit.mockImplementationOnce(LOST);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }));
      });
      expect(submit).toHaveBeenCalledTimes(2);
      const resent = submit.mock.calls[1]![1];
      expect(resent.get('submission')).toBe(KEY);
      expect(resent.get('offerId')).toBe('OFR_1');
      expect(resent.get('quantity')).toBe('3');
    },
  );

  it('a first send while /auth/session answers 503: unconfirmed with its retry, not ended', async () => {
    submit.mockImplementationOnce(LOST);
    sessionProbe.mockResolvedValueOnce({ status: 503 });
    const { container } = loadPage();
    await fillAndSend(container);

    expect(screen.getAllByText(/ممکن است سفارش ثبت شده باشد/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/نشست شما پایان یافته است/)).toBeNull();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(stored()).toMatchObject({ submissionId: PAGE_KEY });
  });

  it('a first send while /auth/session answers 401: unconfirmed, the session ended, no retry', async () => {
    submit.mockImplementationOnce(LOST);
    sessionProbe.mockResolvedValueOnce({ status: 401 });
    const { container } = loadPage();
    await fillAndSend(container);

    expect(screen.getAllByText(/ممکن است سفارش ثبت شده باشد/).length).toBeGreaterThan(0);
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(stored()).toMatchObject({ submissionId: PAGE_KEY });
  });
});

describe('an order is remembered before it is sent (F1)', () => {
  it('is in storage while the first send is still in flight, PENDING and without a correlation id', async () => {
    let answer: (state: PlaceOrderFormState) => void = () => undefined;
    submit.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { container } = loadPage();
    await fillAndSend(container);

    expect(stored()).toMatchObject({
      submissionId: PAGE_KEY,
      values: { offerId: 'OFR_1', quantity: '3' },
      correlationId: null,
      pending: true,
    });
    await act(async () => answer({ kind: 'FORBIDDEN', correlationId: 'COR_F' }));
  });

  it('a reload while the first send is in flight restores the uncertainty view with the same key', async () => {
    let answer: (state: PlaceOrderFormState) => void = () => undefined;
    submit.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = loadPage();
    await fillAndSend(first.container);
    first.unmount();

    // The reload: a new page id, the old send's outcome unknown.
    const reloaded = loadPage({ submissionId: 'sub_RELOADRELOADRELOADRELOADRELOADRELOADRELO' });
    await waitFor(() =>
      expect(screen.getByText(/ممکن است سفارش ثبت شده باشد/)).toBeInTheDocument(),
    );
    expect(reloaded.container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(reloaded.container.querySelector('[name="offerId"]')).toHaveValue('OFR_1');
    expect(reloaded.container.querySelector('[name="quantity"]')).toHaveValue('3');
    expect(screen.queryByText(/کد پیگیری/)).toBeNull();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    // The abandoned send finally ends (its page is gone); a transition left open would block later actions.
    await act(async () => answer({ kind: 'FORBIDDEN', correlationId: 'COR_F' }));
  });

  it('a transport rejection of the first send is the uncertainty view with the same key, kept in storage', async () => {
    submit.mockRejectedValueOnce(new Error('network down'));
    const { container } = loadPage();
    await fillAndSend(container);

    expect(screen.getAllByText(/ممکن است سفارش ثبت شده باشد/).length).toBeGreaterThan(0);
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(stored()).toMatchObject({ submissionId: PAGE_KEY, pending: true });

    // And the retry is the same key.
    submit.mockResolvedValueOnce({ ...UNCONFIRMED, submissionId: PAGE_KEY, retryUnknown: true });
    await retry(container);
    const [, form] = submit.mock.calls[1] as [PlaceOrderFormState, FormData];
    expect(form.get('submission')).toBe(PAGE_KEY);
    expect(form.get('quantity')).toBe('3');
  });

  it('the answer to the first send adds the correlation id and drops the PENDING marker', async () => {
    submit.mockResolvedValueOnce({ ...UNCONFIRMED, submissionId: PAGE_KEY });
    const { container } = loadPage();
    await fillAndSend(container);

    expect(stored()).toMatchObject({ submissionId: PAGE_KEY, correlationId: 'COR_ORIGINAL' });
    expect(stored()).not.toHaveProperty('pending');
  });

  it.each([
    ['a refusal of the form', { kind: 'FORBIDDEN', correlationId: 'COR_F' } as const],
    ['no session', { kind: 'REFUSED', reason: 'NO_SESSION' } as const],
  ])('%s settles it: nothing stays in storage', async (_name, answer) => {
    submit.mockResolvedValueOnce(answer);
    const { container } = loadPage();
    await fillAndSend(container);
    expect(stored()).toBeNull();
  });

  it('a successful first send (the action redirects) leaves nothing', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;push;/orders/ORD_1?placed=1;307;',
    });
    submit.mockRejectedValueOnce(redirect);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { container } = render(
        <Catch onError={() => undefined}>
          <PlaceOrderForm {...pageProps()} />
        </Catch>,
      );
      await fillAndSend(container);
    } finally {
      spy.mockRestore();
    }
    expect(stored()).toBeNull();
  });

  it('a form the action would refuse before sending anything is not remembered', async () => {
    submit.mockResolvedValueOnce({
      kind: 'INVALID',
      submissionId: PAGE_KEY,
      values: { offerId: 'OFR_1', quantity: 'abc' },
      fieldErrors: { quantity: 'x' },
      message: null,
    });
    const { container } = loadPage();
    fireEvent.change(container.querySelector('[name="quantity"]') as HTMLInputElement, {
      target: { value: 'abc' },
    });
    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    });
    expect(stored()).toBeNull();
  });
});

describe('what is remembered is what was sent (F2)', () => {
  it('a quantity typed with leading zeros is remembered as the count, and survives a reload', async () => {
    submit.mockRejectedValueOnce(new Error('network down'));
    const first = loadPage();
    fireEvent.change(first.container.querySelector('select[name="offerId"]') as HTMLSelectElement, {
      target: { value: 'OFR_1' },
    });
    fireEvent.change(first.container.querySelector('[name="quantity"]') as HTMLInputElement, {
      target: { value: '00000000000000003' },
    });
    await act(async () => {
      fireEvent.submit(first.container.querySelector('form') as HTMLFormElement);
    });

    expect(stored()).toMatchObject({ values: { offerId: 'OFR_1', quantity: '3' } });
    first.unmount();

    const reloaded = loadPage();
    await waitFor(() =>
      expect(reloaded.container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY),
    );
    expect(reloaded.container.querySelector('[name="quantity"]')).toHaveValue('3');
    expect(stored()).not.toBeNull();
  });

  it('Persian digits are remembered as Latin ones', async () => {
    submit.mockRejectedValueOnce(new Error('network down'));
    const { container } = loadPage();
    fireEvent.change(container.querySelector('select[name="offerId"]') as HTMLSelectElement, {
      target: { value: 'OFR_1' },
    });
    fireEvent.change(container.querySelector('[name="quantity"]') as HTMLInputElement, {
      target: { value: '۰۰۳' },
    });
    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    });
    expect(stored()).toMatchObject({ values: { quantity: '3' } });
  });

  it('an entry an earlier build wrote with the text as typed is restored as the count, not deleted', async () => {
    plant({ values: { offerId: 'OFR_1', quantity: '00000000000000003' } });
    const { container } = loadPage();
    await waitFor(() => expect(container.querySelector('[name="submission"]')).toHaveValue(KEY));
    expect(container.querySelector('[name="quantity"]')).toHaveValue('3');
    expect(stored()).not.toBeNull();
  });

  it('a quantity the action could never have accepted is never restored — kept as it is, and holds', async () => {
    plant({ values: { offerId: 'OFR_1', quantity: '0' } });
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    loadPage();
    await waitFor(() => expect(screen.queryByText(QUARANTINE_TITLE)).not.toBeNull());
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
  });
});

describe('an organization switch while an answer is out (task 100)', () => {
  const IN_A = bindingOf('owner-A', 'login-A');
  const IN_B = bindingOf('owner-B', 'login-B');
  const PREFIX = 'rasta.unresolved-order.';
  /** A route as every page draws it: its tree keyed to the organization (`actingScope`). */
  const route = (binding: typeof IN_A, organization: string, submissionId: string) => (
    <div key={`organization:${organization}`}>
      <PlaceOrderForm {...pageProps({ binding, submissionId })} />
    </div>
  );

  it('A’s late answer is kept as A’s, and never drawn on — or stored for — the page now drawn for B', async () => {
    let answer: (state: PlaceOrderFormState) => void = () => undefined;
    submit.mockImplementation(
      () =>
        new Promise<PlaceOrderFormState>((resolve) => {
          answer = resolve;
        }),
    );
    const { container, rerender } = render(route(IN_A, 'A', KEY));
    await fillAndSend(container);
    expect(window.sessionStorage.getItem(keyFor(PREFIX, IN_A, 'PRD_1'))).not.toBeNull();

    // A refresh re-rendered the route for B while A's send was still out.
    rerender(route(IN_B, 'B', PAGE_KEY));
    await act(async () => {
      answer(UNCONFIRMED);
    });

    expect(screen.queryByText(/ممکن است سفارش ثبت شده باشد/)).toBeNull();
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(window.sessionStorage.getItem(keyFor(PREFIX, IN_B, 'PRD_1'))).toBeNull();
    // A's own, still in doubt, kept for A to reconcile.
    expect(
      JSON.parse(window.sessionStorage.getItem(keyFor(PREFIX, IN_A, 'PRD_1')) ?? 'null'),
    ).toMatchObject({ submissionId: KEY, correlationId: 'COR_ORIGINAL', owner: 'owner-A' });
  });
});
