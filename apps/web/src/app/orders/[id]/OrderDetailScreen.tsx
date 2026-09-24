import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  BRANCH_EXPLANATIONS,
  orderStatusLabel,
  stepperFor,
  type OrderCommand,
  type StepState,
} from '@/lib/order-fields';
import type { Order, ReadResult } from '@/server/orders';

import { formatOrderAmount } from '../OrdersScreen';
import { OrderCommandForm } from './OrderCommandForm';

/**
 * One order: where it is, what it contains, and what **this viewer** may do
 * next (docs/16 § ۱۶٫۶ «جزئیات سفارش + Stepper»).
 *
 * ## The stepper shows where the order is; the forms show what you may do
 *
 * They are two different questions and they come from two different places.
 * Where the order is comes from its status and timestamps (`stepperFor`). What
 * the viewer may do comes from `availableActions`, which marketplace-service
 * computed **for this caller** — so the same order, at the same moment, shows
 * its supplier "accept" and its buyer nothing but the wait. Nothing here maps
 * a status to a button; that mapping is the one a client gets wrong.
 *
 * `newSubmissionId` is passed in rather than imported so this stays a pure
 * function of its props, renderable in a test, while the page mints the ids.
 */

export interface OrderDetailScreenProps {
  readonly result: ReadResult<Order>;
  readonly csrfToken: string;
  /** One fresh id per form — `submission.ts`: one per form, never shared. */
  readonly mintSubmissionId: () => string;
  /** The command that just succeeded, from the redirect's query flag. */
  readonly done?: OrderCommand;
}

const STEP_CLASSES: Readonly<Record<StepState, string>> = {
  done: 'border-success text-content',
  current: 'border-focus font-medium text-content',
  upcoming: 'border-border text-content-muted',
  'not-reached': 'border-border text-content-muted line-through',
};

/** What a screen reader says for each step's state — the colour alone is not an answer. */
const STEP_STATE_LABELS: Readonly<Record<StepState, string>> = {
  done: 'انجام‌شده',
  current: 'مرحلهٔ کنونی',
  upcoming: 'پیش رو',
  'not-reached': 'به آن نرسید',
};

function Stepper({ order }: { order: Order }) {
  const steps = stepperFor(order);
  return (
    <ol aria-label="مراحل سفارش" className="flex flex-wrap gap-2">
      {steps.map((step, index) => (
        <li
          key={step.status}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`rounded-md border-2 px-3 py-2 text-sm ${STEP_CLASSES[step.state]}`}
        >
          <span aria-hidden="true">{toPersianDigits(String(index + 1))}. </span>
          {step.label}
          <span className="sr-only"> — {STEP_STATE_LABELS[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}

function Lines({ order }: { order: Order }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">اقلام سفارش</caption>
      <thead>
        <tr className="text-content-muted">
          <th scope="col" className="py-2 text-start font-normal">
            کالا یا خدمت
          </th>
          <th scope="col" className="py-2 text-start font-normal">
            تعداد
          </th>
          <th scope="col" className="py-2 text-start font-normal">
            بهای واحد
          </th>
          <th scope="col" className="py-2 text-start font-normal">
            جمع
          </th>
        </tr>
      </thead>
      <tbody>
        {order.lines.map((line) => (
          <tr key={line.offerId} className="border-t border-border">
            <td className="py-2">{line.productName}</td>
            <td className="py-2">{toPersianDigits(String(line.quantity))}</td>
            <td className="py-2">{formatOrderAmount(line.unitPriceMinor, line.currency)}</td>
            <td className="py-2">{formatOrderAmount(line.lineTotalMinor, line.currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-border-strong font-medium">
          <th scope="row" colSpan={3} className="py-2 text-start">
            مبلغ کل
          </th>
          <td className="py-2">{formatOrderAmount(order.totalAmountMinor, order.currency)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function WhatNext({
  order,
  csrfToken,
  mintSubmissionId,
}: {
  order: Order;
  csrfToken: string;
  mintSubmissionId: () => string;
}) {
  if (order.availableActions.length === 0) {
    // Not "you may not": for a buyer at FUNDS_HELD this is simply the
    // supplier's turn, and for a finished order there is nothing left. The
    // stepper above already says which.
    return <p className="text-sm text-content-muted">در این مرحله اقدامی از سوی شما لازم نیست.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {order.availableActions.map((command) => (
        <OrderCommandForm
          key={command}
          orderId={order.id}
          command={command}
          csrfToken={csrfToken}
          submissionId={mintSubmissionId()}
        />
      ))}
    </div>
  );
}

const DONE_MESSAGES: Readonly<Record<OrderCommand, string>> = {
  CONFIRM: 'سفارش پذیرفته شد.',
  FULFILL: 'تحویل ثبت شد. سفارش منتظر تأیید خریدار است.',
  CONFIRM_RECEIPT: 'دریافت تأیید شد. تسویه با فروشنده آغاز می‌شود.',
  RAISE_DISPUTE: 'اختلاف ثبت شد. تسویه تا تصمیم اپراتور متوقف است.',
  RESOLVE_DISPUTE: 'تصمیم دربارهٔ اختلاف ثبت شد.',
  CANCEL: 'درخواست لغو ثبت شد. پس از بازگشت وجه، سفارش لغوشده می‌شود.',
  REVIEW: 'نظر شما ثبت شد.',
};

export function OrderDetailScreen({
  result,
  csrfToken,
  mintSubmissionId,
  done,
}: OrderDetailScreenProps) {
  if (result.kind === 'NOT_FOUND') {
    // One message for "does not exist" and "not yours": marketplace-service
    // answers 404 for both precisely so nobody can learn an order exists by
    // asking for it, and this screen must not undo that by wording them apart.
    return (
      <EmptyState
        title="سفارشی با این شناسه یافت نشد"
        description="یا این سفارش وجود ندارد، یا سازمان شما طرف آن نیست."
      />
    );
  }

  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="دسترسی به سفارش‌ها در اختیار شما نیست." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="این سفارش خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const order = result.data;
  const branch = BRANCH_EXPLANATIONS[order.status];

  return (
    <div className="flex flex-col gap-4">
      {done ? <Alert tone="success">{DONE_MESSAGES[done]}</Alert> : null}

      <Section headingId="order-summary" title="وضعیت سفارش">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm">
            سفارش <Identifier>{order.id}</Identifier> · ثبت در{' '}
            {formatJalaliDateLong(order.createdAt)}
          </p>
          <StatusBadge status={order.status} label={orderStatusLabel(order.status)} />
        </div>

        {branch ? (
          <Alert tone="warning" className="mt-3">
            {branch}
          </Alert>
        ) : null}
        {order.cancellationReason ? (
          <p className="mt-2 text-sm">دلیل لغو: {order.cancellationReason}</p>
        ) : null}
        {order.failureReason ? (
          <p className="mt-2 text-sm">دلیل ناکامی: {order.failureReason}</p>
        ) : null}

        <div className="mt-4">
          <Stepper order={order} />
        </div>
      </Section>

      <Section headingId="order-next" title="اقدام بعدی شما">
        <WhatNext order={order} csrfToken={csrfToken} mintSubmissionId={mintSubmissionId} />
      </Section>

      <Section headingId="order-lines" title="اقلام و مبلغ">
        <Lines order={order} />
      </Section>
    </div>
  );
}
