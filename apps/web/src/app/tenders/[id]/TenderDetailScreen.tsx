import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { BID_COMMAND_DONE, bidStatusLabel, type BidCommand } from '@/lib/bid-fields';
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
import type { BidNote, BidReceipt } from '@/server/tender-bids';

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
 * On the bidder's side the organization's **own** bid is shown — its
 * receipt, revision and status, never its content (sealed; ADR-066 § 4) — with
 * the forms to submit, replace or withdraw it where construction-service would
 * accept them (`OwnBidSection`). Nothing of another bid, a bidder or a count
 * is ever shown. Opening, evaluation and award are the owner's, and later
 * slices.
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
  /** The owner's sections — publication, opening, bids (`OwnerSections`) — when there are any. */
  readonly owner?: ReactNode;
}

export function OwnTenderDetailScreen({ result, criteria, owner }: OwnTenderDetailScreenProps) {
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

      {owner}
    </div>
  );
}

const BID_NOTES: Readonly<Record<Exclude<BidNote, null>, string>> = {
  NOT_OPEN: 'بازهٔ پذیرش پیشنهاد هنوز آغاز نشده است؛ فرم پیشنهاد از زمان آغاز بازه عرضه می‌شود.',
  CLOSED: 'مهلت پذیرش پیشنهاد گذشته است؛ پیشنهادی ثبت، جایگزین یا پس گرفته نمی‌شود.',
  UNREAD:
    'پیشنهاد سازمان شما برای این مناقصه خوانده نشد، پس معلوم نیست پیشنهادی ثبت شده یا نه و فرمی عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  REFUSED: 'ثبت پیشنهاد برای این مناقصه در اختیار شما نیست.',
};

export interface OwnBidSectionProps {
  /** The organization's own bid, as `…/bids/mine` answered; null when it was not asked. */
  readonly bid: ReadResult<BidReceipt>;
  readonly note: BidNote;
  /** A command this session just confirmed (`server/flash.ts`). */
  readonly done?: BidCommand;
  /** The forms, drawn by `BidCommands` (a client component). */
  readonly commands?: ReactNode;
}

/**
 * The bidder's own bid on this tender: what construction-service holds of it —
 * never its content — and the forms the page may offer. A bid that could not
 * be read is said to be unknown, never absent.
 */
export function OwnBidSection({ bid, note, done, commands }: OwnBidSectionProps) {
  return (
    <Section headingId="tender-own-bid" title="پیشنهاد سازمان شما">
      <div className="flex flex-col gap-4">
        {done ? (
          <Alert tone="success" title="انجام شد">
            {BID_COMMAND_DONE[done]}
          </Alert>
        ) : null}
        <OwnBid bid={bid} />
        <p className="text-sm text-content-muted">
          محتوای پیشنهاد در سرور به کلید همین مناقصه مهر و موم می‌شود و پیش از گشایش برای هیچ‌کس، از
          جمله خود شما، خوانده نمی‌شود؛ این صفحه فقط رسید و وضعیت آن را نشان می‌دهد. صلاحیت
          پیمانکاری سازمان شما را سرویس تأمین‌کنندگان هنگام ثبت یا جایگزینی بررسی می‌کند.
        </p>
        {note && note !== 'UNREAD' && note !== 'REFUSED' ? (
          <Alert tone="info">{BID_NOTES[note]}</Alert>
        ) : null}
        {commands}
      </div>
    </Section>
  );
}

function OwnBid({ bid }: { bid: ReadResult<BidReceipt> }) {
  if (bid.kind === 'NOT_FOUND') {
    return <p>سازمان شما برای این مناقصه پیشنهادی ثبت نکرده است.</p>;
  }
  if (bid.kind === 'FORBIDDEN') return <NoAccessState description={BID_NOTES.REFUSED} />;
  if (bid.kind !== 'OK') {
    return <ErrorState description={BID_NOTES.UNREAD} correlationId={bid.correlationId} />;
  }
  const receipt = bid.data;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <Term label="وضعیت">
        <StatusBadge status={receipt.status} label={bidStatusLabel(receipt.status)} />
      </Term>
      <Term label="نسخه">{toPersianDigits(String(receipt.revision))}</Term>
      <Term label="دریافت در">{formatJalaliDateTime(receipt.receivedAt)}</Term>
      {receipt.withdrawnAt ? (
        <Term label="پس گرفته در">{formatJalaliDateTime(receipt.withdrawnAt)}</Term>
      ) : null}
      <Term label="شناسهٔ پیشنهاد">
        <Identifier>{receipt.bidId}</Identifier>
      </Term>
      <div className="sm:col-span-2">
        <dt className="text-sm text-content-muted">رسید (سر زنجیرهٔ رسیدهای مناقصه)</dt>
        <dd className="break-all">
          <Identifier>{receipt.receipt}</Identifier>
        </dd>
      </div>
    </dl>
  );
}

export interface OpenTenderDetailScreenProps {
  readonly result: ReadResult<OpenTenderDetail>;
  /** The bidder's own bid, when the caller bids at all (`OwnBidSection`). */
  readonly ownBid?: ReactNode;
}

export function OpenTenderDetailScreen({ result, ownBid }: OpenTenderDetailScreenProps) {
  // A tender no longer open for bids — closed, opened, awarded — is not behind
  // the bidder's door any more; the organization's own bid on it still is.
  if (result.kind !== 'OK') {
    return (
      <div className="flex flex-col gap-6">
        <Failure result={result} />
        {ownBid}
      </div>
    );
  }

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

      {ownBid}
    </div>
  );
}
