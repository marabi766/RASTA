'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  TRANSACTION_STATUS_LABELS,
  fetchPaymentProvider,
  fetchWallet,
  listTransactions,
} from '@/lib/api/adapters/economic';
import { formatInteger, formatJalaliDate, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, PageHeader, type Tone } from '../ui/primitives';
import { Code, DataTable, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';

/**
 * Wallet, transactions and the payment-provider disclosure.
 *
 * ## Three claims this screen makes carefully
 *
 *  - **`Wallet ≠ Ledger`.** The wallet is the operational view; the ledger is
 *    the financial source of truth (A-07). Both balances shown here are derived
 *    from the ledger, and `available = ledger − pending` is enforced by a
 *    database constraint — so this screen displays three numbers and computes
 *    none of them. Subtracting them again in a browser would be a second
 *    arithmetic that could disagree with the authoritative one.
 *  - **Commission is deducted, not added.** `grossAmountMinor`,
 *    `commissionAmountMinor` and `netAmountMinor` are separate fields and the
 *    table shows all three, because the intuitive reading — commission added on
 *    top of the buyer's total — is the wrong one.
 *  - **Simulation is reported, not asserted.** The disclosure comes from
 *    `GET /v1/wallets/provider`. A hard-coded «حالت نمایشی» would become a lie
 *    the day a real provider is configured, and the service's own contract
 *    suite asserts that inverse (ADR-024).
 */
export function WalletView(): ReactNode {
  const [includeIncoming, setIncludeIncoming] = useState(false);

  const wallet = useApiResource((client, signal) => fetchWallet(client, signal), []);
  const provider = useApiResource((client, signal) => fetchPaymentProvider(client, signal), []);
  const transactions = useApiResource(
    (client, signal) => listTransactions(client, { includeIncoming }, signal),
    [includeIncoming],
  );

  return (
    <>
      <PageHeader
        title="کیف پول و تراکنش"
        description="نمای عملیاتی وضعیت مالی سازمان فعال. مرجع حقیقت، دفتر کل است؛ کیف پول نمایی از آن."
        actions={
          <Link
            href="/wallet/ledger"
            className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm font-semibold text-[var(--tx)]"
          >
            دفتر کل و تراز آزمایشی
          </Link>
        }
      />

      <Section
        id="balances"
        title="مانده‌ها"
        description="هر سه رقم از دفتر کل مشتق می‌شوند. رابطهٔ «قابل استفاده = کل − تعهدشده» در پایگاه داده اجبار شده است، نه در کد سرویس و نه در این مرورگر."
      >
        <DataView
          resource={wallet}
          context="مانده کیف پول"
          loadingLabel="در حال خواندن مانده کیف پول"
          loadingRows={2}
        >
          {(data) => (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <BalanceTile
                  label="کل (شامل تعهدشده)"
                  amount={data.ledgerBalanceMinor}
                  currency={data.currency}
                />
                <BalanceTile
                  label="تعهدشده و در امانت"
                  amount={data.pendingBalanceMinor}
                  currency={data.currency}
                  tone="warning"
                />
                <BalanceTile
                  label="قابل استفاده"
                  amount={data.availableBalanceMinor}
                  currency={data.currency}
                  tone="success"
                />
              </div>

              <Card className="mt-4">
                <DescriptionList
                  items={[
                    { term: 'شناسهٔ کیف پول', value: <Code>{data.id}</Code> },
                    { term: 'وضعیت', value: <Code>{data.status}</Code> },
                    { term: 'ارز', value: <Code>{data.currency}</Code> },
                    { term: 'ایجاد', value: formatJalaliDate(data.createdAt) },
                  ]}
                />
              </Card>
            </>
          )}
        </DataView>
      </Section>

      <Section
        id="provider"
        title="افشای ارائه‌دهندهٔ پرداخت"
        description="این متن از خود سرویس خوانده می‌شود. اگر روزی ارائه‌دهندهٔ واقعی پیکربندی شود، همین صفحه بدون تغییر کد آن را اعلام می‌کند."
      >
        <DataView
          resource={provider}
          context="وضعیت ارائه‌دهندهٔ پرداخت"
          loadingLabel="در حال پرسیدن وضعیت ارائه‌دهندهٔ پرداخت"
          loadingRows={1}
        >
          {(data) => (
            <Card className={data.simulated ? 'border-[var(--warn)]' : 'border-[var(--ok)]'}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-base font-bold text-[var(--tx)]">
                  ارائه‌دهنده: <Code>{data.provider}</Code>
                </p>
                <Badge tone={data.simulated ? 'warning' : 'success'}>
                  {data.simulated ? 'شبیه‌سازی‌شده' : 'ارائه‌دهندهٔ واقعی'}
                </Badge>
              </div>

              <p className="mt-3 text-sm text-[var(--tx)]" dir="auto">
                {data.notice}
              </p>

              {data.simulated ? (
                <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-sm font-semibold text-[var(--warn-tx)]">
                  هیچ اتصال بانکی وجود ندارد، هیچ وجهی نگهداری نمی‌شود و هیچ پولی جابه‌جا نمی‌شود.
                </p>
              ) : null}
            </Card>
          )}
        </DataView>
      </Section>

      <Section
        id="transactions"
        title="تراکنش‌ها"
        description="به‌صورت پیش‌فرض، تعهدهایی که این سازمان بدهکار آن است. نمای بستانکاری با انتخاب صریح باز می‌شود."
      >
        <div className="mb-3">
          <Button
            variant={includeIncoming ? 'primary' : 'secondary'}
            onClick={() => setIncludeIncoming((current) => !current)}
          >
            {includeIncoming ? 'فقط آنچه بدهکاریم' : 'شامل آنچه به ما بدهکارند'}
          </Button>
        </div>

        <DataView
          resource={transactions}
          context="فهرست تراکنش‌ها"
          loadingLabel="در حال خواندن تراکنش‌ها"
          empty={{
            title: 'تراکنشی ثبت نشده است',
            description: 'با نخستین تعهد مالی، این فهرست پر می‌شود.',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} تراکنش، تازه‌ترین نخست. کارمزد از سهم فروشنده کسر می‌شود، نه به مبلغ خریدار اضافه.`}
              minWidth="56rem"
              columns={[
                {
                  key: 'id',
                  header: 'تراکنش',
                  render: (row) => (
                    <>
                      <Code>{row.id}</Code>
                      <span className="mt-0.5 block text-xs text-[var(--tx3)]">
                        <Code>{row.transactionType}</Code>
                      </span>
                    </>
                  ),
                },
                {
                  key: 'status',
                  header: 'وضعیت',
                  render: (row) => (
                    <Badge tone={transactionTone(row.status)}>
                      {TRANSACTION_STATUS_LABELS[row.status] ?? row.status}
                      <Code>{row.status}</Code>
                    </Badge>
                  ),
                },
                {
                  key: 'gross',
                  header: 'ناخالص',
                  render: (row) => formatMoneyMinor(row.grossAmountMinor, row.currency),
                },
                {
                  key: 'commission',
                  header: 'کارمزد',
                  render: (row) =>
                    row.commissionAmountMinor === '0' ? (
                      <span
                        className="text-[var(--tx3)]"
                        title="صفر یعنی هیچ قاعدهٔ فعالی مطابقت نکرد — نه اینکه رایگان است. نرخ کارمزد هنوز مصوب نشده (Q-08)."
                      >
                        قاعده‌ای مطابقت نکرد
                      </span>
                    ) : (
                      formatMoneyMinor(row.commissionAmountMinor, row.currency)
                    ),
                },
                {
                  key: 'net',
                  header: 'خالص',
                  render: (row) => (
                    <span className="font-bold">
                      {formatMoneyMinor(row.netAmountMinor, row.currency)}
                    </span>
                  ),
                },
                {
                  key: 'counterparty',
                  header: 'طرف مقابل',
                  render: (row) => (
                    <Maybe
                      value={
                        row.counterpartyOrganizationId ? (
                          <Code>{row.counterpartyOrganizationId}</Code>
                        ) : null
                      }
                    />
                  ),
                },
                {
                  key: 'occurred',
                  header: 'زمان',
                  render: (row) => formatJalaliDate(row.occurredAt),
                },
              ]}
            />
          )}
        </DataView>
      </Section>
    </>
  );
}

function BalanceTile({
  label,
  amount,
  currency,
  tone,
}: {
  label: string;
  amount: string;
  currency: string;
  tone?: Tone;
}): ReactNode {
  const border =
    tone === 'success'
      ? 'border-[var(--ok)]'
      : tone === 'warning'
        ? 'border-[var(--warn)]'
        : 'border-[var(--bd)]';

  return (
    <Card className={border}>
      <p className="text-xs text-[var(--tx3)]">{label}</p>
      <p className="mt-1 text-xl font-extrabold text-[var(--tx)]">
        {formatMoneyMinor(amount, currency)}
      </p>
    </Card>
  );
}

function transactionTone(status: string): Tone {
  switch (status) {
    case 'SETTLED':
      return 'success';
    case 'HELD':
    case 'PENDING_SETTLEMENT':
      return 'warning';
    case 'DISPUTED':
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}
