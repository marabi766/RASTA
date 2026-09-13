'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ORDER_HAPPY_PATH,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  fetchOrder,
  type OrderStatus,
} from '@/lib/api/adapters/marketplace';
import { formatInteger, formatJalaliDate, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader, cx } from '../ui/primitives';
import { Code, DataTable, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';
import { OrderStatusBadge } from './orders-view';
import { PaymentScenarioGate } from './payment-scenario-gate';

/**
 * One order, with the state machine drawn from the real transition table.
 *
 * The stepper is generated from `ORDER_TRANSITIONS`, copied verbatim from the
 * service, rather than from a picture somebody drew of it. That matters because
 * the interesting facts about this machine are **absences**, and an illustration
 * cannot have an absence:
 *
 *  - `DISPUTED` has no edge to `SETTLING`. A dispute stopping settlement is a
 *    missing edge, not a rule somebody has to remember to check.
 *  - `COMPLETED`, `CANCELLED` and `FAILED` have no outgoing edges at all, so a
 *    replayed command on a finished order cannot produce a second financial
 *    effect.
 *
 * The screen states both, and shows the live transition set for the order's
 * current status so a viewer can see the constraint rather than take it on
 * trust.
 */
export function OrderDetailView({ orderId }: { orderId: string }): ReactNode {
  const resource = useApiResource(
    (client, signal) => fetchOrder(client, orderId, signal),
    [orderId],
  );

  return (
    <DataView
      resource={resource}
      context="این سفارش"
      loadingLabel="در حال خواندن سفارش"
      loadingRows={3}
    >
      {(order) => (
        <>
          <PageHeader
            title="جزئیات سفارش"
            description={<Code>{order.id}</Code>}
            actions={
              <>
                <OrderStatusBadge status={order.status} />
                <Link
                  href="/orders"
                  className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
                >
                  بازگشت
                </Link>
              </>
            }
          />

          <Section
            id="stepper"
            title="مسیر سفارش"
            description="مسیر عادی از ثبت تا تکمیل. وضعیت‌های استثنایی — اعتراض، لغو، شکست — بیرون از این مسیرند و در جدول زیر می‌آیند."
          >
            <Card className="overflow-x-auto">
              <ol className="flex min-w-max items-center gap-2">
                {ORDER_HAPPY_PATH.map((status, index) => {
                  const position = ORDER_HAPPY_PATH.indexOf(order.status as OrderStatus);
                  const reached = position >= 0 && index <= position;
                  const current = order.status === status;

                  return (
                    <li key={status} className="flex items-center gap-2">
                      <span
                        aria-current={current ? 'step' : undefined}
                        className={cx(
                          'flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border px-3 text-xs font-semibold',
                          current
                            ? 'border-[var(--pri)] bg-[var(--pri)] text-white'
                            : reached
                              ? 'border-[var(--pri)] bg-[var(--pri-soft)] text-[var(--pri-tx)]'
                              : 'border-[var(--control-border)] text-[var(--tx3)]',
                        )}
                      >
                        {ORDER_STATUS_LABELS[status] ?? status}
                      </span>
                      {index < ORDER_HAPPY_PATH.length - 1 ? (
                        <span aria-hidden="true" className="text-[var(--tx3)}">
                          ←
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              {!ORDER_HAPPY_PATH.includes(order.status as OrderStatus) ? (
                <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-sm font-semibold text-[var(--warn-tx)]">
                  این سفارش در وضعیت <Code>{order.status}</Code> است که بیرون از مسیر عادی قرار
                  دارد.
                </p>
              ) : null}
            </Card>
          </Section>

          <PaymentScenarioGate orderId={order.id} onApplied={resource.reload} />

          <Section
            id="transitions"
            title="از اینجا کجا می‌توان رفت"
            description="مجموعهٔ یال‌های خروجی همین وضعیت، از جدول واقعی ماشین حالت سرویس."
          >
            <Card>
              {(ORDER_TRANSITIONS[order.status as OrderStatus] ?? []).length === 0 ? (
                <p className="text-sm font-semibold text-[var(--tx)]">
                  هیچ گذاری از این وضعیت وجود ندارد. این یک وضعیت پایانی است، بنابراین اجرای دوبارهٔ
                  یک فرمان روی سفارش تمام‌شده نمی‌تواند اثر مالی دوم بگذارد.
                </p>
              ) : (
                <ul aria-label="گذارهای مجاز از وضعیت فعلی" className="flex flex-wrap gap-2">
                  {(ORDER_TRANSITIONS[order.status as OrderStatus] ?? []).map((next) => (
                    <li key={next}>
                      <Badge tone="info">
                        {ORDER_STATUS_LABELS[next] ?? next}
                        <Code>{next}</Code>
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 text-xs text-[var(--tx2)]">
                توجه کنید که از <Code>DISPUTED</Code> هیچ یالی به <Code>SETTLING</Code> نیست. توقف
                تسویه هنگام اعتراض، یک بررسی نیست که کسی باید به یاد بیاورد؛ آن یال اصلاً وجود
                ندارد.
              </p>
            </Card>
          </Section>

          <Section id="parties" title="طرفین و ارجاع‌های مالی">
            <Card>
              <DescriptionList
                columns={2}
                items={[
                  { term: 'خریدار', value: <Code>{order.buyerOrganizationId}</Code> },
                  { term: 'تأمین‌کننده', value: <Code>{order.supplierOrganizationId}</Code> },
                  {
                    term: 'تراکنش اقتصادی',
                    value: (
                      <Maybe
                        value={
                          order.economicTransactionId ? (
                            <Code>{order.economicTransactionId}</Code>
                          ) : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'تسویه',
                    value: (
                      <Maybe
                        value={
                          order.economicSettlementId ? (
                            <Code>{order.economicSettlementId}</Code>
                          ) : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'صلاحیت تأمین‌کننده',
                    value: (
                      <Badge tone="neutral" title="سنجش صلاحیت تأمین‌کننده هنوز پیاده نشده است.">
                        بررسی نشده
                        <Code>{order.supplierQualification}</Code>
                      </Badge>
                    ),
                  },
                  { term: 'ثبت‌کننده', value: <Code>{order.placedBy}</Code> },
                ]}
              />
            </Card>
          </Section>

          <Section
            id="lines"
            title="اقلام سفارش"
            description="قیمت هر قلم، قیمتی است که در لحظهٔ ثبت توافق شده. نسخهٔ پیشنهاد ثبت می‌شود تا تأمین‌کننده نتواند کاری را که فروخته دوباره قیمت‌گذاری کند."
          >
            <DataTable
              rows={order.lines}
              rowKey={(row) => row.offerId}
              caption={`${formatInteger(order.lines.length)} قلم · مبلغ کل ${formatMoneyMinor(order.totalAmountMinor, order.currency)}`}
              minWidth="44rem"
              columns={[
                {
                  key: 'product',
                  header: 'کالا',
                  render: (row) => (
                    <>
                      <span dir="auto">{row.productName}</span>
                      <Code>{row.productId}</Code>
                    </>
                  ),
                },
                { key: 'quantity', header: 'تعداد', render: (row) => formatInteger(row.quantity) },
                {
                  key: 'unit',
                  header: 'قیمت واحد',
                  render: (row) => formatMoneyMinor(row.unitPriceMinor, row.currency),
                },
                {
                  key: 'total',
                  header: 'جمع قلم',
                  render: (row) => (
                    <span className="font-bold">
                      {formatMoneyMinor(row.lineTotalMinor, row.currency)}
                    </span>
                  ),
                },
                {
                  key: 'version',
                  header: 'نسخهٔ پیشنهاد',
                  render: (row) => formatInteger(row.offerVersion),
                },
              ]}
            />
          </Section>

          <Section
            id="timestamps"
            title="زمان‌ها و یادآوری‌ها"
            description="انقضای مهلت هیچ چیزی را جابه‌جا نمی‌کند: نه تأیید خودکار، نه لغو خودکار، نه هیچ زمان‌سنجی با اثر مالی. فقط یک یادآوری ثبت می‌شود."
          >
            <Card>
              <DescriptionList
                columns={3}
                items={[
                  { term: 'ثبت', value: formatJalaliDate(order.createdAt) },
                  {
                    term: 'تأیید تأمین‌کننده',
                    value: (
                      <Maybe
                        value={order.confirmedAt ? formatJalaliDate(order.confirmedAt) : null}
                      />
                    ),
                  },
                  {
                    term: 'اعلام تحویل',
                    value: (
                      <Maybe
                        value={order.fulfilledAt ? formatJalaliDate(order.fulfilledAt) : null}
                      />
                    ),
                  },
                  {
                    term: 'تأیید دریافت',
                    value: (
                      <Maybe
                        value={
                          order.receiptConfirmedAt
                            ? formatJalaliDate(order.receiptConfirmedAt)
                            : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'تکمیل',
                    value: (
                      <Maybe
                        value={order.completedAt ? formatJalaliDate(order.completedAt) : null}
                      />
                    ),
                  },
                  { term: 'تعداد یادآوری', value: formatInteger(order.reminderCount) },
                ]}
              />

              {order.cancellationReason ? (
                <p className="mt-4 text-sm text-[var(--dgr-tx)]" dir="auto">
                  دلیل لغو: {order.cancellationReason}
                </p>
              ) : null}
              {order.failureReason ? (
                <p className="mt-2 text-sm text-[var(--dgr-tx)]" dir="auto">
                  دلیل شکست: {order.failureReason}
                </p>
              ) : null}
            </Card>
          </Section>
        </>
      )}
    </DataView>
  );
}
