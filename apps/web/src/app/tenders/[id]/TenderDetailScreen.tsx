import type { ReactNode } from 'react';

import { EmptyState, ErrorState, Identifier, NoAccessState, Section, StatusBadge } from '@/ui';
import { formatJalaliDateLong, formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import {
  formatWeightBp,
  scoringMethodLabel,
  statusReasonCodeLabel,
  tenderNatureLabel,
  tenderStatusLabel,
  tenderVisibilityLabel,
} from '@/lib/tender-fields';
import type {
  OpenTenderDetail,
  ReadResult,
  TenderCriteria,
  TenderCriterion,
  TenderDetail,
} from '@/server/tenders';

/**
 * The tender detail (docs/16 § ۱۶٫۶, `/tenders/[id]`), read-only, in two forms
 * for the two sides of a tender.
 *
 * Every outcome the server can hand back is rendered with fixed Persian text; a
 * refusal's own wording is never echoed. A tender the caller may not see answers
 * 404 from the service and is shown with the same words as an id that does not
 * exist: a distinct "exists but not yours" would confirm the id to somebody who
 * should not learn it.
 *
 * Bids are not part of this screen at all — no content, no bidder, no count
 * (ADR-066). Placing or withdrawing a bid, opening, evaluation and award are
 * later slices.
 */

const NOT_FOUND_TITLE = 'این مناقصه پیدا نشد';
const NOT_FOUND_DESCRIPTION = 'شناسه اشتباه است یا این مناقصه برای شما در دسترس نیست.';

function Failure({ result }: { result: Exclude<ReadResult<unknown>, { kind: 'OK' }> }) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این مناقصه در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title={NOT_FOUND_TITLE} description={NOT_FOUND_DESCRIPTION} />;
  }

  return (
    <ErrorState
      description="جزئیات مناقصه خوانده نشد. کمی بعد دوباره تلاش کنید."
      correlationId={result.correlationId}
    />
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-content-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ScopeSection({ scopeOfWork }: { scopeOfWork: string }) {
  return (
    <Section headingId="tender-scope" title="شرح کار">
      {scopeOfWork ? (
        <p className="whitespace-pre-line">{scopeOfWork}</p>
      ) : (
        <EmptyState
          title="شرح کاری ثبت نشده"
          description="برای این مناقصه شرح کار نوشته نشده است."
        />
      )}
    </Section>
  );
}

function CriteriaList({ items }: { items: readonly TenderCriterion[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((criterion) => (
        <li
          key={criterion.code}
          className="rounded-md border border-border bg-surface-raised p-3 text-sm"
        >
          <span className="font-medium">{criterion.label}</span>
          <span className="text-content-muted">
            {' '}
            · وزن {formatWeightBp(criterion.weightBp)} ·{' '}
            {scoringMethodLabel(criterion.scoringMethod)} · حداکثر امتیاز{' '}
            {toPersianDigits(String(criterion.maxScore))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The owner's view of the criteria, which is read separately and may fail alone. */
function OwnCriteriaSection({ result }: { result: ReadResult<TenderCriteria> }) {
  if (result.kind !== 'OK') {
    return (
      <Section headingId="tender-criteria" title="معیارهای ارزیابی">
        {result.kind === 'FORBIDDEN' || result.kind === 'NOT_FOUND' ? (
          <NoAccessState description="معیارهای ارزیابی این مناقصه در اختیار شما نیست." />
        ) : (
          <ErrorState
            description="معیارهای ارزیابی خوانده نشد. کمی بعد دوباره تلاش کنید."
            correlationId={result.correlationId}
          />
        )}
      </Section>
    );
  }

  const { items, totalWeightBp, complete } = result.data;

  return (
    <Section headingId="tender-criteria" title="معیارهای ارزیابی">
      {items.length === 0 ? (
        <EmptyState
          title="معیاری ثبت نشده"
          description="برای این مناقصه هنوز معیار ارزیابی تعیین نشده است."
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(items.length))} معیار · مجموع وزن‌ها{' '}
            {formatWeightBp(totalWeightBp)}
            {complete ? '' : ' (کامل نیست)'}
          </p>
          <CriteriaList items={items} />
        </>
      )}
    </Section>
  );
}

export interface OwnTenderDetailScreenProps {
  readonly result: ReadResult<TenderDetail>;
  /** `null` when the tender itself could not be read, so criteria were not asked. */
  readonly criteria: ReadResult<TenderCriteria> | null;
}

export function OwnTenderDetailScreen({ result, criteria }: OwnTenderDetailScreenProps) {
  if (result.kind !== 'OK') return <Failure result={result} />;

  const tender = result.data;
  const reasonCode = statusReasonCodeLabel(tender.statusReasonCode);

  return (
    <div className="flex flex-col gap-6">
      <Section headingId="tender-summary" title={tender.title}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={tender.status} label={tenderStatusLabel(tender.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{tender.id}</Identifier>
          </span>
        </div>
        {reasonCode ? <p className="mt-2 text-sm">دلیل: {reasonCode}</p> : null}
        {tender.statusReason ? (
          <p className="mt-2 text-sm">توضیح ثبت‌شده برای این وضعیت: {tender.statusReason}</p>
        ) : null}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Term label="نوع">{tenderNatureLabel(tender.procurementNature)}</Term>
          <Term label="دسترسی">{tenderVisibilityLabel(tender.visibility)}</Term>
          <Term label="آغاز پذیرش پیشنهاد">
            {tender.bidOpeningAt ? formatJalaliDateTime(tender.bidOpeningAt) : 'تعیین نشده'}
          </Term>
          <Term label="پایان پذیرش پیشنهاد">
            {tender.bidClosingAt ? formatJalaliDateTime(tender.bidClosingAt) : 'تعیین نشده'}
          </Term>
          <Term label="انتشار">
            {tender.publishedAt ? formatJalaliDateLong(tender.publishedAt) : 'منتشر نشده'}
          </Term>
          <Term label="ثبت در">{formatJalaliDateLong(tender.createdAt)}</Term>
          <Term label="آخرین تغییر وضعیت">{formatJalaliDateLong(tender.statusChangedAt)}</Term>
          <Term label="پروژه">
            <Identifier>{tender.projectId}</Identifier>
          </Term>
        </dl>
      </Section>

      <ScopeSection scopeOfWork={tender.scopeOfWork} />

      {criteria ? <OwnCriteriaSection result={criteria} /> : null}
    </div>
  );
}

/** The person's roles could not be read, so which door to knock on is unknown: none is. */
export function IdentityUnavailableDetailScreen({ correlationId }: { correlationId: string }) {
  return (
    <ErrorState
      description="نقش شما در این سازمان خوانده نشد، پس جزئیات مناقصه نشان داده نمی‌شود. کمی بعد دوباره تلاش کنید."
      correlationId={correlationId}
    />
  );
}

export interface OpenTenderDetailScreenProps {
  readonly result: ReadResult<OpenTenderDetail>;
}

export function OpenTenderDetailScreen({ result }: OpenTenderDetailScreenProps) {
  if (result.kind !== 'OK') return <Failure result={result} />;

  const tender = result.data;

  return (
    <div className="flex flex-col gap-6">
      <Section headingId="tender-summary" title={tender.title}>
        <p className="text-sm text-content-muted">
          شناسه <Identifier>{tender.id}</Identifier>
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Term label="نوع">{tenderNatureLabel(tender.procurementNature)}</Term>
          <Term label="دسترسی">{tenderVisibilityLabel(tender.visibility)}</Term>
          <Term label="آغاز پذیرش پیشنهاد">{formatJalaliDateTime(tender.bidOpeningAt)}</Term>
          <Term label="پایان پذیرش پیشنهاد">{formatJalaliDateTime(tender.bidClosingAt)}</Term>
        </dl>
      </Section>

      <ScopeSection scopeOfWork={tender.scopeOfWork} />

      <Section headingId="tender-criteria" title="معیارهای ارزیابی">
        {tender.criteria.length === 0 ? (
          <EmptyState
            title="معیاری ثبت نشده"
            description="برای این مناقصه معیار ارزیابی‌ای اعلام نشده است."
          />
        ) : (
          <CriteriaList items={tender.criteria} />
        )}
      </Section>
    </div>
  );
}
