import Link from 'next/link';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateLong, formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import {
  TENDER_STATUSES,
  TENDER_STATUS_LABELS,
  tenderNatureLabel,
  tenderStatusLabel,
  tenderVisibilityLabel,
  type TenderStatus,
} from '@/lib/tender-fields';
import type {
  OpenTenderPage,
  OpenTenderSummary,
  ReadResult,
  TenderListQuery,
  TenderPage,
  TenderSummary,
} from '@/server/tenders';

/**
 * The tender list (docs/16 § ۱۶٫۶, `/tenders`).
 *
 * A pure function of what the server read, like `ProjectsScreen`: every state is
 * renderable in a test. Filters and paging live in the URL, so no JavaScript is
 * involved and a filtered list is a link somebody can send.
 *
 * Up to two sections, each from its own gateway door and each decided by
 * construction-service: the organization's own tenders (owner side) and the
 * published tenders it may bid on (bidder side). Nothing about a tender's bids —
 * their content, their bidders, how many there are — is read or shown here:
 * sealed-bid confidentiality (ADR-066) holds by never asking.
 */

export interface TendersQuery extends TenderListQuery {
  /** The bidder-side list is paged independently of the owner's. */
  readonly openCursor?: string;
}

export type TendersView =
  /** Who the person is could not be read, so which door to knock on is unknown. */
  | { readonly kind: 'IDENTITY_UNAVAILABLE'; readonly correlationId: string }
  | {
      readonly kind: 'SIDES';
      /** `null`: the owner's door was not asked. */
      readonly own: ReadResult<TenderPage> | null;
      /** `null`: the bidder's door was not asked. */
      readonly open: ReadResult<OpenTenderPage> | null;
    };

export interface TendersScreenProps {
  readonly view: TendersView;
  readonly query: TendersQuery;
}

function hrefWith(query: TendersQuery, changes: Partial<TendersQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  if (merged.openCursor) params.set('openCursor', merged.openCursor);
  const text = params.toString();
  return text ? `/tenders?${text}` : '/tenders';
}

function StatusFilter({ query }: { query: TendersQuery }) {
  const items: readonly (TenderStatus | undefined)[] = [undefined, ...TENDER_STATUSES];
  return (
    <nav aria-label="وضعیت مناقصه" className="flex flex-wrap gap-2">
      {items.map((status) => (
        <Link
          key={status ?? 'ALL'}
          href={hrefWith(query, { status, cursor: undefined })}
          aria-current={status === query.status ? 'page' : undefined}
          className={
            status === query.status
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {status ? TENDER_STATUS_LABELS[status] : 'همه'}
        </Link>
      ))}
    </nav>
  );
}

/** The bidding window, both ends in Jalali with the time of day; absent is said. */
export function formatBidWindow(opening: string | null, closing: string | null): string {
  if (opening === null || closing === null) return 'بازهٔ پیشنهاد تعیین نشده';
  return `از ${formatJalaliDateTime(opening)} تا ${formatJalaliDateTime(closing)}`;
}

function OwnTenderRow({ tender }: { tender: TenderSummary }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/tenders/${encodeURIComponent(tender.id)}`} className="font-medium underline">
          {tender.title}
        </Link>
        <StatusBadge status={tender.status} label={tenderStatusLabel(tender.status)} />
      </div>
      <p className="mt-2 text-sm text-content-muted">
        {tenderNatureLabel(tender.procurementNature)} · {tenderVisibilityLabel(tender.visibility)}
      </p>
      <p className="mt-1 text-sm">{formatBidWindow(tender.bidOpeningAt, tender.bidClosingAt)}</p>
      <p className="mt-1 text-sm text-content-muted">
        شناسه <Identifier>{tender.id}</Identifier> · آخرین تغییر{' '}
        {formatJalaliDateLong(tender.statusChangedAt)}
      </p>
    </li>
  );
}

function OpenTenderRow({ tender }: { tender: OpenTenderSummary }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/tenders/${encodeURIComponent(tender.id)}?view=open`}
          className="font-medium underline"
        >
          {tender.title}
        </Link>
      </div>
      <p className="mt-2 text-sm text-content-muted">
        {tenderNatureLabel(tender.procurementNature)} · {tenderVisibilityLabel(tender.visibility)}
      </p>
      <p className="mt-1 text-sm">{formatBidWindow(tender.bidOpeningAt, tender.bidClosingAt)}</p>
      <p className="mt-1 text-sm text-content-muted">
        شناسه <Identifier>{tender.id}</Identifier>
      </p>
    </li>
  );
}

export function TendersScreen({ view, query }: TendersScreenProps) {
  if (view.kind === 'IDENTITY_UNAVAILABLE') {
    return (
      <ErrorState
        description="نقش شما در این سازمان خوانده نشد، پس فهرست مناقصه‌ها نشان داده نمی‌شود. کمی بعد دوباره تلاش کنید."
        correlationId={view.correlationId}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {view.own ? <OwnSection result={view.own} query={query} /> : null}
      {view.open ? <OpenSection result={view.open} query={query} /> : null}
    </div>
  );
}

function OwnSection({ result, query }: { result: ReadResult<TenderPage>; query: TendersQuery }) {
  return (
    <div className="flex flex-col gap-4">
      <StatusFilter query={query} />
      <OwnBody result={result} query={query} />
    </div>
  );
}

function OwnBody({ result, query }: { result: ReadResult<TenderPage>; query: TendersQuery }) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست مناقصه‌های این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="مناقصه‌ای یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست مناقصه‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="own-tenders" title="مناقصه‌های سازمان">
      {page.items.length === 0 ? (
        <EmptyState
          title="مناقصه‌ای نیست"
          description={
            query.status
              ? `مناقصه‌ای در وضعیت «${tenderStatusLabel(query.status)}» نیست.`
              : 'این سازمان هنوز مناقصه‌ای ثبت نکرده است.'
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} مناقصه در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((tender) => (
              <OwnTenderRow key={tender.id} tender={tender} />
            ))}
          </ul>
        </>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={hrefWith(query, { cursor: page.nextCursor })} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}

function OpenSection({
  result,
  query,
}: {
  result: ReadResult<OpenTenderPage>;
  query: TendersQuery;
}) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="مناقصه‌های باز برای پیشنهاد در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="مناقصه‌ای یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست مناقصه‌های باز خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="open-tenders" title="مناقصه‌های باز برای پیشنهاد">
      {page.items.length === 0 ? (
        <EmptyState
          title="مناقصهٔ بازی نیست"
          description="در حال حاضر مناقصه‌ای که این سازمان بتواند برایش پیشنهاد بدهد منتشر نشده است."
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} مناقصه در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((tender) => (
              <OpenTenderRow key={tender.id} tender={tender} />
            ))}
          </ul>
        </>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={hrefWith(query, { openCursor: page.nextCursor })} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
