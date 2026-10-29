import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import { markDisputesOpen, type ReplayStamp } from '@/lib/unresolved-dispute';
import { markAccountOpen } from '@/lib/unresolved-order';
import { QUARANTINE_MARK } from '@/lib/unresolved-tenancy';
import type { Offer } from '@/server/marketplace';
import { bindingOf, keyFor } from '@/test/unresolved-binding';

import { PlaceOrderForm } from './marketplace/[productId]/PlaceOrderForm';
import { DisputeCommands } from './transactions/[id]/DisputeCommands';
import type { PlaceOrderFormState } from './marketplace/[productId]/place-order-form-state';
import type { DisputeFormState } from './transactions/[id]/form-state';
import { QUARANTINE_CONFIRM, QUARANTINE_CONTINUE, QUARANTINE_TITLE } from './UnresolvedQuarantine';

/**
 * PR 405 review 3, R1, through the real forms (PM addendum D): the first
 * send K1 is still out when its form goes away; the person comes back, sets
 * K1 aside with the form's own control, and sends K2 into the same slot. Then
 * K1's answer arrives — a redirect, an UNCONFIRMED, or an UNCONFIRMED whose
 * save storage refuses (the form ignores that save's result). K2 must stay
 * exactly as it was, nothing may be sent again under either key, and K1's
 * outcome must be shown — the fixed, content-free warning, at once.
 *
 * Only the actions and `/auth/session` are scripted.
 */

