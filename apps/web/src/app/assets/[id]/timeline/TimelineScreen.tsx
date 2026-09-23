import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  NoAccessState,
  PageHeader,
  Section,
} from '@/ui';
import { timelineCategoryLabel, timelineCategoryOptions } from '@/lib/labels';
import { formatJalaliDateLong, formatMoney } from '@/lib/format';
import type { AssetTimelinePage, AssetTimelineQuery, ReadResult } from '@/server/assets';

/**
 * Full asset history (docs/16 § 16.6, `/assets/[id]/timeline`).
 *
 * `/assets/[id]`'s dossier already shows the ten most recent entries; this
 * screen is the rest of them — the same `TimelineEntryView` shape, paged
 * instead of truncated. A pure function of what the server read, mirroring
 * `MaintenanceScreen` (PR #73): every state — a page of entries, an empty
 * history, a filter that matched nothing, a refusal, an outage — is
 * renderable in a test rather than reachable only against a live stack.
 *
 * Filtering and paging live in the URL, for the same reason every other list
 * screen in this portal does it that way: no JavaScript is involved, and a
 * filtered history is a link somebody can send to a colleague.
 */

export interface TimelineScreenProps {
  readonly result: ReadResult<AssetTimelinePage>;
  readonly assetId: string;
  readonly query: AssetTimelineQuery;
}

function hrefWith(
  assetId: string,
  query: AssetTimelineQuery,
  changes: Partial<AssetTimelineQuery>,
) {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.category) params.set('category', merged.category);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  const base = `/assets/${encodeURIComponent(assetId)}/timeline`;
  return search ? `${base}?${search}` : base;
}

/**
 * Not `Field` from the design system, for the same reason every other `GET`
 * filter form in this portal is not: `Field` is a client component that owns
 * generated ids, and this form needs no JavaScript at all.
 */
const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Filters({ assetId, query }: { assetId: string; query: AssetTimelineQuery }) {
  return (
    <form
      method="get"
      action={`/assets/${encodeURIComponent(assetId)}/timeline`}
      className="flex flex-wrap items-end gap-4"
      aria-label="پالایش تاریخچه"
    >
      <label htmlFor="filter-category" className="flex flex-col gap-1 text-sm text-content-muted">
        بخش
        <select
          id="filter-category"
          name="category"
          defaultValue={query.category ?? ''}
          className={CONTROL}
        >
          <option value="">همه</option>
          {timelineCategoryOptions.map((option) => (
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

function EntryRows({
  page,
  assetId,
  query,
}: {
  page: AssetTimelinePage;
  assetId: string;
  query: AssetTimelineQuery;
}) {
  return (
    <>
      <ol className="flex flex-col gap-4">
        {page.items.map((entry) => (
          <li key={entry.id} className="border-s-2 border-border ps-4">
            <p className="text-content">{entry.title}</p>
            <p className="text-sm text-content-muted">
              {timelineCategoryLabel(entry.category)} · {formatJalaliDateLong(entry.occurredAt)}
              {entry.amountMinor ? ` · ${formatMoney(entry.amountMinor)}` : ''}
            </p>
            {entry.description ? (
              <p className="text-sm text-content-muted">{entry.description}</p>
            ) : null}
          </li>
        ))}
      </ol>

      {page.hasMore && page.nextCursor ? (
        <div className="mt-4 flex justify-start">
          <ButtonLink tone="secondary" href={hrefWith(assetId, query, { cursor: page.nextCursor })}>
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </>
  );
}

export function TimelineScreen({ result, assetId, query }: TimelineScreenProps) {
  const filtered = Boolean(query.category);
  const dossierHref = `/assets/${encodeURIComponent(assetId)}`;

  return (
    <>
      <PageHeader
        title="تاریخچهٔ دارایی"
        description="هر رویدادی که برای این دستگاه ثبت شده، تازه‌ترین در بالا."
        actions={
          <ButtonLink tone="secondary" href={dossierHref}>
            بازگشت به پرونده
          </ButtonLink>
        }
      />

      <Section headingId="filters" title="پالایش">
        <Filters assetId={assetId} query={query} />
      </Section>

      <Section headingId="timeline-entries" title="فهرست">
        {result.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

        {result.kind === 'UNAVAILABLE' ? (
          <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
        ) : null}

        {result.kind === 'MALFORMED' ? (
          <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {result.kind === 'NOT_FOUND' ? (
          // The same answer a cross-tenant read gets, and deliberately so: a
          // distinct "exists but not yours" would confirm the id to somebody
          // who should not learn it.
          <EmptyState
            title="این دارایی پیدا نشد"
            description="شناسه اشتباه است یا در سازمان فعال شما نیست."
          />
        ) : null}

        {result.kind === 'OK' && result.data.items.length === 0 ? (
          filtered ? (
            <EmptyState
              title="چیزی با این پالایش پیدا نشد"
              description="پالایه را بردارید یا بخش دیگری را امتحان کنید."
              action={<ButtonLink href={`${dossierHref}/timeline`}>نمایش همه</ButtonLink>}
            />
          ) : (
            <EmptyState
              title="رویدادی ثبت نشده"
              description="هر تخصیص، کارکرد، تعمیر یا هزینه‌ای که ثبت شود، اینجا می‌آید."
            />
          )
        ) : null}

        {result.kind === 'OK' && result.data.items.length > 0 ? (
          <EntryRows page={result.data} assetId={assetId} query={query} />
        ) : null}
      </Section>
    </>
  );
}
