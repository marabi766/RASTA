import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  NoAccessState,
  PageHeader,
  Section,
  StatusBadge,
} from '@/ui';
import {
  maintenanceRequestStatusLabel,
  maintenanceRequestStatusOptions,
  maintenanceTypeLabel,
  maintenanceTypeOptions,
  severityLabel,
  severityOptions,
} from '@/lib/labels';
import { formatJalaliDateLong } from '@/lib/format';
import type {
  MaintenanceRequestListQuery,
  MaintenanceRequestPage,
  ReadResult,
} from '@/server/maintenance';

/**
 * Maintenance and repairs (docs/16 § 16.6, `/maintenance`).
 *
 * A pure function of what the server read, mirroring `AssetsScreen` (PR #67):
 * every state it can be in — a page of rows, an empty tenant, a filter that
 * matched nothing, a refusal, an outage — is renderable in a test rather than
 * reachable only against a live stack.
 *
 * ## Filtering and paging happen in the URL
 *
 * The form is a plain `GET` and "next page" is a link, for the same reason
 * `/assets` does it that way: no JavaScript is involved in either, and a
 * filtered list is a URL somebody can send to a colleague.
 *
 * ## What is on this row and what is not
 *
 * The list shows a request's own state, not the asset's name — the asset id
 * is a link to that machine's dossier rather than a second source of its
 * name and status, both of which `/assets/[id]` already owns and can change
 * without this screen's data going stale.
 */

export interface MaintenanceScreenProps {
  readonly result: ReadResult<MaintenanceRequestPage>;
  readonly query: MaintenanceRequestListQuery;
}

/** Rebuilds this screen's URL with one value changed. */
function hrefWith(
  query: MaintenanceRequestListQuery,
  changes: Partial<MaintenanceRequestListQuery>,
): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.status) params.set('status', merged.status);
  if (merged.type) params.set('type', merged.type);
  if (merged.severity) params.set('severity', merged.severity);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  return search ? `/maintenance?${search}` : '/maintenance';
}

/**
 * Not `Field` from the design system, for the same reason `/assets`'s filter
 * form is not: `Field` is a client component that owns generated ids, and
 * this `GET` form needs no JavaScript at all.
 */
const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Filters({ query }: { query: MaintenanceRequestListQuery }) {
  return (
    <form
      method="get"
      action="/maintenance"
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
          {maintenanceRequestStatusOptions.map((option) => (
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
          {maintenanceTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="filter-severity" className="flex flex-col gap-1 text-sm text-content-muted">
        وخامت
        <select
          id="filter-severity"
          name="severity"
          defaultValue={query.severity ?? ''}
          className={CONTROL}
        >
          <option value="">همه</option>
          {severityOptions.map((option) => (
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

function RequestRows({
  page,
  query,
}: {
  page: MaintenanceRequestPage;
  query: MaintenanceRequestListQuery;
}) {
  return (
    <>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">فهرست درخواست‌های نگهداری و تعمیر</caption>
        <thead>
          <tr className="border-b border-border text-start text-content-muted">
            <th scope="col" className="p-3 text-start font-medium">
              عنوان
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              دارایی
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              نوع
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              وخامت
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              وضعیت
            </th>
            <th scope="col" className="p-3 text-start font-medium">
              تاریخ گزارش
            </th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((request) => (
            <tr key={request.id} className="border-b border-border">
              <td className="p-3">
                <a
                  href={`/maintenance/${encodeURIComponent(request.id)}`}
                  className="text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {request.title}
                </a>
              </td>
              <td className="p-3">
                <a
                  href={`/assets/${encodeURIComponent(request.assetId)}`}
                  className="font-mono text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {request.assetId}
                </a>
              </td>
              <td className="p-3 text-content-muted">{maintenanceTypeLabel(request.type)}</td>
              <td className="p-3 text-content-muted">
                {request.severity ? severityLabel(request.severity) : '—'}
              </td>
              <td className="p-3">
                <StatusBadge
                  status={request.status}
                  label={maintenanceRequestStatusLabel(request.status)}
                />
              </td>
              <td className="p-3 text-content-muted">{formatJalaliDateLong(request.reportedAt)}</td>
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

export function MaintenanceScreen({ result, query }: MaintenanceScreenProps) {
  const filtered = Boolean(query.status || query.type || query.severity);

  return (
    <>
      <PageHeader
        title="نگهداری و تعمیرات"
        description="درخواست‌های تعمیر ثبت‌شده برای دارایی‌های سازمان فعال شما."
      />

      <Section headingId="filters" title="پالایش">
        <Filters query={query} />
      </Section>

      <Section headingId="maintenance-requests" title="فهرست">
        {result.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

        {result.kind === 'UNAVAILABLE' ? (
          <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
        ) : null}

        {result.kind === 'MALFORMED' ? (
          <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {result.kind === 'NOT_FOUND' ? (
          <EmptyState
            title="فهرستی یافت نشد"
            description="این مسیر در سرویس نگهداری پاسخی نداشت."
          />
        ) : null}

        {result.kind === 'OK' && result.data.items.length === 0 ? (
          // The two empty cases are different sentences: one says nothing has
          // ever been reported, the other says this filter matched none of
          // it. Telling somebody "nothing is open" when they have simply
          // narrowed by a severity nobody has used is a small lie with a
          // real cost.
          filtered ? (
            <EmptyState
              title="چیزی با این پالایش پیدا نشد"
              description="پالایه‌ها را بردارید یا ترکیب دیگری را امتحان کنید."
              action={<ButtonLink href="/maintenance">نمایش همه</ButtonLink>}
            />
          ) : (
            <EmptyState
              title="هیچ درخواست نگهداری‌ای ثبت نشده"
              description="پس از گزارش نخستین خرابی یا سرویس دوره‌ای، همین‌جا دیده می‌شود."
            />
          )
        ) : null}

        {result.kind === 'OK' && result.data.items.length > 0 ? (
          <RequestRows page={result.data} query={query} />
        ) : null}
      </Section>
    </>
  );
}