const placeOrder = jest.fn<Promise<PlaceOrderFormState>, [PlaceOrderFormState, FormData]>();
jest.mock('./marketplace/[productId]/place-order-actions', () => ({
  submitPlaceOrder: (previous: PlaceOrderFormState, form: FormData) => placeOrder(previous, form),
}));
const sendDispute = jest.fn<Promise<DisputeFormState>, [string, DisputeFormState, FormData]>();
jest.mock('./transactions/[id]/actions', () => ({
  submitDisputeCommand: (id: string, previous: DisputeFormState, form: FormData) =>
    sendDispute(id, previous, form),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const K1 = 'sub_FIRSTKEYFIRSTKEYFIRS';
const K2 = 'sub_SECONDKEYSECONDKEYSE';
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const MAX_AGE = 12 * 60 * 60;
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };

const redirect = () =>
  Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/somewhere;307;' });

/** An answer that arrives when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const setAside = () =>
  Object.keys(window.sessionStorage).filter((key) => key.includes(QUARANTINE_MARK));

async function submitIn(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

async function acknowledgeWarning() {
  fireEvent.click(screen.getByLabelText(QUARANTINE_CONFIRM));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: QUARANTINE_CONTINUE }));
  });
}

beforeEach(() => {
  placeOrder.mockReset();
  sendDispute.mockReset();
  global.fetch = (async () => ({ status: 204 })) as unknown as typeof fetch;
  window.sessionStorage.clear();
  markAccountOpen();
  markDisputesOpen();
});

afterEach(() => jest.restoreAllMocks());

/** How the late answer of K1 comes back. */
const LATE = [
  ['a delayed redirect', 'REDIRECT'],
  ['a delayed UNCONFIRMED', 'UNCONFIRMED'],
  ['a delayed UNCONFIRMED whose save storage refuses', 'UNCONFIRMED_UNSAVED'],
] as const;

describe('PlaceOrderForm: K1 set aside, K2 sent, then K1 answers', () => {
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
  const SLOT = keyFor('rasta.unresolved-order.', BINDING, 'PRD_1');
  const page = (submissionId: string) => (
    <PlaceOrderForm
      offers={[OFFER]}
      csrfToken="csrf"
      submissionId={submissionId}
      newOrderHref="/marketplace/PRD_1"
      productId="PRD_1"
      binding={BINDING}
      sessionMaxAgeSeconds={MAX_AGE}
    />
  );
  const unconfirmed = (form: FormData, correlationId: string): PlaceOrderFormState => ({
    kind: 'UNCONFIRMED',
    correlationId,
    submissionId: String(form.get('submission')),
    values: { offerId: String(form.get('offerId')), quantity: String(form.get('quantity')) },
  });
  async function fillAndSend(container: HTMLElement, quantity: string) {
    fireEvent.change(container.querySelector('select[name="offerId"]')!, {
      target: { value: 'OFR_1' },
    });
    fireEvent.change(container.querySelector('[name="quantity"]')!, {
      target: { value: quantity },
    });
    await submitIn(container);
  }

  it.each(LATE)('%s leaves K2 exactly as it was, and is never sent again', async (_label, late) => {
    // K1 is sent; its answer is out when the person navigates away.
    const k1Answer = deferred<PlaceOrderFormState>();
    placeOrder.mockImplementationOnce(() => k1Answer.promise);
    const first = render(page(K1));
    await fillAndSend(first.container, '3');
    first.unmount();

    // Back on the page: K1's uncertainty view; the person starts a new order (sets K1 aside).
    const second = render(page(K2));
    const link = await screen.findByRole('link', { name: 'شروع سفارش تازه' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    second.unmount();

    // K2 is sent into the same slot, and its outcome is unknown too.
    placeOrder.mockImplementationOnce(async (_previous, form) => unconfirmed(form, 'COR_K2'));
    const third = render(page(K2));
    await fillAndSend(third.container, '7');
    const k2 = window.sessionStorage.getItem(SLOT)!;
    expect(JSON.parse(k2)).toMatchObject({
      submissionId: K2,
      values: { offerId: 'OFR_1', quantity: '7' },
      correlationId: 'COR_K2',
    });

    // Now K1's answer.
    if (late === 'UNCONFIRMED_UNSAVED') {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    }
    await act(async () => {
      if (late === 'REDIRECT') k1Answer.reject(redirect());
      else {
        const form = new FormData();
        form.set('submission', K1);
        form.set('offerId', 'OFR_1');
        form.set('quantity', '3');
        k1Answer.resolve(unconfirmed(form, 'COR_K1_LATE'));
      }
      await k1Answer.promise.catch(() => undefined);
    });
    jest.restoreAllMocks();

    // K2: byte for byte; nothing sent again, under either key.
    expect(window.sessionStorage.getItem(SLOT)).toBe(k2);
    expect(placeOrder.mock.calls.map(([, form]) => form.get('submission'))).toEqual([K1, K2]);

    if (late === 'REDIRECT') {
      // Placed: nothing is unknown about K1 — no warning, K2's view stays.
      expect(setAside()).toEqual([]);
      expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
      expect(third.container.querySelector('[name="submission"]')).toHaveValue(K2);
      return;
    }
    // K1's outcome is shown at once — fixed words, nothing of K1 — beside K2's own
    // uncertainty view, which stays as it was …
    expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('COR_K1_LATE');
    expect(screen.getByText(/COR_K2/)).toBeInTheDocument();
    expect(third.container.querySelector('[name="submission"]')).toHaveValue(K2);
    expect(setAside()).toHaveLength(late === 'UNCONFIRMED' ? 1 : 0);
    // … until acknowledged.
    await acknowledgeWarning();
    expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
    await waitFor(() =>
      expect(third.container.querySelector('[name="submission"]')).toHaveValue(K2),
    );
    expect(window.sessionStorage.getItem(SLOT)).toBe(k2);
  });

  it('a retry of K1 after it was set aside elsewhere is not sent', async () => {
    const k1Answer = deferred<PlaceOrderFormState>();
    placeOrder.mockImplementationOnce(() => k1Answer.promise);
    const first = render(page(K1));
    await fillAndSend(first.container, '3');
    // Its first send comes back in doubt: the retry button is drawn.
    await act(async () => {
      const form = new FormData();
      form.set('submission', K1);
      form.set('offerId', 'OFR_1');
      form.set('quantity', '3');
      k1Answer.resolve(unconfirmed(form, 'COR_K1'));
    });
    // Elsewhere in this tab the person set K1 aside, and K2 took the slot.
    const { clearUnresolvedOrder, saveUnresolvedOrder } =
      jest.requireActual<typeof import('@/lib/unresolved-order')>('@/lib/unresolved-order');
    clearUnresolvedOrder('PRD_1', K1, BINDING);
    saveUnresolvedOrder(
      'PRD_1',
      { submissionId: K2, values: { offerId: 'OFR_1', quantity: '7' }, correlationId: null },
      BINDING,
    );
    const k2 = window.sessionStorage.getItem(SLOT);
    await submitIn(first.container);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(SLOT)).toBe(k2);
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  });
});

describe('DisputeCommandForm: K1 set aside, K2 sent, then K1 answers', () => {
  const SLOT = keyFor('rasta.unresolved-dispute.', BINDING, 'TXN_1');
  /** What the transaction page draws: it restores an unresolved command first. */
  const page = (submissionId: string, replay: ReplayStamp = STAMP) => (
    <DisputeCommands
      transactionId="TXN_1"
      commands={['DISPUTE']}
      csrfToken="csrf"
      submissions={{ DISPUTE: { id: submissionId, replay } }}
      binding={BINDING}
      sessionMaxAgeSeconds={MAX_AGE}
    />
  );
  const unconfirmed = (
    submissionId: string,
    reason: string,
    correlationId: string,
  ): Extract<DisputeFormState, { kind: 'UNCONFIRMED' }> => ({
    kind: 'UNCONFIRMED',
    command: 'DISPUTE',
    correlationId,
    submissionId,
    values: { ...EMPTY_DISPUTE_FORM, reason },
    replay: STAMP,
  });
  async function typeAndSend(container: HTMLElement, reason: string) {
    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    fireEvent.change(container.querySelector('textarea')!, { target: { value: reason } });
    await submitIn(container);
  }

  it.each(LATE)('%s leaves K2 exactly as it was, and is never sent again', async (_label, late) => {
    const k1Answer = deferred<DisputeFormState>();
    sendDispute.mockImplementationOnce(() => k1Answer.promise);
    // K1's own deadline for a re-send: a minute.
    const k1Stamp = { token: 'k1-replay-stamp', until: Date.now() + 60 * 1000 };
    const first = render(page(K1, k1Stamp));
    await typeAndSend(first.container, 'کالا نرسید و پاسخی هم نیامد');
    first.unmount();

    // Back on the page after K1's replay deadline: its view is view-only and offers
    // "set it aside" — the person does.
    const later = Date.now() + 2 * 60 * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
    const second = render(page(K2));
    const link = await screen.findByRole('link', { name: /این درخواست را کنار بگذار/ });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    second.unmount();
    clock.mockRestore();
    expect(window.sessionStorage.getItem(SLOT)).toBeNull();

    // K2 into the same slot, unconfirmed too.
    sendDispute.mockImplementationOnce(async () =>
      unconfirmed(K2, 'متن تازه برای اعتراض دوم', 'COR_K2'),
    );
    const third = render(page(K2));
    await typeAndSend(third.container, 'متن تازه برای اعتراض دوم');
    const k2 = window.sessionStorage.getItem(SLOT)!;
    expect(JSON.parse(k2)).toMatchObject({
      submissionId: K2,
      text: 'متن تازه برای اعتراض دوم',
      replay: STAMP,
    });

    if (late === 'UNCONFIRMED_UNSAVED') {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    }
    await act(async () => {
      if (late === 'REDIRECT') k1Answer.reject(redirect());
      else {
        k1Answer.resolve({
          ...unconfirmed(K1, 'کالا نرسید و پاسخی هم نیامد', 'COR_K1_LATE'),
          replay: k1Stamp,
        });
      }
      await k1Answer.promise.catch(() => undefined);
    });
    jest.restoreAllMocks();

    // K2's key, text, deadline: byte for byte. Nothing sent again under either key.
    expect(window.sessionStorage.getItem(SLOT)).toBe(k2);
    expect(sendDispute.mock.calls.map(([, , form]) => form.get('submission'))).toEqual([K1, K2]);

    if (late === 'REDIRECT') {
      expect(setAside()).toEqual([]);
      expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
      return;
    }
    expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('COR_K1_LATE');
    expect(screen.getByText(/COR_K2/)).toBeInTheDocument();
    expect(third.container.querySelector('[name="submission"]')).toHaveValue(K2);
    expect(setAside()).toHaveLength(late === 'UNCONFIRMED' ? 1 : 0);
    await acknowledgeWarning();
    expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
    await waitFor(() =>
      expect(third.container.querySelector('[name="submission"]')).toHaveValue(K2),
    );
    expect(window.sessionStorage.getItem(SLOT)).toBe(k2);
  });
});
