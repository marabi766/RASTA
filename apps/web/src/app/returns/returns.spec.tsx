import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { RETURN_DONE_MESSAGES, RETURN_ORDER_NOT_COMPLETED_NOTE } from '@/lib/return-fields';
import type { ReadResult } from '@/server/assets';
import type { ReturnPage, ReturnRequest, ReturnShipment } from '@/server/returns';
import {
  AUTHORIZED,
  CANCELLED,
  INSPECTED_SHIPMENT,
  LINE_A,
  LINE_B,
  ORDER_ID,
  REQUESTED,
  RETURN_ID,
} from '@/test/return-fixtures';

import { OrderReturns } from '../orders/[id]/OrderReturns';
import { ReturnDetailScreen } from './[id]/ReturnDetailScreen';
import { ReturnCommandForm } from './ReturnCommandForm';
import { ReturnsScreen } from './ReturnsScreen';
import type { ReturnFormState } from './return-form-state';

/**
 * The return screens in every state they can be in, each checked with axe:
 * the list on both sides, one request with what this viewer may do and where
 * the goods are, the returns part of an order, and every banner a form can
 * show. Never a refund, never a person's id, never the service's sentence.
 */

jest.mock('./return-actions', () => ({
  submitReturnRequest: jest.fn(),
  submitReturnCommand: jest.fn(),
}));

