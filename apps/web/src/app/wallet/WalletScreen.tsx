import {
  Alert,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Grid,
  Identifier,
  NoAccessState,
  PageHeader,
  Section,
  StatusBadge,
} from '@/ui';
import {
  transactionStatusLabel,
  transactionStatusOptions,
  transactionTypeLabel,
  transactionTypeOptions,
  walletHoldStatusLabel,
} from '@/lib/labels';
import { formatJalaliDateLong, formatMoney } from '@/lib/format';
import type {
  HoldsPage,
  PaymentProviderDisclosure,
  ReadResult,
  TransactionListQuery,
  TransactionPage,
  Wallet,
} from '@/server/wallet';
import { TopUpForm } from './TopUpForm';

/**
 * `/wallet` — کیف پول و تراکنش (docs/16 § ۱۶٫۶, role `ORGANIZATION_ADMIN`).
 *
 * A pure function of four independent reads, mirroring the rest of this
 * portal: balance, escrow holds, transaction history and the payment
 * provider's own disclosure — each rendered in whatever state it actually
 * came back in, not assumed to have succeeded together.
 *
 * ## Why the top-up form only appears once, with a banner above it
 *
 * `CLAUDE.md` and ADR-024 are explicit: this MVP moves no real money, and
 * that has to be visible wherever a payment-shaped control appears — not
 * mentioned once in a document nobody reading this screen will open. The
 * `provider` read is what makes that honest rather than asserted: the banner
 * says what `economic-service` itself says, so the two can never drift apart.
 * If that read fails, the form is withheld rather than shown without its
 * disclosure — an amount field with nothing above it would look like an
 * ordinary payment box.
 */

export interface WalletScreenProps {
  readonly wallet: ReadResult<Wallet>;
  readonly holds: ReadResult<HoldsPage>;
  readonly transactions: ReadResult<TransactionPage>;
  readonly provider: ReadResult<PaymentProviderDisclosure>;
  readonly query: TransactionListQuery;
  readonly csrfToken: string;
  readonly submissionId: string;
}

function hrefWith(query: TransactionListQuery, changes: Partial<TransactionListQuery>): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.status) params.set('status', merged.status);
  if (merged.transactionType) params.set('transactionType', merged.transactionType);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  return search ? `/wallet?${search}` : '/wallet';
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Balances({ wallet }: { wallet: Wallet }) {
  return (
    <Section headingId="balances" title="موجودی">
      <Grid columns={3}>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-content-subtle">قابل برداشت</span>
          <span className="text-xl text-content">{formatMoney(wallet.availableBalanceMinor)}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-content-subtle">در وثیقه</span>
          <span className="text-xl text-content">{formatMoney(wallet.pendingBalanceMinor)}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-content-subtle">مجموع</span>
          <span className="text-xl text-content">{formatMoney(wallet.ledgerBalanceMinor)}</span>
        </div>
      </Grid>
    </Section>
  );
}

