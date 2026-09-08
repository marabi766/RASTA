'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { fetchTrialBalance, listLedgerAccounts } from '@/lib/api/adapters/economic';
import { formatInteger, formatJalaliDate, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe, Section } from '../ui/data-view';

/**
 * The double-entry ledger.
 *
 * ## Why `balanced` is rendered as an alarm
 *
 * `TrialBalanceView.balanced` is the proof, not a report. `false` means debits
 * and credits disagree, which for an immutable double-entry ledger is a
 * critical integrity failure (docs/10 § 10.3) — not a number to display in grey
 * next to the others. So `true` is a quiet confirmation and `false` is loud.
 *
 * ## Two different scopes on one page, on purpose
 *
 * The chart of accounts is this organization's: two accounts per currency, a
 * `WALLET` for what can be spent and an `ESCROW` for what is committed
 * (ADR-034). The trial balance is **platform-wide** and cannot be otherwise —
 * one organization's slice of a double-entry ledger does not balance, because
 * the counterparty and commission legs live elsewhere. That is why the two
 * carry different route roles, and why a role that reads its own accounts may
 * still be refused the trial balance. The refusal renders as a refusal.
 */
export function LedgerView(): ReactNode {
  const accounts = useApiResource((client, signal) => listLedgerAccounts(client, signal), []);
  const trialBalance = useApiResource((client, signal) => fetchTrialBalance(client, signal), []);

  return (
    <>
      <PageHeader
        title="دفتر کل و تراز آزمایشی"
        description="مرجع حقیقت مالی پلتفرم. ورودی‌های Post‌شده تغییرناپذیرند و اصلاح فقط با ثبت معکوس انجام می‌شود."
        actions={
          <Link
            href="/wallet"
            className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
          >
            بازگشت به کیف پول
          </Link>
        }
      />

      <Section
        id="accounts"
        title="حساب‌های این سازمان"
        description="دو حساب به‌ازای هر ارز: یکی برای آنچه قابل خرج است و یکی برای آنچه به تعهدها سپرده شده. حساب‌های پلتفرمی — درآمد کارمزد، هزینهٔ پاداش، تسویهٔ پرداخت — به سازمان پلتفرم تعلق دارند و در این فهرست نمی‌آیند."
      >
        <DataView
          resource={accounts}
          context="حساب‌های دفتر کل"
          loadingLabel="در حال خواندن حساب‌های دفتر کل"
          empty={{
            title: 'حسابی برای این سازمان باز نشده است',
            description: 'حساب‌ها با نخستین عملیات مالی سازمان ساخته می‌شوند.',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} حساب.`}
              minWidth="44rem"
              columns={[
                {
                  key: 'code',
                  header: 'کد حساب',
                  render: (row) => (
                    <>
                      <Code>{row.accountCode}</Code>
                      <span className="mt-0.5 block text-xs text-[var(--tx3)]" dir="auto">
                        <Maybe value={row.title} />
                      </span>
                    </>
                  ),
                },
                { key: 'type', header: 'نوع', render: (row) => <Code>{row.accountType}</Code> },
                { key: 'purpose', header: 'کاربرد', render: (row) => <Code>{row.purpose}</Code> },
                { key: 'currency', header: 'ارز', render: (row) => <Code>{row.currency}</Code> },
                {
                  key: 'status',
                  header: 'وضعیت',
                  render: (row) => (
                    <Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      <Code>{row.status}</Code>
                    </Badge>
                  ),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section
        id="trial-balance"
        title="تراز آزمایشی"
        description="اثبات توازن دوطرفه در سطح کل پلتفرم. این مسیر تنها برای مدیر سامانه و مدیر اتحادیه باز است."
      >
        <DataView
          resource={trialBalance}
          context="تراز آزمایشی"
          loadingLabel="در حال خواندن تراز آزمایشی"
          loadingRows={2}
        >
          {(balance) => (
            <>
              <Card
                className={
                  balance.balanced ? 'mb-4 border-[var(--ok)]' : 'mb-4 border-[var(--dgr)]'
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-[var(--tx3)]">وضعیت توازن</p>
                    <p
                      className={
                        balance.balanced
                          ? 'mt-1 text-xl font-extrabold text-[var(--ok-tx)]'
                          : 'mt-1 text-xl font-extrabold text-[var(--dgr-tx)]'
                      }
                    >
                      {balance.balanced ? 'متوازن' : 'نامتوازن — هشدار بحرانی'}
                    </p>
                  </div>
                  <Badge tone={balance.balanced ? 'success' : 'danger'}>
                    <Code>balanced: {String(balance.balanced)}</Code>
                  </Badge>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-[var(--tx3)]">مجموع بدهکار</p>
                    <p className="mt-1 text-lg font-bold text-[var(--tx)]">
                      {formatMoneyMinor(balance.totalDebitMinor, balance.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--tx3)]">مجموع بستانکار</p>
                    <p className="mt-1 text-lg font-bold text-[var(--tx)]">
                      {formatMoneyMinor(balance.totalCreditMinor, balance.currency)}
                    </p>
                  </div>
                </div>

                {!balance.balanced ? (
                  <p
                    role="alert"
                    className="mt-4 rounded-[var(--radius-md)] border border-[var(--dgr)] bg-[var(--dgr-soft)] px-4 py-3 text-sm font-semibold text-[var(--dgr-tx)]"
                  >
                    نابرابری بدهکار و بستانکار در یک دفتر کل دوطرفهٔ تغییرناپذیر، یک نقص یکپارچگی
                    است و باید بلافاصله بررسی شود.
                  </p>
                ) : null}
              </Card>

              {balance.accounts.length > 0 ? (
                <DataTable
                  rows={balance.accounts}
                  rowKey={(row) => row.accountId}
                  caption={`${formatInteger(balance.accounts.length)} حساب در تراز. مانده در جهت طبیعی هر حساب گزارش می‌شود، بدون نیاز به قرارداد علامت.`}
                  minWidth="48rem"
                  columns={[
                    {
                      key: 'code',
                      header: 'کد حساب',
                      render: (row) => <Code>{row.accountCode}</Code>,
                    },
                    {
                      key: 'organization',
                      header: 'سازمان',
                      render: (row) => <Code>{row.organizationId}</Code>,
                    },
                    { key: 'type', header: 'نوع', render: (row) => <Code>{row.accountType}</Code> },
                    {
                      key: 'debit',
                      header: 'بدهکار',
                      render: (row) => formatMoneyMinor(row.debitMinor, row.currency),
                    },
                    {
                      key: 'credit',
                      header: 'بستانکار',
                      render: (row) => formatMoneyMinor(row.creditMinor, row.currency),
                    },
                    {
                      key: 'balance',
                      header: 'مانده',
                      render: (row) => (
                        <span className="font-bold">
                          {formatMoneyMinor(row.balanceMinor, row.currency)}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : null}
            </>
          )}
        </DataView>
      </Section>

      <Card>
        <p className="text-xs text-[var(--tx2)]">
          ورودی‌های Post‌شدهٔ دفتر کل با Trigger پایگاه داده در برابر <Code>UPDATE</Code> و{' '}
          <Code>DELETE</Code> محافظت می‌شوند. تنها راه اصلاح، یک ثبت معکوس با دلیل نوشته‌شده است که
          خودش برای همیشه باقی می‌ماند. تاریخ گزارش: {formatJalaliDate(new Date().toISOString())}
        </p>
      </Card>
    </>
  );
}
