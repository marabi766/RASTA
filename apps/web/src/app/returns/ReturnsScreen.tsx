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
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  RETURN_LIST_SIDES,
  RETURN_LIST_SIDE_LABELS,
  RETURN_STATUSES,
  returnStatusLabel,
  type ReturnListSide,
} from '@/lib/return-fields';
import type { ReadResult } from '@/server/assets';
import type { ReturnListQuery, ReturnPage, ReturnRequest } from '@/server/returns';
import { withContext, type InContext } from '@/lib/page-context';

/**
 * The return requests of this organization (EXP-003, `/returns`), on either
 * side: the ones it asked for as a buyer, and the ones asked of it as a
 * supplier — marketplace-service asks which side is meant (`role`), as for
 * orders, so the screen asks too: a tab per side.
 *
 * A pure function of what the server read: every state is renderable in a
 * test. Side, status and paging live in the URL, so a filtered list is a link
 * somebody can send. Nothing here is a refund, and nothing says one happened.
 */

export interface ReturnsScreenProps {
  readonly result: ReadResult<ReturnPage>;
  readonly query: InContext<ReturnListQuery>;
  /** The requests on which this viewer has a command to issue now (`returnCommandsFor`). */
  readonly actionable: ReadonlySet<string>;
}

function hrefWith(query: InContext<ReturnListQuery>, changes: Partial<ReturnListQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams({ role: merged.side });
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  return withContext(query.context, `/returns?${params.toString()}`);
}

function SideTabs({ query }: { query: InContext<ReturnListQuery> }) {
  return (
    <nav aria-label="سمت درخواست بازگشت" className="flex flex-wrap gap-2">
      {RETURN_LIST_SIDES.map((side: ReturnListSide) => (
        <Link
          key={side}
          href={hrefWith(query, { side, cursor: undefined, status: undefined })}
          aria-current={side === query.side ? 'page' : undefined}
          className={
            side === query.side
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {RETURN_LIST_SIDE_LABELS[side]}
        </Link>
      ))}
    </nav>
  );
}

function StatusFilter({ query }: { query: InContext<ReturnListQuery> }) {
  return (
    <nav aria-label="وضعیت درخواست بازگشت" className="flex flex-wrap gap-2 text-sm">
      <Link
        href={hrefWith(query, { status: undefined, cursor: undefined })}
        aria-current={query.status === undefined ? 'page' : undefined}
        className={query.status === undefined ? 'font-medium underline' : 'text-content-muted'}
      >
        همه
      </Link>
      {RETURN_STATUSES.map((status) => (
        <Link
          key={status}
          href={hrefWith(query, { status, cursor: undefined })}
          aria-current={query.status === status ? 'page' : undefined}
          className={query.status === status ? 'font-medium underline' : 'text-content-muted'}
        >
          {returnStatusLabel(status)}
        </Link>
      ))}
    </nav>
  );
}

function units(request: ReturnRequest): number {
  return request.lines.reduce((sum, line) => sum + line.quantity, 0);
}

function ReturnRow({ request, actionable }: { request: ReturnRequest; actionable: boolean }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/returns/${encodeURIComponent(request.id)}`} className="font-medium underline">
          درخواست بازگشت <Identifier>{request.id}</Identifier>
        </Link>
        <StatusBadge status={request.status} label={returnStatusLabel(request.status)} />
      </div>
      <p className="mt-2 text-sm">
        سفارش <Identifier>{request.orderId}</Identifier>
      </p>
      <p className="mt-1 text-sm text-content-muted">
        {toPersianDigits(String(request.lines.length))} ردیف ·{' '}
        {toPersianDigits(String(units(request)))} واحد · ثبت در{' '}
        {formatJalaliDateLong(request.requestedAt)}
      </p>
      {actionable ? (
        // A cue, not the action: it is taken on the request's own page.
        <p className="mt-2 text-sm font-medium">اقدامی از سوی شما لازم است</p>
      ) : null}
    </li>
  );
}

export function ReturnsScreen({ result, query, actionable }: ReturnsScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      <SideTabs query={query} />
      <StatusFilter query={query} />
      <ReturnsBody result={result} query={query} actionable={actionable} />
    </div>
  );
}

function ReturnsBody({ result, query, actionable }: ReturnsScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="درخواست‌های بازگشت این سازمان در اختیار نقش شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="درخواستی یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست درخواست‌های بازگشت خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;
  return (
    <Section headingId="returns" title={RETURN_LIST_SIDE_LABELS[query.side]}>
      {page.items.length === 0 ? (
        <EmptyState
          title="درخواست بازگشتی نیست"
          description={
            query.side === 'SUPPLIER'
              ? 'هنوز درخواست بازگشتی به این سازمان داده نشده است.'
              : 'این سازمان هنوز درخواست بازگشتی ثبت نکرده است. بازگشت کالا از صفحهٔ سفارش تکمیل‌شده درخواست می‌شود.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.items.map((request) => (
            <ReturnRow key={request.id} request={request} actionable={actionable.has(request.id)} />
          ))}
        </ul>
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