function HoldRows({ holds }: { holds: HoldsPage }) {
  if (holds.items.length === 0) {
    return (
      <EmptyState
        title="هیچ وجهی در وثیقه نیست"
        description="با ثبت هر سفارش یا تعهدی که وجه آن رزرو شود، اینجا دیده می‌شود."
      />
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">فهرست وجوه در وثیقه</caption>
      <thead>
        <tr className="border-b border-border text-start text-content-muted">
          <th scope="col" className="p-3 text-start font-medium">
            مبلغ
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            وضعیت
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            مرجع
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            تاریخ
          </th>
        </tr>
      </thead>
      <tbody>
        {holds.items.map((hold) => (
          <tr key={hold.id} className="border-b border-border">
            <td className="p-3">{formatMoney(hold.amountMinor)}</td>
            <td className="p-3">
              <StatusBadge status={hold.status} label={walletHoldStatusLabel(hold.status)} />
            </td>
            <td className="p-3 text-content-muted">
              <Identifier>{hold.reference}</Identifier>
            </td>
            <td className="p-3 text-content-muted">{formatJalaliDateLong(hold.placedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TransactionFilters({ query }: { query: TransactionListQuery }) {
  return (
    <form
      method="get"
      action="/wallet"
      className="flex flex-wrap items-end gap-4"
      aria-label="پالایش تراکنش‌ها"
    >
      <label htmlFor="filter-status" className="flex flex-col gap-1 text-sm text-content-muted">
        وضعیت
        <select
          id="filter-status"
          name="status"
          defaultValue={query.status ?? ''}
          className={CONTROL}
        >
          <option value="">همه</option>
          {transactionStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="filter-type" className="flex flex-col gap-1 text-sm text-content-muted">
        نوع
        <select
          id="filter-type"
          name="transactionType"
          defaultValue={query.transactionType ?? ''}
          className={CONTROL}
        >
          <option value="">همه</option>
          {transactionTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <Button type="submit">اعمال</Button>
    </form>
  );
}

function TransactionRows({ page, query }: { page: TransactionPage; query: TransactionListQuery }) {
  return (
    <>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">فهرست تراکنش‌ها</caption>
        <thead>
          <tr className="border-b border-border text-start text-content-muted">
            <th scope="col" className="p-3 text-start font-medium">
              نوع
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              مبلغ خالص
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              وضعیت
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              تاریخ
            </th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((transaction) => (
            <tr key={transaction.id} className="border-b border-border">
              <td className="p-3">{transactionTypeLabel(transaction.transactionType)}</td>
              <td className="p-3">{formatMoney(transaction.netAmountMinor)}</td>
              <td className="p-3">
                <StatusBadge
                  status={transaction.status}
                  label={transactionStatusLabel(transaction.status)}
                />
              </td>
              <td className="p-3 text-content-muted">
                {formatJalaliDateLong(transaction.occurredAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {page.hasMore && page.nextCursor ? (
        <div className="mt-4 flex justify-start">
          <ButtonLink tone="secondary" href={hrefWith(query, { cursor: page.nextCursor })}>
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </>
  );
}

export function WalletScreen({
  wallet,
  holds,
  transactions,
  provider,
  query,
  csrfToken,
  submissionId,
}: WalletScreenProps) {
  const filtered = Boolean(query.status || query.transactionType);

  return (
    <>
      <PageHeader title="کیف پول و تراکنش" description="موجودی سازمان فعال شما و تاریخچهٔ آن." />

      {wallet.kind === 'FORBIDDEN' ? <NoAccessState /> : null}
      {wallet.kind === 'UNAVAILABLE' ? (
        <ErrorState correlationId={wallet.correlationId} code={`UPSTREAM_${wallet.status}`} />
      ) : null}
      {wallet.kind === 'MALFORMED' ? (
        <ErrorState correlationId={wallet.correlationId} code="CONTRACT_MISMATCH" />
      ) : null}
      {wallet.kind === 'NOT_FOUND' ? (
        <EmptyState title="کیف پولی یافت نشد" description="این سازمان هنوز کیف پولی ندارد." />
      ) : null}

      {wallet.kind === 'OK' ? (
        <>
          <Balances wallet={wallet.data} />

          <Section headingId="holds" title="وجوه در وثیقه">
            {holds.kind === 'OK' ? <HoldRows holds={holds.data} /> : null}
            {holds.kind === 'FORBIDDEN' ? <NoAccessState /> : null}
            {holds.kind === 'UNAVAILABLE' ? (
              <ErrorState correlationId={holds.correlationId} code={`UPSTREAM_${holds.status}`} />
            ) : null}
          </Section>

          <Section headingId="top-up" title="افزایش موجودی">
            {provider.kind === 'OK' ? (
              <>
                <Alert tone="info" title={provider.data.simulated ? 'حالت نمایشی' : undefined}>
                  {provider.data.notice}
                </Alert>
                <TopUpForm
                  walletId={wallet.data.id}
                  csrfToken={csrfToken}
                  submissionId={submissionId}
                />
              </>
            ) : (
              // Withheld rather than shown without its disclosure — an amount
              // field with nothing above it would look like an ordinary
              // payment box (docs/16 § ۱۶٫۱۱, ADR-024).
              <EmptyState
                title="افزایش موجودی اکنون در دسترس نیست"
                description="اطلاعات روش پرداخت خوانده نشد. بعداً دوباره سر بزنید."
              />
            )}
          </Section>
        </>
      ) : null}

      <Section headingId="transactions" title="تراکنش‌ها">
        <TransactionFilters query={query} />

        {transactions.kind === 'FORBIDDEN' ? <NoAccessState /> : null}
        {transactions.kind === 'UNAVAILABLE' ? (
          <ErrorState
            correlationId={transactions.correlationId}
            code={`UPSTREAM_${transactions.status}`}
          />
        ) : null}
        {transactions.kind === 'MALFORMED' ? (
          <ErrorState correlationId={transactions.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {transactions.kind === 'OK' && transactions.data.items.length === 0 ? (
          filtered ? (
            <EmptyState
              title="چیزی با این پالایش پیدا نشد"
              description="پالایه‌ها را بردارید یا ترکیب دیگری را امتحان کنید."
              action={<ButtonLink href="/wallet">نمایش همه</ButtonLink>}
            />
          ) : (
            <EmptyState
              title="هیچ تراکنشی ثبت نشده"
              description="هر سفارش یا تعهد مالی که ثبت شود، اینجا دیده می‌شود."
            />
          )
        ) : null}

        {transactions.kind === 'OK' && transactions.data.items.length > 0 ? (
          <TransactionRows page={transactions.data} query={query} />
        ) : null}
      </Section>
    </>
  );
}
