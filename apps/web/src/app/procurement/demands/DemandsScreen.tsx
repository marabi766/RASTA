import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { DEMAND_STATUSES, type DemandStatus } from '@/lib/demand-commands';
import { formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import { demandStatusLabel } from '@/lib/labels';
import { withContext, type InContext } from '@/lib/page-context';
import type { DemandListQuery, DemandPage, DemandRecord, ReadResult } from '@/server/demands';

/**
 * The organization's demands (`/procurement/demands`), newest first. A pure
 * function of what the server read, like `SuppliersScreen`; the filter and the
 * cursor live in the URL.
 *
 * An empty page is "none" only when it is the end of the list: a page that came
 * back empty with a `nextCursor`, after `DEMAND_LIST_MAX_PAGES` were followed,
 * says that more may exist and links on (checklist D 8). Nothing here counts a
 * total: the count shown is of this page.
 */

export interface DemandsScreenProps {
  readonly result: ReadResult<DemandPage>;
  readonly query: InContext<DemandListQuery>;
  /** The create form with its notices, when the page found the person may submit. */
  readonly create?: ReactNode;
}

export function demandsHref(
  query: InContext<DemandListQuery>,
  changes: Partial<DemandListQuery> = {},
): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const text = params.toString();
  return withContext(query.context, `/procurement/demands${text ? `?${text}` : ''}`);
}

function StatusFilter({ query }: { query: InContext<DemandListQuery> }) {
  const items: readonly (DemandStatus | undefined)[] = [undefined, ...DEMAND_STATUSES];
  return (
    <nav aria-label="وضعیت نیاز" className="flex flex-wrap gap-2">
      {items.map((status) => (
        <Link
          key={status ?? 'ALL'}
          href={demandsHref(query, { status, cursor: undefined })}
          aria-current={status === query.status ? 'page' : undefined}
          className={
            status === query.status
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {status ? demandStatusLabel(status) : 'همه وضعیت‌ها'}
        </Link>
      ))}
    </nav>
  );
}

function DemandRow({ demand, context }: { demand: DemandRecord; context: string }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={withContext(context, `/procurement/demands/${encodeURIComponent(demand.id)}`)}
          className="font-medium underline"
        >
          نیاز <Identifier>{demand.id}</Identifier>
        </Link>
        <StatusBadge status={demand.status} label={demandStatusLabel(demand.status)} />
      </div>
      <p className="mt-2 text-sm">
        کالا <Identifier>{demand.productId}</Identifier> · مقدار{' '}
        {toPersianDigits(String(demand.quantity))}
      </p>
      <p className="mt-1 text-sm text-content-muted">
        ثبت در {formatJalaliDateTime(demand.submittedAt)}
      </p>
    </li>
  );
}

export function DemandsScreen({ result, query, create = null }: DemandsScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      {create ? (
        <Section headingId="demand-create" title="ثبت نیاز تازه">
          {create}
        </Section>
      ) : null}
      <StatusFilter query={query} />
      <DemandsBody result={result} query={query} />
    </div>
  );
}

function DemandsBody({ result, query }: Pick<DemandsScreenProps, 'result' | 'query'>) {
  if (result.kind === 'FORBIDDEN') {
    // A refusal is not an empty list: whether any demand exists is unknown here.
    return <NoAccessState description="نیازهای این سازمان برای نقش شما در دسترس نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState title="نیازی نمایش داده نمی‌شود" description="این نشست سازمان فعالی ندارد." />
    );
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست نیازها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;
  return (
    <Section headingId="demands" title="نیازهای سازمان">
      {page.items.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} نیاز در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((demand) => (
              <DemandRow key={demand.id} demand={demand} context={query.context} />
            ))}
          </ul>
        </>
      ) : page.nextCursor ? (
        <EmptyState
          title="در صفحه‌های خوانده‌شده نیازی نبود"
          description="ممکن است در صفحه‌های بعد نیازی باشد؛ برای دیدن آن‌ها صفحه بعد را باز کنید."
        />
      ) : (
        <EmptyState
          title="نیازی نیست"
          description={
            query.cursor
              ? 'در این صفحه نیازی نیست؛ ممکن است ردیف‌های صفحه‌های پیشین از آن زمان تغییر کرده باشند. فهرست را از ابتدا ببینید.'
              : query.status
                ? 'نیازی با این وضعیت ثبت نشده است.'
                : 'هنوز نیازی برای این سازمان ثبت نشده است.'
          }
        />
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={demandsHref(query, { cursor: page.nextCursor })} tone="secondary">
            صفحه بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
