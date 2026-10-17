import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { formatMoney } from '@/lib/format';
import type { Offer } from '@/server/marketplace';

import { PlaceOrderForm } from './PlaceOrderForm';
import type { PlaceOrderFormState } from './place-order-form-state';

/**
 * `PlaceOrderForm`, in every state its own action can put it in. Same technique
 * as `top-up-form.spec.tsx`: `useActionState` is stubbed so a state can be
 * rendered directly without a server action running.
 */

let currentState: PlaceOrderFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/marketplace/PRD_1#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

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

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function renderForm(state: PlaceOrderFormState = { kind: 'IDLE' }, isPending = false) {
  currentState = state;
  pending = isPending;
  return render(
    <PlaceOrderForm
      offers={[OFFER, { ...OFFER, id: 'OFR_2', supplierOrganizationId: 'ORG-DEH-0003' }]}
      csrfToken={CSRF}
      submissionId={SUBMISSION}
      newOrderHref="/marketplace/PRD_1"
      productId="PRD_1"
      binding={{ owner: 'owner-tag', session: 'session-tag' }}
      sessionMaxAgeSeconds={3600}
    />,
  );
}

describe('PlaceOrderForm', () => {
  it('carries the CSRF token and the submission id, and no price field', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="csrf"]')).toHaveValue(CSRF);
    expect(container.querySelector('[name="submission"]')).toHaveValue(SUBMISSION);
    expect(container.querySelector('[name*="price" i]')).toBeNull();
    expect(container.querySelector('[name*="amount" i]')).toBeNull();
  });

  it('offers each offer with its supplier, price, minimum and availability', () => {
    const { getAllByRole } = renderForm();
    const options = getAllByRole('option').map((option) => option.textContent);
    expect(options[0]).toBe('انتخاب کنید');
    expect(options[1]).toContain('ORG-DEH-0002');
    expect(options[1]).toContain(formatMoney('300000'));
    expect(options[1]).toContain('کمینه ۲');
    expect(options[1]).toContain('موجودی ۱۵');
  });

  it('does not pre-select an offer', () => {
    const { container } = renderForm();
    expect(container.querySelector('select[name="offerId"]')).toHaveValue('');
  });

  it('says the price is read when the order is placed, and that no bank is connected', () => {
    const { container } = renderForm();
    expect(container.textContent).toMatch(/هنگام ثبت سفارش.*محاسبه/);
    expect(container.textContent).toMatch(/به بانک واقعی وصل\s*نیست/);
    expect(container.textContent).toMatch(/شبیه‌سازی/);
    // Not a payment box, and not a promise that it is done.
    expect(container.textContent).not.toMatch(/پرداخت امن|درگاه|کارت/);
    expect(container.textContent).not.toMatch(/سفارش شما تأیید شد|پرداخت شد/);
  });

  it('shows the field errors the service named, on the fields', () => {
    const { getByText, container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { offerId: 'OFR_1', quantity: '0' },
      fieldErrors: { quantity: 'تعداد باید دست‌کم ۱ باشد' },
      message: null,
    });
    expect(getByText('تعداد باید دست‌کم ۱ باشد')).toBeInTheDocument();
    expect(container.querySelector('[name="quantity"]')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the person’s choice after a refusal — the select-reset pattern', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { offerId: 'OFR_2', quantity: '5' },
      fieldErrors: {},
      message: 'سفارش با شرایط کنونی این پیشنهاد جور نیست',
    });
    expect(container.querySelector('select[name="offerId"]')).toHaveValue('OFR_2');
    expect(container.querySelector('[name="quantity"]')).toHaveValue('5');
  });

  it('carries the new submission id of a refused attempt, not the page’s', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { offerId: 'OFR_1', quantity: '0' },
      fieldErrors: {},
      message: null,
    });
    expect(container.querySelector('[name="submission"]')).toHaveValue('sub_BBBBBBBBBBBBBBBBBBBB');
  });

  it('shows the business refusal as a sentence, not a failure', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { offerId: 'OFR_1', quantity: '1' },
      fieldErrors: {},
      message: 'سازمان شما نمی‌تواند از پیشنهاد خودش سفارش بدهد.',
    });
    expect(getByText('سازمان شما نمی‌تواند از پیشنهاد خودش سفارش بدهد.')).toBeInTheDocument();
  });

  it('says an offer that is gone is gone, and that nothing was ordered', () => {
    const { getByText } = renderForm({
      kind: 'NOT_FOUND',
      submissionId: SUBMISSION,
      values: { offerId: 'OFR_1', quantity: '1' },
    });
    expect(getByText(/این پیشنهاد دیگر در دسترس نیست و سفارشی ثبت نشد/)).toBeInTheDocument();
  });

  it('shows a session-expired banner distinctly from a tampered-request banner', () => {
    expect(
      renderForm({ kind: 'REFUSED', reason: 'NO_SESSION' }).getByText(/نشست شما پایان یافته/),
    ).toBeInTheDocument();
    expect(
      renderForm({ kind: 'REFUSED', reason: 'CSRF' }).getByText(/این درخواست معتبر شناخته نشد/),
    ).toBeInTheDocument();
  });

  it('a session only unavailable: says so, not "ended", with no accessibility violations', async () => {
    const { container, getByText, queryByText } = renderForm({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(getByText(/همین حالا در دسترس نیست/)).toBeInTheDocument();
    expect(queryByText(/پایان یافته/)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the correlation id on a forbidden attempt', () => {
    expect(
      renderForm({ kind: 'FORBIDDEN', correlationId: 'COR_1' }).getByText(/COR_1/),
    ).toBeInTheDocument();
  });

  describe('an unconfirmed order', () => {
    const UNCONFIRMED: PlaceOrderFormState = {
      kind: 'UNCONFIRMED',
      correlationId: 'COR_3',
      submissionId: 'sub_CCCCCCCCCCCCCCCCCCCC',
      values: { offerId: 'OFR_2', quantity: '5' },
    };

    it('never claims nothing was ordered, and links to the orders list', () => {
      const { container, getByRole } = renderForm(UNCONFIRMED);
      expect(container.textContent).toMatch(/ممکن است سفارش ثبت شده باشد/);
      expect(container.textContent).not.toMatch(/سفارش ثبت نشد|سفارشی ثبت نشد/);
      expect(container.textContent).toContain('COR_3');
      expect(getByRole('link', { name: /فهرست سفارش/ })).toHaveAttribute('href', '/orders');
    });

    it('after a refused retry keeps the warning, the orders link and the submission id, and says the outcome is unknown', () => {
      const { container, getByRole } = renderForm({ ...UNCONFIRMED, retryRefused: true });
      expect(container.textContent).toMatch(
        /ارسال دوباره رد شد و نتیجهٔ درخواست نخست همچنان معلوم نیست/,
      );
      expect(container.textContent).toMatch(/ممکن است سفارش ثبت شده باشد/);
      expect(container.textContent).not.toMatch(/سفارش ثبت نشد|سفارشی ثبت نشد/);
      expect(container.textContent).toContain('COR_3');
      expect(getByRole('link', { name: /فهرست سفارش/ })).toHaveAttribute('href', '/orders');
      expect(container.querySelector('[name="submission"]')).toHaveValue(
        'sub_CCCCCCCCCCCCCCCCCCCC',
      );
    });

    it('after a retry whose outcome is unknown keeps the original correlation id and the retry button', () => {
      const { container, getByRole } = renderForm({ ...UNCONFIRMED, retryUnknown: true });
      expect(container.textContent).toMatch(/ارسال دوباره نیز نتیجهٔ روشنی نداشت/);
      expect(container.textContent).toContain('COR_3');
      expect(container.textContent).not.toMatch(/ارسال دوباره رد شد/);
      expect(getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    });

    it('after the session ended says to sign in again and check the orders list, with no retry button', () => {
      const { container, getByRole, queryByRole } = renderForm({
        ...UNCONFIRMED,
        sessionEnded: true,
      });
      expect(container.textContent).toMatch(/نشست شما پایان یافته است. دوباره وارد شوید/);
      expect(container.textContent).toMatch(/فهرست سفارش‌ها را\s*ببینید/);
      expect(container.textContent).toContain('COR_3');
      expect(queryByRole('button')).toBeNull();
      expect(getByRole('link', { name: 'شروع سفارش تازه' })).toBeInTheDocument();
    });

    it('a restored order of another login is shown without a retry button, and says to check the orders list', () => {
      const { container, queryByRole } = renderForm({ ...UNCONFIRMED, viewOnly: true });
      expect(container.textContent).toMatch(/در نشست پیشین فرستاده شده بود/);
      expect(container.textContent).toMatch(/فهرست سفارش‌ها را ببینید/);
      expect(container.textContent).toContain('COR_3');
      expect(queryByRole('button')).toBeNull();
    });

    it('retries with the kept values and the kept submission id, not the page’s', () => {
      const { container, getByRole } = renderForm(UNCONFIRMED);
      expect(container.querySelector('[name="submission"]')).toHaveValue(
        'sub_CCCCCCCCCCCCCCCCCCCC',
      );
      expect(container.querySelector('[name="offerId"]')).toHaveValue('OFR_2');
      expect(container.querySelector('[name="quantity"]')).toHaveValue('5');
      expect(container.querySelector('[name="csrf"]')).toHaveValue(CSRF);
      expect(getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    });

    it('offers a new order as a separate, labelled action — a navigation, not a submit', () => {
      const { getByRole, getAllByRole } = renderForm(UNCONFIRMED);
      expect(getByRole('link', { name: 'شروع سفارش تازه' })).toHaveAttribute(
        'href',
        '/marketplace/PRD_1',
      );
      expect(getAllByRole('button')).toHaveLength(1);
    });
  });

  it('disables submission while pending', () => {
    const { getByRole } = renderForm({ kind: 'IDLE' }, true);
    expect(getByRole('button', { name: /در حال ثبت/ })).toBeDisabled();
  });

  it('uses logical CSS only — no physical left/right', () => {
    const { container } = renderForm();
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|left|right)-/);
  });

  it.each<[string, PlaceOrderFormState]>([
    ['idle', { kind: 'IDLE' }],
    [
      'invalid',
      {
        kind: 'INVALID',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '0' },
        fieldErrors: { quantity: 'تعداد باید دست‌کم ۱ باشد', offerId: 'پیشنهاد را انتخاب کنید' },
        message: 'پیام',
      },
    ],
    [
      'unconfirmed',
      {
        kind: 'UNCONFIRMED',
        correlationId: 'COR_3',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '2' },
      },
    ],
    [
      'unconfirmed, retry refused',
      {
        kind: 'UNCONFIRMED',
        correlationId: 'COR_3',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '2' },
        retryRefused: true,
      },
    ],
    [
      'unconfirmed, retry unknown',
      {
        kind: 'UNCONFIRMED',
        correlationId: 'COR_3',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '2' },
        retryUnknown: true,
      },
    ],
    [
      'unconfirmed, session ended',
      {
        kind: 'UNCONFIRMED',
        correlationId: 'COR_3',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '2' },
        sessionEnded: true,
      },
    ],
    [
      'unconfirmed, restored view only',
      {
        kind: 'UNCONFIRMED',
        correlationId: 'COR_3',
        submissionId: SUBMISSION,
        values: { offerId: 'OFR_1', quantity: '2' },
        viewOnly: true,
      },
    ],
  ])('has no accessibility violations (%s)', async (_name, state) => {
    const { container } = renderForm(state);
    expect(await axe(container)).toHaveNoViolations();
  });
});
