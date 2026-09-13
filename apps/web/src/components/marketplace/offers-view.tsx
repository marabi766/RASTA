'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  SORT_LABELS,
  SORT_OPTIONS,
  offersForProduct,
  type OfferView,
  type SortOption,
} from '@/lib/api/adapters/marketplace';
import { formatInteger, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { ApiErrorView } from '../api-error';
import { Badge, Card, EmptyState, LoadingState, PageHeader, cx } from '../ui/primitives';
import { OfferScenarioGate } from './offer-scenario-gate';

/**
 * Offer comparison for one product — the second half of the live slice.
 *
 * `GET /v1/products/{id}/offers`. Published offers from every supplier, which
 * is the one place a tenant deliberately sees another tenant's rows: a
 * marketplace where you can only see your own listings is not a marketplace
 * (`catalogue.service.ts`). The read is narrowed to published offers and
 * catalogue columns and never touches an order.
 *
 * ## Three claims this table refuses to make
 *
 *  - **No supplier score.** `supplierQualification` is the literal string
 *    `UNAVAILABLE`, never a boolean. `supplier-service` phase 2 has not
 *    started, so nothing has checked; rendering "unverified" would report a
 *    verdict nobody reached (ADR-041 § 1).
 *  - **`availableQuantity` is not stock.** It is what the supplier declares it
 *    can supply. `inventory-service` does not exist and no warehouse
 *    reservation happens.
 *  - **`leadTimeDays` is a declaration, not a measurement.** Nothing observes
 *    whether it is met.
 *
 * Money stays a string from the JSON body to the DOM. `formatMoneyMinor` groups
 * digits on the string itself, so a rial figure past `Number.MAX_SAFE_INTEGER`
 * renders exactly rather than approximately (ADR-022).
 */
export function OffersView({ productId }: { productId: string }): ReactNode {
  const [sort, setSort] = useState<SortOption>('PRICE_ASC');

  const { state, reload } = useApiResource(
    (client, signal) => offersForProduct(client, productId, sort, signal),
    [productId, sort],
  );

  return (
    <>
      <PageHeader
        title="مقایسهٔ پیشنهادها"
        description={
          <>
            پیشنهادهای منتشرشدهٔ همهٔ تأمین‌کنندگان برای کالای{' '}
            <span dir="ltr" className="rasta-code">
              {productId}
            </span>
            . قیمت‌ها به ریال و در واحد فرعی، به‌صورت رشته از سرویس می‌آیند و در هیچ مرحله‌ای به عدد
            اعشاری تبدیل نمی‌شوند.
          </>
        }
        actions={
          <Link
            href="/marketplace"
            className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
          >
            بازگشت به فهرست
          </Link>
        }
      />

      <fieldset className="mb-6">
        <legend className="mb-2 text-xs font-semibold text-[var(--tx2)]">ترتیب پیشنهادها</legend>
        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((option) => (
            <label
              key={option}
              className={cx(
                'inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-3 text-sm',
                sort === option
                  ? 'border-[var(--pri)] bg-[var(--pri-soft)] font-bold text-[var(--pri-tx)]'
                  : 'border-[var(--control-border)] text-[var(--tx2)]',
              )}
            >
              <input
                type="radio"
                name="offer-sort"
                value={option}
                checked={sort === option}
                onChange={() => setSort(option)}
                className="size-4 accent-[var(--pri)]"
              />
              {SORT_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>

      {state.status === 'loading' ? (
        <LoadingState rows={3} label="در حال خواندن پیشنهادهای این کالا" />
      ) : null}

      {state.status === 'error' ? (
        <ApiErrorView failure={state.failure} onRetry={reload} context="پیشنهادهای این کالا" />
      ) : null}

      {state.status === 'success' && state.data.length === 0 ? (
        <EmptyState
          title="پیشنهاد منتشرشده‌ای برای این کالا نیست"
          description="پیشنهاد پیش‌نویس یا تعلیق‌شده برای خریدار وجود ندارد و در این فهرست نمی‌آید."
        />
      ) : null}

      {state.status === 'success' && state.data.length > 0 ? (
        <OfferTable offers={state.data} />
      ) : null}

      <OfferScenarioGate productId={productId} />

      <PaymentDisclosureLink />
    </>
  );
}

function OfferTable({ offers }: { offers: readonly OfferView[] }): ReactNode {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[46rem] border-collapse text-sm">
        <caption className="p-4 text-start text-xs text-[var(--tx3)]">
          {formatInteger(offers.length)} پیشنهاد منتشرشده، به ترتیب انتخاب‌شده از سمت سرویس.
        </caption>
        <thead>
          <tr className="border-b border-[var(--bd)] text-xs text-[var(--tx3)]">
            <th scope="col" className="p-3 text-start font-semibold">
              تأمین‌کننده
            </th>
            <th scope="col" className="p-3 text-start font-semibold">
              قیمت واحد
            </th>
            <th scope="col" className="p-3 text-start font-semibold">
              زمان تحویل اعلامی
            </th>
            <th scope="col" className="p-3 text-start font-semibold">
              حداقل سفارش
            </th>
            <th scope="col" className="p-3 text-start font-semibold">
              عدد اعلامی تأمین‌کننده
            </th>
            <th scope="col" className="p-3 text-start font-semibold">
              صلاحیت
            </th>
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => (
            <tr key={offer.id} className="border-b border-[var(--bd)] last:border-b-0">
              <th scope="row" className="p-3 text-start font-normal">
                <span dir="ltr" className="rasta-code">
                  {offer.supplierOrganizationId}
                </span>
              </th>
              <td className="p-3 font-bold text-[var(--tx)]">
                {formatMoneyMinor(offer.unitPriceMinor, offer.currency)}
              </td>
              <td className="p-3">{formatInteger(offer.leadTimeDays)} روز</td>
              <td className="p-3">{formatInteger(offer.minimumQuantity)}</td>
              <td className="p-3">
                {formatInteger(offer.availableQuantity)}
                <span className="block text-xs text-[var(--tx3)]">عدد اعلامی، نه موجودی انبار</span>
              </td>
              <td className="p-3">
                <Badge tone="neutral" title="سنجش صلاحیت تأمین‌کننده هنوز پیاده نشده است.">
                  بررسی نشده
                  <span dir="ltr" className="rasta-code opacity-70">
                    {offer.supplierQualification}
                  </span>
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-[var(--bd)] p-4 text-xs leading-relaxed text-[var(--tx2)]">
        <p>
          «عدد اعلامی تأمین‌کننده» موجودی انبار نیست. سرویس انبار ساخته نشده و هیچ رزروی روی این عدد
          انجام نمی‌شود.
        </p>
        <p className="mt-1">
          «زمان تحویل اعلامی» تعهد خودِ تأمین‌کننده است؛ هیچ سنجه‌ای آن را اندازه‌گیری نمی‌کند.
        </p>
        <p className="mt-1">
          ستون «صلاحیت» همیشه مقدار{' '}
          <span dir="ltr" className="rasta-code">
            UNAVAILABLE
          </span>{' '}
          را نشان می‌دهد — یعنی بررسی نشده، نه رد شده.
        </p>
      </div>
    </Card>
  );
}

/**
 * The honest next step from an offer.
 *
 * A buyer looking at a price is one click from asking "and then what happens to
 * the money?". The truthful answer is an endpoint, not a sentence:
 * `GET /v1/wallets/provider` reports which provider is configured and whether
 * it moves real funds (ADR-024). Linking there is the only connection this
 * milestone can make without inventing one — a cart is routed but has no
 * handler and answers `404` (ADR-037 § 3), and order placement is a write this
 * milestone does not perform.
 */
function PaymentDisclosureLink(): ReactNode {
  return (
    <Card className="mt-6">
      <h2 className="text-sm font-bold text-[var(--tx)]">پیش از خرید: وضعیت پرداخت</h2>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        ثبت سفارش در این نسخه انجام نمی‌شود. آنچه می‌توانید همین حالا از سامانه بپرسید این است که
        کدام ارائه‌دهندهٔ پرداخت پیکربندی شده و آیا اصلاً پول واقعی جابه‌جا می‌کند.
      </p>
      <Link
        href="/wallet"
        className="mt-3 inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm font-semibold text-[var(--tx)]"
      >
        مشاهدهٔ افشای ارائه‌دهندهٔ پرداخت
      </Link>
    </Card>
  );
}
