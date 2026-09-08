'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  SORT_LABELS,
  SORT_OPTIONS,
  searchProducts,
  type ProductView,
  type SortOption,
} from '@/lib/api/adapters/marketplace';
import { formatInteger, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { ApiErrorView } from '../api-error';
import { Badge, Button, Card, EmptyState, LoadingState, PageHeader, cx } from '../ui/primitives';

/**
 * Catalogue search — the first half of the live vertical slice.
 *
 * `GET /v1/products` through the gateway, with the three sort values the
 * service's own schema accepts and no fourth. `RATING` is absent upstream
 * because supplier performance scoring is not built (ADR-042 § 2), and offering
 * it here while ordering by price would tell a buyer their ordering had been
 * applied when it had not.
 *
 * The search box submits rather than searching as you type. `products` carries
 * a tighter rate limit than the platform default — 60 requests a minute
 * (`services/api-gateway/src/config/routes.ts`) — and a keystroke-triggered
 * query would spend that budget in a few seconds of typing and hand the user a
 * `429` for using the feature correctly.
 */
export function CatalogueView(): ReactNode {
  const [submitted, setSubmitted] = useState<{ q: string; sort: SortOption }>({
    q: '',
    sort: 'PRICE_ASC',
  });
  const [draft, setDraft] = useState('');

  const { state, reload } = useApiResource(
    (client, signal) => searchProducts(client, { q: submitted.q, sort: submitted.sort }, signal),
    [submitted.q, submitted.sort],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted((current) => ({ ...current, q: draft }));
  };

  return (
    <>
      <PageHeader
        title="بازار — جست‌وجوی کالا و خدمت"
        description="نتایج از سرویس بازار و از راه درگاه API خوانده می‌شود. تنها کالاهایی نمایش داده می‌شوند که دست‌کم یک پیشنهاد منتشرشده دارند؛ کالای بدون پیشنهاد، برای فروش نیست."
      />

      <Card className="mb-6">
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label
              htmlFor="catalogue-q"
              className="mb-1 block text-xs font-semibold text-[var(--tx2)]"
            >
              جست‌وجوی متنی
            </label>
            <input
              id="catalogue-q"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="نام کالا، خدمت یا دستهٔ آن"
              className="min-h-[var(--tap)] w-full rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]"
            />
          </div>
          <Button type="submit">جست‌وجو</Button>
        </form>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-semibold text-[var(--tx2)]">ترتیب نتایج</legend>
          <div className="flex flex-wrap gap-2">
            {SORT_OPTIONS.map((option) => (
              <label
                key={option}
                className={cx(
                  'inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-3 text-sm',
                  submitted.sort === option
                    ? 'border-[var(--pri)] bg-[var(--pri-soft)] font-bold text-[var(--pri-tx)]'
                    : 'border-[var(--control-border)] text-[var(--tx2)]',
                )}
              >
                <input
                  type="radio"
                  name="sort"
                  value={option}
                  checked={submitted.sort === option}
                  onChange={() => setSubmitted((current) => ({ ...current, sort: option }))}
                  className="size-4 accent-[var(--pri)]"
                />
                {SORT_LABELS[option]}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--tx3)]">
            ترتیب بر اساس «امتیاز تأمین‌کننده» ارائه نمی‌شود، چون سنجش عملکرد تأمین‌کننده هنوز پیاده
            نشده و مرتب‌سازی بر مبنایی که وجود ندارد، ادعای نادرست است.
          </p>
        </fieldset>
      </Card>

      {state.status === 'loading' ? (
        <LoadingState rows={4} label="در حال خواندن فهرست بازار" />
      ) : null}

      {state.status === 'error' ? (
        <ApiErrorView failure={state.failure} onRetry={reload} context="فهرست بازار" />
      ) : null}

      {state.status === 'success' && state.data.length === 0 ? (
        <EmptyState
          title="کالایی با این مشخصات پیدا نشد"
          description="ممکن است عبارت جست‌وجو نتیجه‌ای نداشته باشد، یا هنوز هیچ تأمین‌کننده‌ای پیشنهادی منتشر نکرده باشد."
        />
      ) : null}

      {state.status === 'success' && state.data.length > 0 ? (
        <section aria-labelledby="catalogue-results">
          {/* A heading level is skipped without this: the cards are h3, and an
              h1 → h3 jump is an axe `heading-order` failure and a real problem
              for anyone navigating by headings. */}
          <h2 id="catalogue-results" className="sr-only">
            نتایج جست‌وجو
          </h2>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {state.data.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function ProductCard({ product }: { product: ProductView }): ReactNode {
  const offers = product.offers ?? [];
  // Ordering came from the server; the first row is the one it put first.
  // Re-sorting here would require comparing money, and comparing money means
  // parsing it into a number (ADR-022).
  const leading = offers[0];

  return (
    <Card as="li" className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-[var(--tx)]">
          <Link
            href={`/marketplace/${encodeURIComponent(product.id)}`}
            className="hover:text-[var(--pri)] hover:underline"
          >
            {product.name}
          </Link>
        </h3>
        <Badge tone={product.kind === 'SERVICE' ? 'info' : 'neutral'}>
          {product.kind === 'SERVICE' ? 'خدمت' : 'کالا'}
        </Badge>
      </div>

      {product.description ? (
        <p className="line-clamp-2 text-sm text-[var(--tx2)]">{product.description}</p>
      ) : null}

      <dl className="space-y-1 text-xs text-[var(--tx2)]">
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--tx3)]">دسته</dt>
          <dd dir="auto">{product.category}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--tx3)]">شناسهٔ کالا (SKU)</dt>
          <dd dir="ltr" className="rasta-code">
            {product.sku}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--tx3)]">واحد</dt>
          <dd dir="auto">{product.unit}</dd>
        </div>
      </dl>

      <div className="mt-auto border-t border-[var(--bd)] pt-3">
        {leading ? (
          <>
            <p className="text-xs text-[var(--tx3)]">نخستین پیشنهاد در ترتیب فعلی</p>
            <p className="text-base font-bold text-[var(--tx)]">
              {formatMoneyMinor(leading.unitPriceMinor, leading.currency)}
            </p>
            <p className="mt-1 text-xs text-[var(--tx2)]">
              {formatInteger(offers.length)} پیشنهاد منتشرشده · زمان تحویل اعلامی{' '}
              {formatInteger(leading.leadTimeDays)} روز
            </p>
          </>
        ) : (
          <p className="text-xs text-[var(--tx3)]">پیشنهاد منتشرشده‌ای همراه این نتیجه نیامد.</p>
        )}
      </div>
    </Card>
  );
}