const BINDING = { owner: 'owner-tag-A', session: 'session-tag-1' };
const STAMP = { token: 'stamp', until: Date.now() + 50 * 60 * 1000 };
const NAMES = new Map([
  [LINE_A, 'شن و ماسه'],
  [LINE_B, 'سیمان'],
]);
const page = (items: ReturnRequest[]): ReadResult<ReturnPage> => ({
  kind: 'OK',
  data: { items, nextCursor: null },
});
const UNAVAILABLE = { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR-1' } as const;

beforeEach(() => window.sessionStorage.clear());

describe('the list', () => {
  it.each([
    ['the buyer’s requests, one needing action', page([REQUESTED, CANCELLED]), 'BUYER'],
    [
      'the supplier’s, with the next page',
      { kind: 'OK', data: { items: [REQUESTED], nextCursor: 'RET_0' } },
      'SUPPLIER',
    ],
    ['none, as a buyer', page([]), 'BUYER'],
    ['none, as a supplier', page([]), 'SUPPLIER'],
    ['refused', { kind: 'FORBIDDEN' }, 'BUYER'],
    ['unavailable', UNAVAILABLE, 'BUYER'],
    ['no organization', { kind: 'NOT_FOUND' }, 'BUYER'],
  ] as const)('%s', async (_name, result, side) => {
    const { container } = render(
      <ReturnsScreen
        result={result as ReadResult<ReturnPage>}
        query={{ side }}
        actionable={new Set([REQUESTED.id])}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
    expect(container.textContent).not.toMatch(/بازپرداخت شد|USR-/);
  });

  it('says each status in Persian and Persian digits, and cues the action', () => {
    render(
      <ReturnsScreen
        result={page([REQUESTED])}
        query={{ side: 'SUPPLIER' }}
        actionable={new Set([RETURN_ID])}
      />,
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('درخواست‌شده، در انتظار تصمیم تأمین‌کننده');
    expect(row).toHaveTextContent('۳ واحد');
    expect(row).toHaveTextContent('اقدامی از سوی شما لازم است');
    expect(screen.getByRole('link', { name: /درخواست‌ها از ما/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

function renderDetail(overrides: Partial<Parameters<typeof ReturnDetailScreen>[0]> = {}) {
  return render(
    <ReturnDetailScreen
      result={{ kind: 'OK', data: REQUESTED }}
      productNames={NAMES}
      shipments={{ kind: 'OK', data: [] }}
      offered={[]}
      csrfToken="csrf"
      binding={BINDING}
      sessionMaxAgeSeconds={43_200}
      pageHref={`/returns/${RETURN_ID}`}
      {...overrides}
    />,
  );
}

describe('one request', () => {
  it('the supplier, offered both decisions', async () => {
    const { container } = renderDetail({
      offered: [
        { command: 'AUTHORIZE', submission: { id: 'sub_AUTHORIZEAUTHORIZEAU', replay: STAMP } },
        { command: 'REJECT', submission: { id: 'sub_REJECTREJECTREJECTR', replay: STAMP } },
      ],
    });
    expect(await screen.findByRole('form', { name: 'پذیرفتن بازگشت' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'رد درخواست بازگشت' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the buyer of an authorized request, offered the withdrawal, with the goods on their way', async () => {
    const { container } = renderDetail({
      result: { kind: 'OK', data: AUTHORIZED },
      shipments: { kind: 'OK', data: [INSPECTED_SHIPMENT] },
      offered: [
        { command: 'CANCEL', submission: { id: 'sub_CANCELCANCELCANCELC', replay: STAMP } },
      ],
    });
    expect(await screen.findByRole('form', { name: 'لغو درخواست بازگشت' })).toBeInTheDocument();
    const goods = screen.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' });
    expect(goods).toHaveTextContent('بازرسی‌شده، در انتظار تعیین تکلیف');
    expect(goods).toHaveTextContent('هر سه کیسه نم کشیده بود.');
    expect(within(goods).getByRole('list', { name: 'مراحل محمولهٔ بازگشت' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('its history in the order it happened, and the line names from the order', () => {
    renderDetail({ result: { kind: 'OK', data: CANCELLED } });
    const steps = within(screen.getByRole('list', { name: 'سابقهٔ درخواست بازگشت' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(steps.map((step) => step.split(' — ')[0])).toEqual([
      'درخواست بازگشت ثبت شد',
      'تأمین‌کننده بازگشت را پذیرفت',
      'خریدار درخواست را لغو کرد',
    ]);
    expect(screen.getByRole('region', { name: 'کالای درخواستی برای بازگشت' })).toHaveTextContent(
      'شن و ماسه',
    );
    expect(screen.getByText(/اقدامی از سوی شما لازم نیست/)).toBeInTheDocument();
  });

  it('never a refund: it says none happens here', () => {
    renderDetail();
    expect(screen.getByText(/درخواست بازگشت بازپرداخت نیست/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /بازپرداخت/ })).toBeNull();
  });

  it('just confirmed: the signed flash’s sentence', async () => {
    const { container } = renderDetail({
      notice: 'AUTHORIZE',
      result: { kind: 'OK', data: AUTHORIZED },
    });
    expect(screen.getByText(RETURN_DONE_MESSAGES.AUTHORIZE)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['no shipment yet', { kind: 'OK', data: [] }, 'هنوز محموله‌ای'],
    ['the goods’ side not shown to this role', { kind: 'FORBIDDEN' }, 'نشان داده نمی‌شود'],
    ['the goods’ side unavailable', UNAVAILABLE, 'اکنون خوانده نشد'],
  ] as const)('%s', async (_name, shipments, text) => {
    const { container } = renderDetail({
      shipments: shipments as ReadResult<readonly ReturnShipment[]>,
    });
    expect(screen.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' })).toHaveTextContent(text);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('without the order’s names, the product ids', () => {
    renderDetail({ productNames: null });
    expect(screen.getByRole('region', { name: 'کالای درخواستی برای بازگشت' })).toHaveTextContent(
      'PRD_A',
    );
  });

  it.each([
    [
      'absent — missing, or another organization’s',
      { kind: 'NOT_FOUND' },
      'این درخواست بازگشت پیدا نشد',
    ],
    ['refused', { kind: 'FORBIDDEN' }, 'در اختیار نقش شما نیست'],
    ['unavailable', UNAVAILABLE, 'خوانده نشد'],
  ] as const)('%s', async (_name, result, text) => {
    const { container } = renderDetail({
      result: result as ReadResult<ReturnRequest>,
      shipments: null,
    });
    expect(container).toHaveTextContent(text);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the returns part of an order', () => {
  const LINES = [
    { orderLineId: LINE_A, productName: 'شن و ماسه', sold: 10, available: 7 },
    { orderLineId: LINE_B, productName: 'سیمان', sold: 20, available: 20 },
  ];
  const props = {
    orderId: ORDER_ID,
    lines: LINES,
    csrfToken: 'csrf',
    binding: BINDING,
    sessionMaxAgeSeconds: 43_200,
    pageHref: `/orders/${ORDER_ID}`,
    notCompleted: false,
  };

  it('the buyer of a completed order: its requests and the form, each line with what it allows', async () => {
    const { container } = render(
      <OrderReturns
        {...props}
        requests={page([REQUESTED])}
        offered={[
          { command: 'REQUEST', submission: { id: 'sub_REQUESTREQUESTREQUE', replay: STAMP } },
        ]}
      />,
    );
    const form = await screen.findByRole('form', { name: 'درخواست بازگشت کالا' });
    expect(within(form).getByLabelText('تعداد بازگشتی — شن و ماسه')).toBeInTheDocument();
    expect(form).toHaveTextContent('قابل بازگشت: ۷');
    expect(screen.getByRole('list', { name: 'درخواست‌های بازگشت این سفارش' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [
      'the buyer of an order not completed',
      { notCompleted: true, requests: page([]) },
      RETURN_ORDER_NOT_COMPLETED_NOTE,
    ],
    ['the supplier, none asked', { requests: page([]) }, 'درخواست بازگشتی ثبت نشده'],
    ['the requests unavailable', { requests: UNAVAILABLE }, 'اکنون خوانده نشد'],
    ['the requests refused to this role', { requests: { kind: 'FORBIDDEN' } }, 'نشان داده نمی‌شود'],
  ] as const)('%s', async (_name, overrides, text) => {
    const { container } = render(
      <OrderReturns
        {...props}
        offered={[]}
        {...(overrides as Partial<Parameters<typeof OrderReturns>[0]>)}
        requests={overrides.requests as ReadResult<ReturnPage>}
      />,
    );
    expect(container).toHaveTextContent(text);
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('what a form says after an attempt', () => {
  it.each<[string, ReturnFormState, RegExp]>([
    ['session ended', { kind: 'REFUSED', reason: 'NO_SESSION' }, /نشست/],
    ['session unavailable for now', { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' }, /نشست/],
    ['the form’s deadline passed', { kind: 'REFUSED', reason: 'REPLAY' }, /مهلت این فرم/],
    [
      'refused for this organization or role',
      { kind: 'FORBIDDEN', correlationId: 'COR-9' },
      /COR-9/,
    ],
    ['gone', { kind: 'NOT_FOUND' }, /دیگر در دسترس نیست/],
    ['not remembered, not sent', { kind: 'STORAGE_UNAVAILABLE' }, /دو بار ثبت شود/],
    ['another command in doubt', { kind: 'HELD' }, /نتیجه‌اش هنوز معلوم نیست/],
    [
      'a refusal in fixed words',
      {
        kind: 'INVALID',
        command: 'AUTHORIZE',
        submissionId: 'sub_AUTHORIZEAUTHORIZEAU',
        values: null,
        fieldErrors: {},
        message: 'بازگشت کالا هنوز در این سامانه باز نیست',
      },
      /هنوز در این سامانه باز نیست/,
    ],
  ])('%s', async (_name, initial, text) => {
    const { container } = render(
      <ReturnCommandForm
        scope={{ kind: 'RETURN', returnId: RETURN_ID }}
        command="AUTHORIZE"
        csrfToken="csrf"
        submissionId="sub_AUTHORIZEAUTHORIZEAU"
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={43_200}
        pageHref={`/returns/${RETURN_ID}`}
        initial={initial}
      />,
    );
    expect(container.textContent).toMatch(text);
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each<[string, Partial<Extract<ReturnFormState, { kind: 'UNCONFIRMED' }>>]>([
    ['retryable', {}],
    ['from another login', { viewOnly: true }],
    ['past the deadline', { viewOnly: true, replayExpired: true, replay: null }],
    ['the logout marker', { viewOnly: true, marker: true, replay: null, body: null }],
    ['the session ended', { sessionEnded: true }],
  ])('unconfirmed, %s', async (_name, overrides) => {
    const { container } = render(
      <ReturnCommandForm
        scope={{ kind: 'ORDER', orderId: ORDER_ID }}
        command="REQUEST"
        csrfToken="csrf"
        submissionId="sub_REQUESTREQUESTREQUE"
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={43_200}
        pageHref={`/orders/${ORDER_ID}`}
        initial={{
          kind: 'UNCONFIRMED',
          command: 'REQUEST',
          correlationId: 'COR-1',
          submissionId: 'sub_REQUESTREQUESTREQUE',
          body: { reason: REQUESTED.reason, lines: [{ orderLineId: LINE_A, quantity: 3 }] },
          replay: STAMP,
          ...overrides,
        }}
      />,
    );
    expect(container.textContent).toMatch(/ممکن است انجام شده باشد/);
    expect(await axe(container)).toHaveNoViolations();
  });
});
