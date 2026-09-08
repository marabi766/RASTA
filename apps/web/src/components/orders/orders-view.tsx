'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  ORDER_STATUS_LABELS,
  listOrders,
  type OrderSide,
  type OrderView,
} from '@/lib/api/adapters/marketplace';
import { formatInteger, formatJalaliDate, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader, cx, type Tone } from '../ui/primitives';
import { Code, DataTable, DataView, Section } from '../ui/data-view';

/**
 * Orders, from either side.
 *
 * `role` is an explicit choice rather than something inferred from the caller's
 * roles: an organization can be both a buyer and a supplier, and guessing which
 * list was meant would silently return the wrong one. The toggle is the API
 * parameter, made visible.
 *
 * Read-only. Placing, confirming, fulfilling and confirming receipt are all
 * real endpoints, and all of them move money or make statements about delivery.
 * An investor preview has no business doing either on a shared dataset.
 */
export function OrdersView(): ReactNode {
  const [role, setRole] = useState<OrderSide>('BUYER');

  const resource = useApiResource((client, signal) => listOrders(client, role, signal), [role]);

  return (
    <>
      <PageHeader
        title="سفارش‌ها"
        description="چرخهٔ عمر سفارش از ثبت تا تسویه. این نسخه فقط می‌خواند؛ هیچ سفارشی ثبت، تأیید یا لغو نمی‌شود."
      />

      <Card className="mb-6">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-[var(--tx2)]">
            سفارش‌ها را از کدام سمت می‌بینید؟
          </legend>
          <div className="flex flex-wrap gap-2">
            {(['BUYER', 'SUPPLIER'] as const).map((side) => (
              <label
                key={side}
                className={cx(
                  'inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-3 text-sm',
                  role === side
                    ? 'border-[var(--pri)] bg-[var(--pri-soft)] font-bold text-[var(--pri-tx)]'
                    : 'border-[var(--control-border)] text-[var(--tx2)]',
                )}
              >
                <input
                  type="radio"
                  name="order-role"
                  value={side}
                  checked={role === side}
                  onChange={() => setRole(side)}
                  className="size-4 accent-[var(--pri)]"
                />
                {side === 'BUYER' ? 'سفارش‌هایی که ثبت کرده‌ایم' : 'سفارش‌هایی که فروشندهٔ آن‌ایم'}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--tx3)]">
            این انتخاب صریح است، چون یک سازمان می‌تواند هم‌زمان خریدار و تأمین‌کننده باشد و حدس زدنِ
            منظور کاربر، بی‌سروصدا فهرست اشتباه را برمی‌گرداند.
          </p>
        </fieldset>
      </Card>

      <DataView
        resource={resource}
        context="فهرست سفارش‌ها"
        loadingLabel="در حال خواندن سفارش‌ها"
        empty={{
          title: 'سفارشی در این نما نیست',
          description:
            role === 'BUYER'
              ? 'این سازمان هنوز سفارشی ثبت نکرده است.'
              : 'سفارشی که این سازمان فروشندهٔ آن باشد ثبت نشده است.',
        }}
      >
        {(orders) => (
          <DataTable
            rows={orders}
            rowKey={(row) => row.id}
            caption={`${formatInteger(orders.length)} سفارش.`}
            minWidth="52rem"
            columns={[
              {
                key: 'id',
                header: 'سفارش',
                render: (row: OrderView) => (
                  <Link
                    href={`/orders/${encodeURIComponent(row.id)}`}
                    className="hover:text-[var(--pri)] hover:underline"
                  >
                    <Code>{row.id}</Code>
                    <span className="mt-0.5 block text-xs text-[var(--tx3)]">
                      {formatInteger(row.lines.length)} قلم
                    </span>
                  </Link>
                ),
              },
              {
                key: 'status',
                header: 'وضعیت',
                render: (row) => <OrderStatusBadge status={row.status} />,
              },
              {
                key: 'counterparty',
                header: role === 'BUYER' ? 'تأمین‌کننده' : 'خریدار',
                render: (row) => (
                  <Code>
                    {role === 'BUYER' ? row.supplierOrganizationId : row.buyerOrganizationId}
                  </Code>
                ),
              },
              {
                key: 'total',
                header: 'مبلغ کل',
                render: (row) => (
                  <span className="font-bold">
                    {formatMoneyMinor(row.totalAmountMinor, row.currency)}
                  </span>
                ),
              },
              {
                key: 'created',
                header: 'ثبت',
                render: (row) => formatJalaliDate(row.createdAt),
              },
            ]}
          />
        )}
      </DataView>

      <Section id="lifecycle-note" title="نکتهٔ چرخهٔ عمر">
        <Card>
          <p className="text-sm text-[var(--tx2)]">
            یازده وضعیت وجود دارد و نبودِ دو یال، کل مدل ایمنی مالی است: از «در اعتراض» هیچ مسیری به
            «در حال تسویه» نیست، و وضعیت‌های پایانی هیچ یال خروجی ندارند. یعنی توقف تسویه هنگام
            اعتراض، یک بررسی فراموش‌شدنی نیست؛ در ساختار وجود ندارد. جزئیات هر سفارش، همین گراف را
            نشان می‌دهد.
          </p>
        </Card>
      </Section>
    </>
  );
}

export function OrderStatusBadge({ status }: { status: string }): ReactNode {
  return (
    <Badge tone={orderTone(status)}>
      <span className="whitespace-nowrap">{ORDER_STATUS_LABELS[status] ?? status}</span>
      <Code>{status}</Code>
    </Badge>
  );
}

export function orderTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED':
    case 'RECEIPT_CONFIRMED':
      return 'success';
    case 'DISPUTED':
    case 'FAILED':
    case 'CANCELLED':
      return 'danger';
    case 'PENDING':
    case 'CANCELLING':
      return 'neutral';
    default:
      return 'warning';
  }
}
