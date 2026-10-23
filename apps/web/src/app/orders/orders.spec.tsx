import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { Order, OrderPage, ReadResult } from '@/server/orders';

import { OrdersScreen, formatOrderAmount } from './OrdersScreen';
import { OrderDetailScreen } from './[id]/OrderDetailScreen';
import type { OrderCommandFormState } from './[id]/form-state';

/**
 * What `/orders` and `/orders/[id]` render.
 *
 * The rule this file exists for: **the detail screen offers exactly the
 * commands the service listed for this viewer, and no others.** The same order
 * at the same moment is rendered twice below — once as its buyer sees it and
 * once as its supplier does — and the two must differ only by what
 * `availableActions` says. In particular, a disputed order whose status would
 * let a naive client infer "confirm receipt" must not get that form unless the
 * service sent it.
 *
 * `useActionState` is stubbed, as in the other portal form specs.
 */

let currentState: OrderCommandFormState = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/orders/ORD_1#action', false] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';

let minted = 0;
const mint = () => `sub_${String(++minted).padStart(20, 'A')}`;

const ORDER: Order = {
  id: 'ORD_1',
  status: 'AWAITING_RECEIPT_CONFIRMATION',
  buyerOrganizationId: 'ORG_BUYER',
  supplierOrganizationId: 'ORG_SUPPLIER',
  totalAmountMinor: '90000000',
  currency: 'IRR',
  lines: [
    {
      id: 'OLN_1',
      offerId: 'OFR_1',
      productId: 'PRD_1',
      productName: 'فیلتر روغن',
      quantity: 2,
      unitPriceMinor: '45000000',
      lineTotalMinor: '90000000',
      currency: 'IRR',
    },
  ],
  confirmedAt: '2026-09-20T08:00:00.000Z',
  fulfilledAt: '2026-09-21T08:00:00.000Z',
  receiptConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  failureReason: null,
  createdAt: '2026-09-19T08:00:00.000Z',
  availableActions: [],
};

const ok = (order: Order): ReadResult<Order> => ({ kind: 'OK', data: order });

const renderDetail = (order: Order) =>
  render(
    <OrderDetailScreen
      demoMode="REAL"
      result={ok(order)}
      csrfToken={CSRF}
      mintSubmissionId={mint}
    />,
  );

const formsOffered = () =>
  screen.queryAllByRole('form').map((f) => f.getAttribute('aria-labelledby'));

beforeEach(() => {
  currentState = { kind: 'IDLE' };
  minted = 0;
});

// ---------------------------------------------------------------------------

