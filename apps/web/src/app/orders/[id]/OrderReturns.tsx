import Link from 'next/link';

import { Alert, Identifier, StatusBadge } from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  RETURN_ORDER_NOT_COMPLETED_NOTE,
  RETURN_REMAINING_UNKNOWN_NOTE,
  returnStatusLabel,
} from '@/lib/return-fields';
import type { Binding } from '@/lib/unresolved-order';
import type { ReadResult } from '@/server/assets';
import type { OrderReturnRequests } from '@/server/returns';

import type { ReturnFormLine } from '@/app/returns/ReturnCommandForm';
import { ReturnCommands, type OfferedReturnCommand } from '@/app/returns/ReturnCommands';

/**
 * The returns part of one order (EXP-003, RUN-005): the return requests of
 * this order on the side this viewer has in it, and — for the buyer of a
 * completed order — the form that asks for one.
 *
 * Whether the form is drawn is `canRequestReturn` (`server/returns.ts`), a
 * copy of marketplace-service's checks. The return window is the service's
 * configuration and no endpoint reports it (Q-132), so a window that is not
 * configured or has elapsed is learned when the request is refused, in the
 * portal's own words.
 */

export interface OrderReturnsProps {
  readonly orderId: string;
  /** This order's requests on the viewer's side; null when the viewer is neither party. */
  readonly requests: ReadResult<OrderReturnRequests> | null;
  /**
   * The buyer may ask, but what each line still allows could not be counted —
   * not every request of the order was read — so the form is not drawn.
   */
  readonly remainingUnknown?: boolean;
  /** The request form, when the service would take one from this viewer. */
  readonly offered: readonly OfferedReturnCommand[];
  readonly lines: readonly ReturnFormLine[];
  /** The buyer of an order that is not completed: told why there is no form. */
  readonly notCompleted: boolean;
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  readonly pageHref: string;
}

function Requests({ requests }: { requests: ReadResult<OrderReturnRequests> }) {
  if (requests.kind === 'UNAVAILABLE' || requests.kind === 'MALFORMED') {
    return (
      <Alert tone="warning">
        درخواست‌های بازگشت این سفارش اکنون خوانده نشد؛ کمی بعد دوباره ببینید. کد پیگیری:{' '}
        {requests.correlationId}
      </Alert>
    );
  }
  if (requests.kind !== 'OK') {
    return (
      <p className="text-sm text-content-muted">
        درخواست‌های بازگشت این سفارش به نقش شما نشان داده نمی‌شود.
      </p>
    );
  }
  if (requests.data.items.length === 0) {
    return (
      <p className="text-sm text-content-muted">برای این سفارش درخواست بازگشتی ثبت نشده است.</p>
    );
  }
  return (
    <ul aria-label="درخواست‌های بازگشت این سفارش" className="flex flex-col gap-2">
      {requests.data.items.map((request) => (
        <li
          key={request.id}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-3 text-sm"
        >
          <span>
            <Link href={`/returns/${encodeURIComponent(request.id)}`} className="underline">
              درخواست <Identifier>{request.id}</Identifier>
            </Link>{' '}
            · {toPersianDigits(String(request.lines.length))} ردیف · ثبت در{' '}
            {formatJalaliDateLong(request.requestedAt)}
          </span>
          <StatusBadge status={request.status} label={returnStatusLabel(request.status)} />
        </li>
      ))}
    </ul>
  );
}

export function OrderReturns({
  orderId,
  requests,
  offered,
  lines,
  notCompleted,
  remainingUnknown = false,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  pageHref,
}: OrderReturnsProps) {
  return (
    <div className="flex flex-col gap-4">
      {requests ? <Requests requests={requests} /> : null}
      {notCompleted ? (
        <p className="text-sm text-content-muted">{RETURN_ORDER_NOT_COMPLETED_NOTE}</p>
      ) : null}
      {remainingUnknown ? <Alert tone="warning">{RETURN_REMAINING_UNKNOWN_NOTE}</Alert> : null}
      <ReturnCommands
        scope={{ kind: 'ORDER', orderId }}
        offered={offered}
        csrfToken={csrfToken}
        binding={binding}
        sessionMaxAgeSeconds={sessionMaxAgeSeconds}
        lines={lines}
        pageHref={pageHref}
      />
    </div>
  );
}
