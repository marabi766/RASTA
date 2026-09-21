import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  PageHeader,
  Section,
  StatusBadge,
} from '@/ui';
import {
  assetStatusLabel,
  assetStatusOptions,
  assetTypeLabel,
  assetTypeOptions,
} from '@/lib/labels';
import { formatJalaliDateLong } from '@/lib/format';
import type { AssetListQuery, AssetPage, ReadResult } from '@/server/assets';

/**
 * The machinery list (docs/16 § 16.6, `/assets`).
 *
 * A pure function of what the server read, so every state it can be in — a
 * page of rows, an empty tenant, a filter that matched nothing, a refusal, an
 * outage — is renderable in a test rather than reachable only against a live
 * stack.
 *
 * ## Filtering and paging happen in the URL
 *
 * The form is a plain `GET`, and "next page" is a link. No JavaScript is
 * involved in either, which matters on the connections docs/16 § 16.2 says
 * this portal is for — and it means a filtered list is a URL somebody can
 * send to a colleague, which a client-side filter never is.
 *
 * ## Why the cursor is carried and not a page number
 *
 * asset-service pages by cursor. A page number would have to be translated
 * into one somewhere, and the only honest place is the service that owns the
 * ordering.
 */

export interface AssetsScreenProps {
  readonly result: ReadResult<AssetPage>;
  readonly query: AssetListQuery;
}

/** Rebuilds this screen's URL with one value changed. */
function hrefWith(query: AssetListQuery, changes: Partial<AssetListQuery>): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.status) params.set('status', merged.status);
  if (merged.type) params.set('type', merged.type);
  if (merged.q) params.set('q', merged.q);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  return search ? `/assets?${search}` : '/assets';
}

/**
 * The control classes, in one place.
 *
 * Not `Field` from the design system, and the reason is narrow: `Field` is a
 * client component — it owns generated ids — and this form needs no JavaScript
 * at all. A `GET` form with three controls is the one case where the design
 * system's wiring buys nothing and costs a hydrated bundle on a slow
 * connection.
 */
const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

/**
 * The label wraps its control **and** names it by id.
 *
 * Either alone associates the two for a screen reader; both together also
 * satisfy the stricter lint rule this repository runs, and cost nothing.
 */
function Filters({ query }: { query: AssetListQuery }) {
  return (
    <form
      method="get"
      action="/assets"
      className="flex flex-wrap items-end gap-4"
      aria-label="پالایش فهرست"
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
          {assetStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="filter-type" className="flex flex-col gap-1 text-sm text-content-muted">
        نوع
        <select id="filter-type" name="type" defaultValue={query.type ?? ''} className={CONTROL}>
          <option value="">همه</option>
          {assetTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="filter-q" className="flex flex-col gap-1 text-sm text-content-muted">
        <span id="filter-q-label">جست‌وجو</span>
        <input
          id="filter-q"
          name="q"
          type="search"
          // The wrapping label already names it; `aria-labelledby` says so in a
          // way a static analyser can see, which is what the accessibility lint
          // rule asks of a control it can read in full.
          aria-labelledby="filter-q-label"
          defaultValue={query.q ?? ''}
          placeholder="نام، پلاک یا شمارهٔ دارایی"
          className={CONTROL}
        />
      </label>

      <Button type="submit">اعمال</Button>
    </form>
  );
}

function AssetRows({ page, query }: { page: AssetPage; query: AssetListQuery }) {
  return (
    <>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">فهرست ماشین‌آلات این سازمان</caption>
        <thead>
          <tr className="border-b border-border text-start text-content-muted">
            <th scope="col" className="p-3 text-start font-medium">
              نام
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              شماره
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              نوع
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              وضعیت
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              بهره‌برداری
            </th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((asset) => (
            <tr key={asset.id} className="border-b border-border">
              <td className="p-3">
                <a
                  href={`/assets/${encodeURIComponent(asset.id)}`}
                  className="text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {asset.name}
                </a>
              </td>
              <td className="p-3">
                {asset.assetTag ? <Identifier>{asset.assetTag}</Identifier> : '—'}
              </td>
              <td className="p-3 text-content-muted">{assetTypeLabel(asset.type)}</td>
              <td className="p-3">
                <StatusBadge status={asset.status} label={assetStatusLabel(asset.status)} />
              </td>
              <td className="p-3 text-content-muted">
                {asset.commissionedAt ? formatJalaliDateLong(asset.commissionedAt) : '—'}
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

export function AssetsScreen({ result, query }: AssetsScreenProps) {
  const filtered = Boolean(query.status || query.type || query.q);

  return (
    <>
      <PageHeader
        title="ماشین‌آلات"
        description="دارایی‌های ثبت‌شدهٔ سازمان فعال شما، با وضعیت بهره‌برداری هر کدام."
      />

      <Section headingId="filters" title="پالایش">
        <Filters query={query} />
      </Section>

      <Section headingId="assets" title="فهرست">
        {result.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

        {result.kind === 'UNAVAILABLE' ? (
          <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
        ) : null}

        {result.kind === 'MALFORMED' ? (
          <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {result.kind === 'NOT_FOUND' ? (
          <EmptyState title="فهرستی یافت نشد" description="این مسیر در سرویس دارایی پاسخی نداشت." />
        ) : null}

        {result.kind === 'OK' && result.data.items.length === 0 ? (
          // The two empty cases are different sentences: one says the tenant
          // has no assets, the other says this filter matched none of them.
          // Telling somebody "nothing is registered" when they have simply
          // typed a name that does not match is a small lie with a real cost.
          filtered ? (
            <EmptyState
              title="چیزی با این پالایش پیدا نشد"
              description="پالایه‌ها را بردارید یا عبارت دیگری را جست‌وجو کنید."
              action={<ButtonLink href="/assets">نمایش همه</ButtonLink>}
            />
          ) : (
            <EmptyState
              title="هنوز ماشین‌آلاتی ثبت نشده"
              description="پس از ثبت نخستین دارایی، همین‌جا دیده می‌شود."
            />
          )
        ) : null}

        {result.kind === 'OK' && result.data.items.length > 0 ? (
          <AssetRows page={result.data} query={query} />
        ) : null}
      </Section>
    </>
  );
}
