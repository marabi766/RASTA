import Link from 'next/link';

import {
  Alert,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
} from '@/ui';
import { formatJalaliDateLong } from '@/lib/format';
import {
  SETTLEMENT_SIMULATION_NOTICE,
  SETTLEMENT_VIEWS,
  SETTLEMENT_VIEW_LABELS,
  type SettlementView,
} from '@/lib/settlement-fields';
import { formatOrderAmount } from '@/app/orders/OrdersScreen';
import type {
  ReadResult,
  Settlement,
  SettlementListQuery,
  SettlementPage,
} from '@/server/settlements';
import { withContext, type InContext } from '@/lib/page-context';

/**
 * The settlement list (docs/16 § ۱۶٫۶, `/settlements`).
 *
 * A pure function of what the server read, like `OrdersScreen`. The side and
 * the page live in the URL, so no JavaScript is involved.
 *
 * Two lists, not one: an organization pays in one settlement and is paid in
 * the next, and economic-service asks which side you mean (`incoming`). The
 * tab names the side by what happened to the money, and each row names the
 * *other* party.
 *
 * Read-only, and it says what these are: nothing here is connected to a bank
 * (ADR-024).
 */

export interface SettlementsScreenProps {
  readonly result: ReadResult<SettlementPage>;
  readonly query: InContext<SettlementListQuery>;
}

function hrefWith(context: string, view: SettlementView, cursor?: string): string {
  const params = new URLSearchParams({ view });
  if (cursor) params.set('cursor', cursor);
  return withContext(context, `/settlements?${params.toString()}`);
}

function ViewTabs({ query }: { query: InContext<SettlementListQuery> }) {
  return (
    <nav aria-label="سمت تسویه" className="flex flex-wrap gap-2">
      {SETTLEMENT_VIEWS.map((view) => (
        <Link
          key={view}
          href={hrefWith(query.context, view)}
          aria-current={view === query.view ? 'page' : undefined}
          className={
            view === query.view
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {SETTLEMENT_VIEW_LABELS[view]}
        </Link>
      ))}
    </nav>
  );
}

function SettlementRow({ settlement, view }: { settlement: Settlement; view: SettlementView }) {
  const counterparty =
    view === 'PAID' ? settlement.payeeOrganizationId : settlement.payerOrganizationId;
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/settlements/${encodeURIComponent(settlement.id)}`}
          className="font-medium underline"
        >
          تسویهٔ <Identifier>{settlement.id}</Identifier>
        </Link>
        <span className="text-sm text-content-muted">
          {formatJalaliDateLong(settlement.settledAt)}
        </span>
      </div>
      <p className="mt-2 text-sm">
        {view === 'PAID' ? 'پرداخت به' : 'دریافت از'} <Identifier>{counterparty}</Identifier>
      </p>
      <p className="mt-1 text-sm">
        مبلغ خالص:{' '}
        <span className="font-medium">
          {formatOrderAmount(settlement.netAmountMinor, settlement.currency)}
        </span>
      </p>
    </li>
  );
}

export function SettlementsScreen({ result, query }: SettlementsScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title="حالت نمایشی">
        {SETTLEMENT_SIMULATION_NOTICE}
      </Alert>
      <ViewTabs query={query} />
      <SettlementsBody result={result} query={query} />
    </div>
  );
}

function SettlementsBody({ result, query }: SettlementsScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست تسویه‌های این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="تسویه‌ای یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست تسویه‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="settlements" title={SETTLEMENT_VIEW_LABELS[query.view]}>
      {page.items.length === 0 ? (
        <EmptyState
          title="تسویه‌ای نیست"
          description={
            query.view === 'RECEIVED'
              ? 'هنوز تسویه‌ای به نفع این سازمان انجام نشده است.'
              : 'این سازمان هنوز تسویه‌ای پرداخت نکرده است.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.items.map((settlement) => (
            <SettlementRow key={settlement.id} settlement={settlement} view={query.view} />
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={hrefWith(query.context, query.view, page.nextCursor)} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
