import { Component, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { refuseBeforeBody } from '@/server/request-gate';
import { sealSession, type WebSession } from '@/server/session';
import type { Offer } from '@/server/marketplace';

import { markAccountOpen, purgeAllUnresolvedOrders } from '@/lib/unresolved-order';

import { PlaceOrderForm, type PlaceOrderFormProps } from './PlaceOrderForm';
import type { PlaceOrderFormState } from './place-order-form-state';

/**
 * What survives a reload, the sort form's GET navigation, a call the gate
 * refuses and a re-login — with the real `useActionState`, the real storage
 * module and, for the expired session, the real request gate in front of the
 * action. Only the action's own body is scripted: it is the one thing a
 * component test cannot run.
 */

const submit = jest.fn<Promise<PlaceOrderFormState>, [PlaceOrderFormState, FormData]>();
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
const STORAGE_KEY = 'rasta.unresolved-order.PRD_1'; // gitleaks:allow

const LOGIN_1 = { owner: 'owner-1', session: 'login-1' };
const LOGIN_2 = { owner: 'owner-1', session: 'login-2' };
const OTHER_PERSON = { owner: 'owner-2', session: 'login-9' };

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
    STORAGE_KEY,
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

    expect(stored()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
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

  it('another person’s entry is not shown, and is removed', async () => {
    plant({}, OTHER_PERSON);
    const { container } = loadPage();

    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
    expect(screen.queryByText(/ممکن است سفارش ثبت شده باشد/)).toBeNull();
  });

  it('an entry older than the session lifetime is discarded', async () => {
    plant({ savedAt: Date.now() - (SESSION_MAX_AGE + 5) * 1000 });
    const { container } = loadPage();

    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
  });

  it.each([
    ['not JSON', 'not json'],
    ['the wrong shape', JSON.stringify({ v: 1, submissionId: 'x' })],
    ['a submission id that is not one', JSON.stringify({ v: 1, submissionId: '<img src=x>' })],
  ])('treats an entry that is %s as none', async (_name, raw) => {
    window.sessionStorage.setItem(STORAGE_KEY, raw);
    const { container } = loadPage();
    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
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

    expect(screen.getByText(/ممکن است سفارش ثبت شده باشد/)).toBeInTheDocument();
    expect(container.querySelector('[name="submission"]')).toHaveValue(PAGE_KEY);
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

    expect(screen.getByText(/ممکن است سفارش ثبت شده باشد/)).toBeInTheDocument();
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

  it('a quantity the action could never have accepted is still dropped on restore', async () => {
    plant({ values: { offerId: 'OFR_1', quantity: '0' } });
    loadPage();
    await waitFor(() => expect(stored()).toBeNull());
  });
});