describe('one order, two viewers', () => {
  it('shows the buyer the command that releases money, once the goods are delivered', () => {
    renderDetail({ ...ORDER, availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL'] });

    expect(formsOffered()).toEqual([
      'command-CONFIRM_RECEIPT',
      'command-RAISE_DISPUTE',
      'command-CANCEL',
    ]);
  });

  it('shows the supplier of the same order, at the same moment, nothing to do but wait', () => {
    renderDetail({ ...ORDER, availableActions: [] });

    expect(formsOffered()).toEqual([]);
    expect(screen.getByText('در این مرحله اقدامی از سوی شما لازم نیست.')).toBeInTheDocument();
  });

  it('shows a supplier the accept command, and the buyer of that order nothing', () => {
    const atFundsHeld: Order = {
      ...ORDER,
      status: 'FUNDS_HELD',
      confirmedAt: null,
      fulfilledAt: null,
    };

    const { unmount } = renderDetail({ ...atFundsHeld, availableActions: ['CONFIRM'] });
    expect(formsOffered()).toEqual(['command-CONFIRM']);
    unmount();

    renderDetail({ ...atFundsHeld, availableActions: ['RAISE_DISPUTE', 'CANCEL'] });
    expect(formsOffered()).not.toContain('command-CONFIRM');
  });
});

describe('the screen renders what the service sent, and derives nothing', () => {
  it('offers no receipt confirmation on a disputed order the service did not offer it on', () => {
    // A client reading the transition table alone would conclude the buyer
    // may confirm receipt from DISPUTED. The service says otherwise, and the
    // screen follows the service.
    // Neither exit from a dispute is the buyer's — not confirming receipt,
    // not cancelling (ADR-038) — so the service sends nothing, and the screen
    // draws nothing.
    renderDetail({ ...ORDER, status: 'DISPUTED', availableActions: [] });

    expect(formsOffered()).toEqual([]);
    expect(screen.queryByText('تأیید دریافت', { selector: 'h3' })).toBeNull();
    expect(screen.queryByText('لغو سفارش', { selector: 'h3' })).toBeNull();
  });

  it('offers nothing on an order whose status would seem to invite action', () => {
    // AWAITING_RECEIPT_CONFIRMATION "looks like" confirm-receipt time. For a
    // viewer the service gave no actions, the screen must not guess.
    renderDetail({ ...ORDER, availableActions: [] });
    expect(screen.queryAllByRole('form')).toHaveLength(0);
  });

  it('gives every form its own submission id', () => {
    const { container } = renderDetail({
      ...ORDER,
      availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL'],
    });

    const ids = [...container.querySelectorAll(`input[name="${SUBMISSION_FIELD}"]`)].map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(ids).toHaveLength(3);
    // On `orders` the id is a real idempotency key; a shared one would make
    // the second command replay the first's result.
    expect(new Set(ids).size).toBe(3);
  });

  it('carries the CSRF token and the command on every form', () => {
    const { container } = renderDetail({ ...ORDER, availableActions: ['CONFIRM_RECEIPT'] });
    const form = container.querySelector('form')!;
    expect(form.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(form.querySelector('input[name="command"]')).toHaveValue('CONFIRM_RECEIPT');
  });
});

describe('the command forms', () => {
  it('asks for an acknowledgement before releasing money', () => {
    renderDetail({ ...ORDER, availableActions: ['CONFIRM_RECEIPT'] });
    expect(screen.getByLabelText('می‌دانم این اقدام بازگشت‌پذیر نیست.')).toBeRequired();
    expect(screen.getByText(/تنها اقدامی است که اجازهٔ تسویه/)).toBeInTheDocument();
  });

  it('does not ask for one on a command that can be followed by another', () => {
    renderDetail({ ...ORDER, status: 'FUNDS_HELD', availableActions: ['CONFIRM'] });
    expect(screen.queryByLabelText('می‌دانم این اقدام بازگشت‌پذیر نیست.')).toBeNull();
  });

  it('mirrors the dispute reason limits the service enforces', () => {
    renderDetail({ ...ORDER, availableActions: ['RAISE_DISPUTE'] });
    const reason = screen.getByLabelText(/دلیل اختلاف/);
    expect(reason).toHaveAttribute('minLength', '10');
    expect(reason).toHaveAttribute('maxLength', '1000');
  });

  it('states the minimum in its hint in Persian digits, the attribute staying Latin (L5-09)', () => {
    renderDetail({ ...ORDER, availableActions: ['RAISE_DISPUTE'] });
    expect(screen.getByText(/دست‌کم ۱۰ نویسه/)).toBeInTheDocument();
  });

  it('writes an amount in a currency it cannot format in Persian digits, with its code', () => {
    expect(formatOrderAmount('1250', 'USD')).toBe('۱۲۵۰ USD');
  });

  it('pre-selects no responsibility when resolving a dispute (ADR-052 rule 14)', () => {
    renderDetail({ ...ORDER, status: 'DISPUTED', availableActions: ['RESOLVE_DISPUTE'] });
    const group = screen.getByRole('group', { name: 'مسئول' });
    for (const radio of within(group).getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });

  it('a session only unavailable: says so, not "ended", with no accessibility violations', async () => {
    currentState = { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' };
    const { container } = renderDetail({ ...ORDER, availableActions: ['CONFIRM_RECEIPT'] });
    expect(screen.getByText(/همین حالا در دسترس نیست/)).toBeInTheDocument();
    expect(screen.queryByText(/پایان یافته/)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders a refusal with its correlation id', () => {
    currentState = { kind: 'FORBIDDEN', correlationId: 'corr-7' };
    renderDetail({ ...ORDER, availableActions: ['CONFIRM_RECEIPT'] });
    expect(screen.getByText(/corr-7/)).toBeInTheDocument();
  });

  it('renders an overtaken command as the service’s sentence', () => {
    currentState = {
      kind: 'INVALID',
      command: 'CONFIRM',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: {
        command: 'CONFIRM',
        reason: '',
        note: '',
        trackingReference: '',
        outcome: '',
        resolution: '',
        responsibility: '',
        rating: '',
        comment: '',
        acknowledge: '',
      },
      fieldErrors: {},
      message: 'Order ORD_1 cannot move from DISPUTED to CONFIRMED',
    };
    renderDetail({ ...ORDER, status: 'FUNDS_HELD', availableActions: ['CONFIRM'] });
    expect(screen.getByText(/cannot move from DISPUTED/)).toBeInTheDocument();
  });
});

describe('the stepper and the amounts', () => {
  it('marks the current step for assistive technology, not only by colour', () => {
    renderDetail(ORDER);
    const current = screen.getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('تحویل');
    expect(current).toHaveTextContent('مرحلهٔ کنونی');
  });

  it('explains why a disputed order has stopped', () => {
    renderDetail({ ...ORDER, status: 'DISPUTED' });
    expect(screen.getByText(/تسویه متوقف شده/)).toBeInTheDocument();
  });

  it('formats the total from the string it arrived as, in Persian digits', () => {
    renderDetail(ORDER);
    expect(screen.getAllByText(/۹۰٬۰۰۰٬۰۰۰ ریال/).length).toBeGreaterThan(0);
  });

  it('does not label an unknown currency as rials', () => {
    renderDetail({
      ...ORDER,
      currency: 'XAU',
      lines: ORDER.lines.map((l) => ({ ...l, currency: 'XAU' })),
    });
    expect(screen.queryByText(/ریال/)).toBeNull();
  });
});

describe('an order this viewer may not see', () => {
  it('says the same thing whether it is absent or not theirs', () => {
    render(
      <OrderDetailScreen
        demoMode="REAL"
        result={{ kind: 'NOT_FOUND' }}
        csrfToken={CSRF}
        mintSubmissionId={mint}
      />,
    );
    // marketplace-service answers 404 for both precisely so an order's
    // existence cannot be learned by asking for it.
    expect(screen.getByText('سفارشی با این شناسه یافت نشد')).toBeInTheDocument();
  });
});

describe('the list', () => {
  const page = (items: Order[]): ReadResult<OrderPage> => ({
    kind: 'OK',
    data: { items, nextCursor: null },
  });

  it('marks the side being shown, and links to the other', () => {
    render(<OrdersScreen demoMode="REAL" result={page([ORDER])} query={{ role: 'SUPPLIER' }} />);
    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('به ما داده شده');
    expect(screen.getByRole('link', { name: 'سفارش‌هایی که ثبت کرده‌ایم' })).toHaveAttribute(
      'href',
      '/orders?role=BUYER',
    );
  });

  it('flags an order waiting on this viewer, without offering the action here', () => {
    render(
      <OrdersScreen
        demoMode="REAL"
        result={page([{ ...ORDER, availableActions: ['CONFIRM_RECEIPT'] }])}
        query={{ role: 'BUYER' }}
      />,
    );
    expect(screen.getByText('اقدامی از سوی شما لازم است')).toBeInTheDocument();
    expect(screen.queryAllByRole('form')).toHaveLength(0);
  });

  it('tells an empty supplier list from an empty buyer list', () => {
    render(<OrdersScreen demoMode="REAL" result={page([])} query={{ role: 'SUPPLIER' }} />);
    expect(screen.getByText('هنوز سفارشی به این سازمان داده نشده است.')).toBeInTheDocument();
  });
});

describe('an order that was just placed', () => {
  it('says it was placed and that it is not settled, claiming no payment and no acceptance', () => {
    const { container } = render(
      <OrderDetailScreen
        demoMode="REAL"
        result={ok(ORDER)}
        csrfToken={CSRF}
        mintSubmissionId={mint}
        placed
      />,
    );
    expect(screen.getByText(/سفارش ثبت شد/)).toBeInTheDocument();
    expect(container.textContent).toMatch(/هنوز قطعی نیست/);
    expect(container.textContent).not.toMatch(/پرداخت شد|پذیرفته شد/);
  });

  it('says nothing of the kind on an ordinary visit', () => {
    renderDetail(ORDER);
    expect(screen.queryByText(/سفارش ثبت شد/)).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no violations on the detail screen with every form a buyer can see', async () => {
    const { container } = renderDetail({
      ...ORDER,
      availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL'],
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the dispute resolution form', async () => {
    const { container } = renderDetail({
      ...ORDER,
      status: 'DISPUTED',
      availableActions: ['RESOLVE_DISPUTE'],
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the list', async () => {
    const { container } = render(
      <OrdersScreen
        demoMode="REAL"
        result={{ kind: 'OK', data: { items: [ORDER], nextCursor: null } }}
        query={{ role: 'BUYER' }}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the order page while the provider is unknown (Q-14)', () => {
  const renderUnknown = (order: Order) =>
    render(
      <OrderDetailScreen
        result={ok(order)}
        csrfToken={CSRF}
        mintSubmissionId={mint}
        demoMode="UNKNOWN"
      />,
    );
  const WITHHELD = 'اقدام‌های مالی این سفارش اکنون در دسترس نیست';

  it('says so in place of the label, and withholds what releases money but not the dispute that stops it', () => {
    renderUnknown({ ...ORDER, availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL'] });
    expect(screen.getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
    expect(screen.getByText(WITHHELD)).toBeInTheDocument();
    expect(formsOffered()).toEqual(['command-RAISE_DISPUTE']);
  });

  // Codex PR-361 r2: accepting and recording delivery move no money — the saga
  // only waits on — so a disclosure outage must not stop a supplier's work.
  it.each([
    ['FUNDS_HELD', 'CONFIRM'],
    ['CONFIRMED', 'FULFILL'],
  ] as const)('offers the supplier of a %s order %s, and withholds nothing', (status, command) => {
    renderUnknown({ ...ORDER, status, availableActions: [command] });
    expect(screen.getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
    expect(screen.queryByText(WITHHELD)).toBeNull();
    expect(formsOffered()).toEqual([`command-${command}`]);
  });

  it.each([
    ['DISPUTED', 'RESOLVE_DISPUTE'],
    ['AWAITING_RECEIPT_CONFIRMATION', 'CONFIRM_RECEIPT'],
    ['CONFIRMED', 'CANCEL'],
  ] as const)('withholds %s → %s, which settles or refunds', (status, command) => {
    renderUnknown({ ...ORDER, status, availableActions: [command] });
    expect(screen.getByText(WITHHELD)).toBeInTheDocument();
    expect(formsOffered()).toEqual([]);
  });

  it('offers the same commands once the provider is known', () => {
    for (const demoMode of ['SIMULATED', 'REAL'] as const) {
      const { unmount } = render(
        <OrderDetailScreen
          result={ok({ ...ORDER, availableActions: ['CONFIRM_RECEIPT', 'CANCEL'] })}
          csrfToken={CSRF}
          mintSubmissionId={mint}
          demoMode={demoMode}
        />,
      );
      expect(screen.queryByText(WITHHELD)).toBeNull();
      expect(formsOffered()).toEqual(['command-CONFIRM_RECEIPT', 'command-CANCEL']);
      unmount();
    }
  });

  it('withholds nothing when only a review is offered', () => {
    renderUnknown({ ...ORDER, status: 'COMPLETED', availableActions: ['REVIEW'] });
    expect(screen.queryByText(/اکنون در دسترس نیست/)).toBeNull();
    expect(formsOffered()).toEqual(['command-REVIEW']);
  });

  it('says so on the list too', () => {
    render(
      <OrdersScreen
        result={{ kind: 'OK', data: { items: [ORDER], nextCursor: null } }}
        query={{ role: 'BUYER' }}
        demoMode="UNKNOWN"
      />,
    );
    expect(screen.getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
  });
});

describe('the order list and the order page: «حالت نمایشی» (Q-14)', () => {
  it('is drawn when the provider is simulated', () => {
    render(
      <OrdersScreen
        result={{ kind: 'OK', data: { items: [ORDER], nextCursor: null } }}
        query={{ role: 'BUYER' }}
        demoMode="SIMULATED"
      />,
    );
    expect(screen.getByText('حالت نمایشی')).toBeInTheDocument();
  });

  it('is absent when it is not', () => {
    render(
      <OrdersScreen
        result={{ kind: 'OK', data: { items: [ORDER], nextCursor: null } }}
        query={{ role: 'BUYER' }}
        demoMode="REAL"
      />,
    );
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
  });

  it('is drawn on the order page too, and only when simulated', () => {
    const { unmount } = render(
      <OrderDetailScreen
        result={ok(ORDER)}
        csrfToken={CSRF}
        mintSubmissionId={mint}
        demoMode="SIMULATED"
      />,
    );
    expect(screen.getByText('حالت نمایشی')).toBeInTheDocument();
    unmount();
    render(
      <OrderDetailScreen
        demoMode="REAL"
        result={ok(ORDER)}
        csrfToken={CSRF}
        mintSubmissionId={mint}
      />,
    );
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
  });
});
