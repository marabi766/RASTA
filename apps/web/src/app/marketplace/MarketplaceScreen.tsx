import { Button, EmptyState, ErrorState, NoAccessState, PageHeader, Section } from '@/ui';
import { productKindLabel } from '@/lib/labels';
import { formatMoney } from '@/lib/format';
import type { ProductPage, ProductSearchQuery, ReadResult } from '@/server/marketplace';

/**
 * `/marketplace` — جست‌وجوی کالا و خدمت (docs/16 § ۱۶٫۶, role
 * `PROCUREMENT_USER`).
 *
 * A pure function of the search result, mirroring every other list screen in
 * this portal: filtering lives in the URL, so a filtered search is a link
 * somebody can send to a colleague, and every state the service can answer
 * with — a page of products, an empty catalogue, a filter that matched
 * nothing, a refusal, an outage — is renderable in a test.
 *
 * Each row leads with the cheapest published offer, because
 * `searchProducts` already returns every product's offers sorted the way the
 * `sort` query asked — showing it here costs no second request, and a buyer
 * scanning a list wants the price before they click through to compare.
 */

export interface MarketplaceScreenProps {
  readonly result: ReadResult<ProductPage>;
  readonly query: ProductSearchQuery;
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Filters({ query }: { query: ProductSearchQuery }) {
  return (
    <form
      method="get"
      action="/marketplace"
      className="flex flex-wrap items-end gap-4"
      aria-label="جست‌وجوی کالا و خدمت"
    >
      <label htmlFor="filter-q" className="flex flex-col gap-1 text-sm text-content-muted">
        <span id="filter-q-label">جست‌وجو</span>
        <input
          id="filter-q"
          name="q"
          type="search"
          // The wrapping label already names it; `aria-labelledby` says so in a
          // way a static analyser can see, which is what the accessibility lint
          // rule asks of a control it can read in full (`AssetsScreen` sets
          // the same precedent).
          aria-labelledby="filter-q-label"
          defaultValue={query.q ?? ''}
          className={CONTROL}
        />
      </label>

      <label htmlFor="filter-category" className="flex flex-col gap-1 text-sm text-content-muted">
        <span id="filter-category-label">دسته</span>
        <input
          id="filter-category"
          name="category"
          type="search"
          aria-labelledby="filter-category-label"
          defaultValue={query.category ?? ''}
          className={CONTROL}
        />
      </label>

      <label htmlFor="filter-sort" className="flex flex-col gap-1 text-sm text-content-muted">
        ترتیب
        <select id="filter-sort" name="sort" defaultValue={query.sort ?? ''} className={CONTROL}>
          <option value="PRICE_ASC">ارزان‌ترین ابتدا</option>
          <option value="PRICE_DESC">گران‌ترین ابتدا</option>
          <option value="LEAD_TIME_ASC">کوتاه‌ترین زمان تحویل</option>
        </select>
      </label>

      <Button type="submit">جست‌وجو</Button>
    </form>
  );
}

function ProductRows({ page }: { page: ProductPage }) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">فهرست کالا و خدمت</caption>
      <thead>
        <tr className="border-b border-border text-start text-content-muted">
          <th scope="col" className="p-3 text-start font-medium">
            نام
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            دسته
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            نوع
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            شروع قیمت
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            تعداد پیشنهاد
          </th>
        </tr>
      </thead>
      <tbody>
        {page.items.map((product) => (
          <tr key={product.id} className="border-b border-border">
            <td className="p-3">
              <a
                href={`/marketplace/${encodeURIComponent(product.id)}`}
                className="text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {product.name}
              </a>
            </td>
            <td className="p-3 text-content-muted">{product.category}</td>
            <td className="p-3 text-content-muted">{productKindLabel(product.kind)}</td>
            <td className="p-3">
              {product.offers.length > 0 ? formatMoney(product.offers[0]!.unitPriceMinor) : '—'}
            </td>
            <td className="p-3 text-content-muted">{product.offers.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MarketplaceScreen({ result, query }: MarketplaceScreenProps) {
  const filtered = Boolean(query.q || query.category);

  return (
    <>
      <PageHeader
        title="جست‌وجوی کالا و خدمت"
        description="کاتالوگ کالا و خدمت هر تأمین‌کننده‌ای که پیشنهادی منتشرکرده باشد."
      />

      <Section headingId="filters" title="جست‌وجو">
        <Filters query={query} />
      </Section>

      <Section headingId="products" title="فهرست">
        {result.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

        {result.kind === 'UNAVAILABLE' ? (
          <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
        ) : null}

        {result.kind === 'MALFORMED' ? (
          <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {result.kind === 'NOT_FOUND' ? (
          <EmptyState title="فهرستی یافت نشد" description="این مسیر در بازار پاسخی نداشت." />
        ) : null}

        {result.kind === 'OK' && result.data.items.length === 0 ? (
          filtered ? (
            <EmptyState
              title="چیزی با این جست‌وجو پیدا نشد"
              description="واژه یا دسته را تغییر دهید."
              action={
                <a
                  href="/marketplace"
                  className="text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  نمایش همه
                </a>
              }
            />
          ) : (
            <EmptyState
              title="هنوز کالا یا خدمتی عرضه نشده"
              description="با انتشار نخستین پیشنهاد یک تأمین‌کننده، همین‌جا دیده می‌شود."
            />
          )
        ) : null}

        {result.kind === 'OK' && result.data.items.length > 0 ? (
          <ProductRows page={result.data} />
        ) : null}
      </Section>
    </>
  );
}
