import Link from 'next/link';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { IRR, formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import {
  ORDER_LIST_ROLES,
  ORDER_LIST_ROLE_LABELS,
  orderStatusLabel,
  type OrderListRole,
} from '@/lib/order-fields';
import type { Order, OrderListQuery, OrderPage, ReadResult } from '@/server/orders';

/**
 * The order list (docs/16 § ۱۶٫۶, `/orders`).
 *
 * A pure function of what the server read, like `DriversScreen`: every state
 * is renderable in a test. Side, status and paging live in the URL, so no
 * JavaScript is involved and a filtered list is a link somebody can send.
 *
 * ## Two lists, not one
 *
 * An organization is a buyer in one order and a seller in the next, and
 * marketplace-service asks which side you mean rather than guessing from the
 * role (`listOrdersQuerySchema.role`). So the screen asks too: a tab per side.
 * Merging them into one list would put "orders we must pay for" beside "orders
 * we must deliver" with nothing but a column to tell them apart.
 */

export interface OrdersScreenProps {
  readonly result: ReadResult<OrderPage>;
  readonly query: OrderListQuery;
}

function hrefWith(query: OrderListQuery, changes: Partial<OrderListQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams({ role: merged.role });
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  return `/orders?${params.toString()}`;
}

/**
 * An amount, formatted from the string it arrived as.
 *
 * Only IRR has a known format today. Any other currency is shown as its
 * digits and its code rather than labelled as rials — a wrong unit on an
 * amount is worse than an unformatted one.
 */
export function formatOrderAmount(minorUnits: string, currency: string): string {
  if (currency === IRR.code) return formatMoney(minorUnits, IRR);
  return `${toPersianDigits(minorUnits)} ${currency}`;
}

function SideTabs({ query }: { query: OrderListQuery }) {
  return (
    <nav aria-label="سمت سفارش" className="flex flex-wrap gap-2">
      {ORDER_LIST_ROLES.map((role: OrderListRole) => (
        <Link
          key={role}
          href={hrefWith(query, { role, cursor: undefined, status: undefined })}
          aria-current={role === query.role ? 'page' : undefined}
          className={
            role === query.role
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {ORDER_LIST_ROLE_LABELS[role]}
        </Link>
      ))}
    </nav>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/orders/${encodeURIComponent(order.id)}`} className="font-medium underline">
          سفارش <Identifier>{order.id}</Identifier>
        </Link>
        <StatusBadge status={order.status} label={orderStatusLabel(order.status)} />
      </div>
      <p className="mt-2 text-sm">
        مبلغ کل:{' '}
        <span className="font-medium">
          {formatOrderAmount(order.totalAmountMinor, order.currency)}
        </span>
      </p>
      <p className="mt-1 text-sm text-content-muted">
        {toPersianDigits(String(order.lines.length))} قلم · ثبت در{' '}
        {formatJalaliDateLong(order.createdAt)}
      </p>
      {order.availableActions.length > 0 ? (
        // A cue, not the actions: they are taken on the order's own page,
        // where the stepper says what each one does.
        <p className="mt-2 text-sm font-medium">اقدامی از سوی شما لازم است</p>
      ) : null}
    </li>
  );
}

export function OrdersScreen({ result, query }: OrdersScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      <SideTabs query={query} />
      <OrdersBody result={result} query={query} />
    </div>
  );
}

function OrdersBody({ result, query }: OrdersScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست سفارش‌های این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="سفارشی یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست سفارش‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="orders" title={ORDER_LIST_ROLE_LABELS[query.role]}>
      {page.items.length === 0 ? (
        <EmptyState
          title="سفارشی نیست"
          description={
            query.role === 'SUPPLIER'
              ? 'هنوز سفارشی به این سازمان داده نشده است.'
              : 'این سازمان هنوز سفارشی ثبت نکرده است.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.items.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={hrefWith(query, { cursor: page.nextCursor })} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
