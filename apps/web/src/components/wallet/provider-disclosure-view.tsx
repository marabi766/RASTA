'use client';

import type { ReactNode } from 'react';
import { fetchPaymentProvider } from '@/lib/api/adapters/economic';
import { useApiResource } from '@/lib/use-api-resource';
import { ApiErrorView } from '../api-error';
import { Badge, Card, LoadingState, PageHeader } from '../ui/primitives';

/**
 * What the platform says about its own payment provider.
 *
 * ADR-024 requires the simulated nature of MVP payments to be visible «در کد،
 * UI، مستند، Demo یا ارائه», and `GET /v1/wallets/provider` exists so a client
 * can state it rather than assert it. That distinction is the point of this
 * screen: a hard-coded «حالت نمایشی» banner would be a lie the day a real
 * provider is configured, and `economic-service`'s own contract suite asserts
 * exactly that inverse — a live provider must stop repeating the simulated
 * notice.
 *
 * So the badge below is rendered from `simulated`, and the notice text is the
 * service's own string. If somebody wires a real provider tomorrow, this page
 * changes without anybody editing it.
 */
export function ProviderDisclosureView(): ReactNode {
  const { state, reload } = useApiResource(
    (client, signal) => fetchPaymentProvider(client, signal),
    [],
  );

  return (
    <>
      <PageHeader
        title="افشای ارائه‌دهندهٔ پرداخت"
        description="این صفحه چیزی را ادعا نمی‌کند؛ پاسخ سرویس اقتصادی را همان‌طور که هست نشان می‌دهد. اگر روزی ارائه‌دهندهٔ واقعی پیکربندی شود، همین صفحه بدون تغییر کد، آن را اعلام می‌کند."
      />

      {state.status === 'loading' ? (
        <LoadingState rows={2} label="در حال پرسیدن وضعیت ارائه‌دهندهٔ پرداخت" />
      ) : null}

      {state.status === 'error' ? (
        <ApiErrorView
          failure={state.failure}
          onRetry={reload}
          context="وضعیت ارائه‌دهندهٔ پرداخت"
        />
      ) : null}

      {state.status === 'success' ? (
        <Card className="max-w-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-[var(--tx)]">ارائه‌دهندهٔ پیکربندی‌شده</h2>
            <Badge tone={state.data.simulated ? 'warning' : 'success'}>
              {state.data.simulated ? 'شبیه‌سازی‌شده' : 'ارائه‌دهندهٔ واقعی'}
            </Badge>
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--tx3)]">نام ارائه‌دهنده</dt>
              <dd dir="ltr" className="rasta-code text-[var(--tx)]">
                {state.data.provider}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--tx3)]">اعلام رسمی سرویس</dt>
              <dd dir="auto" className="mt-1 text-[var(--tx)]">
                {state.data.notice}
              </dd>
            </div>
          </dl>

          {state.data.simulated ? (
            <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-sm font-semibold text-[var(--warn-tx)]">
              هیچ اتصال بانکی وجود ندارد، هیچ وجهی نگهداری نمی‌شود و هیچ پولی جابه‌جا نمی‌شود.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card className="mt-6 max-w-2xl">
        <h2 className="text-sm font-bold text-[var(--tx)]">آنچه این صفحه نشان نمی‌دهد</h2>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          مانده، تراکنش، تسویه و دفتر کل در سرویس اقتصادی پیاده و تأیید شده‌اند، اما صفحهٔ آن‌ها در
          این نسخه ساخته نشده است. تا آن زمان هیچ عددی از کیف پول در این رابط نمایش داده نمی‌شود —
          نه صفر، نه عدد نمونه.
        </p>
      </Card>
    </>
  );
}
