import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateTime, formatMoney, toPersianDigits } from '@/lib/format';
import { bidStatusLabel } from '@/lib/bid-fields';
import { roleLabel } from '@/lib/organization-fields';
import {
  OWNER_RESENT_NOTE,
  ownerDoneText,
  requestStatusLabel,
  stepStatusLabel,
  type OwnerDone,
} from '@/lib/tender-owner-fields';
import type { ReadResult } from '@/server/assets';
import {
  THRESHOLD_WARNING_TEXT,
  THRESHOLD_REJECT_TEXT,
  THRESHOLD_REQUIRED_TEXT,
  THRESHOLD_UNREAD_TEXT,
  THRESHOLD_PREVIEW_NOTE,
} from '@/lib/procurement-threshold-fields';
import type { ThresholdPreview } from '@/server/tender-owner';
import type { ApprovalRequest, OwnerBids, OwnerNote } from '@/server/tender-owner';

/**
 * The owner's sections of `/tenders/[id]` (EXP-004): the publication and its
 * approval, the two-person opening, and the bids as the service shows them to
 * an opener — a count and times before the opening, the opened bids after it.
 * Server components; the forms inside are `OwnerCommands`.
 */

const NOTES: Readonly<Record<Exclude<OwnerNote, null>, string>> = {
  PUBLICATION_PENDING:
    'درخواست انتشار در انتظار تصمیم مرجعی است که سیاست موافقت نام برده؛ تا آن تصمیم، انتشار عرضه نمی‌شود.',
  OWN_REQUEST:
    'درخواست انتشار را شما داده‌اید و در انتظار تصمیم مرجع است. تفکیک وظایف: کسی که درخواست داده خودش با آن موافقت نمی‌کند؛ اگر مرجع همین مرحله باشید، رد آن با شماست.',
  REQUEST_BEHIND:
    'آخرین درخواست انتشار برای نسخهٔ پیشینِ مناقصه داده شده است و برای این نسخه معتبر نیست. درخواست تازه آن را پایان می‌دهد و از نو موافقت می‌خواهد.',
  REQUESTS_UNREAD:
    'درخواست‌های موافقت انتشار خوانده نشد، پس معلوم نیست چه کاری در انتظار است و فرمی عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  STEP_UNREAD:
    'مرحلهٔ موافقتی که بررسی آن با شماست خوانده نشد، پس فرم تصمیم عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  AWAITING_CLOSE:
    'مهلت پذیرش پیشنهاد گذشته است. مناقصه را سامانه خودش در پایان مهلت می‌بندد و کسی آن را دستی نمی‌بندد؛ پس از بسته‌شدن، گشایش پیشنهادها عرضه می‌شود.',
};

export function OwnerFlash({ done }: { readonly done?: OwnerDone }) {
  if (!done) return null;
  const { text, resent } = ownerDoneText(done);
  return (
    <Alert tone="success" title="انجام شد">
      {text}
      {resent ? <> {OWNER_RESENT_NOTE}</> : null}
    </Alert>
  );
}

function Notes({ notes }: { readonly notes: readonly OwnerNote[] }) {
  const shown = notes.filter((note): note is Exclude<OwnerNote, null> => note !== null);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((note) => (
        <Alert key={note} tone="info">
          {NOTES[note]}
        </Alert>
      ))}
    </>
  );
}

export interface PublicationSectionProps {
  readonly thresholdPreview?: ReadResult<ThresholdPreview> | null;
  readonly tenderVersion?: number;
  /** The newest publication request; null when not read (the tender is past its draft). */
  readonly request: ReadResult<ApprovalRequest | null> | null;
  readonly notes: readonly OwnerNote[];
  readonly commands?: ReactNode;
}

/** The publication and its approval round: who decides, and where each step stands. */
export function PublicationSection({
  request,
  notes,
  commands,
  thresholdPreview,
  tenderVersion,
}: PublicationSectionProps) {
  return (
    <Section headingId="tender-publication" title="انتشار و موافقت">
      <div className="flex flex-col gap-4">
        {thresholdPreview ? (
          <ThresholdPreviewView result={thresholdPreview} tenderVersion={tenderVersion} />
        ) : null}
        <RequestView request={request} />
        <Notes notes={notes} />
        {commands}
      </div>
    </Section>
  );
}

export function ThresholdPreviewView({
  result,
  tenderVersion,
}: {
  readonly result: ReadResult<ThresholdPreview>;
  readonly tenderVersion?: number;
}) {
  if (result.kind !== 'OK' || result.data.tenderVersion !== tenderVersion)
    return <Alert tone="warning">{THRESHOLD_UNREAD_TEXT}</Alert>;
  const decision = result.data.decision;
  return (
    <div>
      {decision === 'WARN' ? <Alert tone="warning">{THRESHOLD_WARNING_TEXT}</Alert> : null}
      {decision === 'REJECT' ? <Alert tone="danger">{THRESHOLD_REJECT_TEXT}</Alert> : null}
      {decision === 'ESTIMATE_REQUIRED' ? (
        <Alert tone="danger">{THRESHOLD_REQUIRED_TEXT}</Alert>
      ) : null}
      <p className="text-sm text-content-muted">{THRESHOLD_PREVIEW_NOTE}</p>
    </div>
  );
}

/** How a workflow's requests are named: the publication's (the default), or the award's. */
export interface RequestWording {
  readonly latest: string;
  readonly none: string;
  readonly unread: string;
  readonly statusLabel: (status: string) => string;
}

const PUBLICATION_WORDING: RequestWording = {
  latest: 'آخرین درخواست انتشار',
  none: 'هنوز درخواست انتشاری برای این مناقصه ثبت نشده است.',
  unread: 'درخواست‌های موافقت انتشار خوانده نشد. کمی بعد دوباره تلاش کنید.',
  statusLabel: requestStatusLabel,
};

/** The newest request of a workflow and where each of its steps stands. */
export function RequestView({
  request,
  wording = PUBLICATION_WORDING,
}: {
  readonly request: ReadResult<ApprovalRequest | null> | null;
  readonly wording?: RequestWording;
}) {
  if (request === null) return null;
  if (request.kind === 'FORBIDDEN' || request.kind === 'NOT_FOUND') {
    return <NoAccessState description="درخواست‌های موافقت این مناقصه در اختیار شما نیست." />;
  }
  if (request.kind !== 'OK') {
    return <ErrorState description={wording.unread} correlationId={request.correlationId} />;
  }
  const latest = request.data;
  if (latest === null) {
    return <p>{wording.none}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-content-muted">{wording.latest}</dt>
          <dd>
            <StatusBadge status={latest.status} label={wording.statusLabel(latest.status)} />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">دور</dt>
          <dd>{toPersianDigits(String(latest.round))}</dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">ثبت در</dt>
          <dd>{formatJalaliDateTime(latest.requestedAt)}</dd>
        </div>
      </dl>
      {latest.procurementThresholdWarning ? (
        <Alert tone="warning">{THRESHOLD_WARNING_TEXT}</Alert>
      ) : null}
      <ol className="flex flex-col gap-2" aria-label="مراحل موافقت">
        {latest.steps.map((step) => (
          <li
            key={step.approvalId}
            className="rounded-md border border-border bg-surface-raised p-3 text-sm"
          >
            <span className="font-medium">
              مرحلهٔ {toPersianDigits(String(step.stepOrder))}:{' '}
              <IsolatedText>{step.authorityLabel}</IsolatedText>
            </span>
            <span className="text-content-muted">
              {' '}
              · سازمان <Identifier>{step.authorityOrganizationId}</Identifier> · نقش{' '}
              {roleLabel(step.authorityRole)} · {stepStatusLabel(step.status)}
              {step.decidedAt ? ` · ${formatJalaliDateTime(step.decidedAt)}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface OpeningSectionProps {
  /** The tender's status; null for a caller who may not read the tender (`isOpeningOnly`). */
  readonly status: string | null;
  /** Whether the bids are opened, when the status is not known. */
  readonly opened?: boolean;
  readonly notes: readonly OwnerNote[];
  readonly commands?: ReactNode;
}

/** The two-person opening of a closed tender's bids. */
export function OpeningSection({ status, opened = false, notes, commands }: OpeningSectionProps) {
  return (
    <Section headingId="tender-opening" title="گشایش پیشنهادها">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-muted">
          گشایش دو نفره است: یک نفر آن را پیشنهاد می‌دهد و نفر مجاز دیگری انجامش می‌دهد. هیچ‌کدام
          عضو سازمانی نیستند که در مناقصه پیشنهاد داده است. این صفحه نمی‌داند پیشنهاد گشایشی ثبت شده
          یا نه، پس هر سه کار را عرضه می‌کند و سرویس کار نابجا را با دلیلش رد می‌کند.
        </p>
        {status === 'CLOSED' ? null : (
          <p>
            {status === 'PUBLISHED'
              ? 'پیشنهادها پس از بسته‌شدن مناقصه گشوده می‌شوند.'
              : status === null && !opened
                ? 'پیشنهادها فقط پس از بسته‌شدن مناقصه در پایان مهلت گشوده می‌شوند. نقش شما وضعیت مناقصه را نمی‌خواند؛ اگر هنوز بسته نشده باشد، سرویس گشایش را با دلیلش رد می‌کند.'
                : 'پیشنهادهای این مناقصه گشوده شده‌اند.'}
          </p>
        )}
        <Notes notes={notes} />
        {commands}
      </div>
    </Section>
  );
}

/**
 * The page of an opener or an evaluator who may not read the tender itself
 * (`isBidSideOnly`): its id, why nothing else of it is shown, then what those
 * roles read — the opening and the bids, the evaluation.
 */
export function OpeningOnlyScreen({
  tenderId,
  opens = true,
  evaluates = false,
  children,
}: {
  readonly tenderId: string;
  readonly opens?: boolean;
  readonly evaluates?: boolean;
  readonly children: ReactNode;
}) {
  const duty =
    opens && evaluates
      ? 'گشایش و ارزیابی پیشنهادهای مناقصه‌های سازمان'
      : evaluates
        ? 'ارزیابی پیشنهادهای مناقصه‌های سازمان'
        : 'گشایش پیشنهادهای مناقصه‌های سازمان';
  const shown =
    opens && evaluates
      ? 'گشایش، پیشنهادها و ارزیابی را'
      : evaluates
        ? 'ارزیابی را'
        : 'گشایش و پیشنهادها را';
  return (
    <div className="flex flex-col gap-6">
      <Section
        headingId="tender-summary"
        title={opens ? 'گشایش پیشنهادهای مناقصه' : 'ارزیابی پیشنهادهای مناقصه'}
      >
        <p className="text-sm text-content-muted">
          شناسه <Identifier>{tenderId}</Identifier>
        </p>
        <p className="mt-2 text-sm">
          نقش شما {duty} است و مشخصات مناقصه را نمی‌خواند؛ این صفحه فقط {shown}، آن‌طور که سرویس به
          نقش شما نشان می‌دهد، نشان می‌دهد.
        </p>
      </Section>
      {children}
    </div>
  );
}

export interface OwnerBidsSectionProps {
  readonly bids: ReadResult<OwnerBids>;
  /** The tender's criteria, for an answer's label. */
  readonly criteria: ReadonlyMap<string, string>;
}

/**
 * The bids as construction-service shows them to an opener: before the opening
 * only how many and when, never who or what; after it, each bid with what it
 * says. Every read is audited by the service.
 */
export function OwnerBidsSection({ bids, criteria }: OwnerBidsSectionProps) {
  return (
    <Section headingId="tender-owner-bids" title="پیشنهادهای رسیده">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-muted">
          هر بار که این بخش خوانده می‌شود، سرویس آن را در دفتر دسترسی به پیشنهادها ثبت می‌کند.
        </p>
        <OwnerBids bids={bids} criteria={criteria} />
      </div>
    </Section>
  );
}

function OwnerBids({ bids, criteria }: OwnerBidsSectionProps) {
  if (bids.kind === 'FORBIDDEN' || bids.kind === 'NOT_FOUND') {
    return (
      <NoAccessState description="پیشنهادهای این مناقصه برای شما خوانده نمی‌شوند: یا نقش گشایش را ندارید، یا عضو سازمانی هستید که پیشنهاد داده است." />
    );
  }
  if (bids.kind !== 'OK') {
    return (
      <ErrorState
        description="پیشنهادهای این مناقصه خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={bids.correlationId}
      />
    );
  }
  const view = bids.data;
  if (!view.opened) {
    if (view.bidCount === 0) {
      return (
        <EmptyState
          title="پیشنهادی نرسیده"
          description="تاکنون پیشنهادی برای این مناقصه نرسیده است."
        />
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p>
          {toPersianDigits(String(view.bidCount))} پیشنهاد رسیده است. پیش از گشایش نه پیشنهاددهنده
          نشان داده می‌شود و نه محتوا.
        </p>
        <ul className="flex flex-col gap-1 text-sm" aria-label="زمان دریافت پیشنهادها">
          {view.receivedAt.map((at, index) => (
            <li key={`${at}-${index}`}>{formatJalaliDateTime(at)}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (view.bids.length === 0) {
    return (
      <EmptyState title="پیشنهادی گشوده نشد" description="این مناقصه پیشنهاد پابرجایی نداشت." />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {view.bids.map((bid) => (
        <li key={bid.bidId} className="rounded-md border border-border bg-surface-raised p-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-content-muted">پیشنهاددهنده</dt>
              <dd>
                <Identifier>{bid.bidderOrganizationId}</Identifier>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-content-muted">مبلغ پیشنهاد</dt>
              <dd>{formatMoney(bid.content.priceMinor)}</dd>
            </div>
            <div>
              <dt className="text-sm text-content-muted">وضعیت</dt>
              <dd>
                <StatusBadge status={bid.status} label={bidStatusLabel(bid.status)} />
              </dd>
            </div>
            <div>
              <dt className="text-sm text-content-muted">نسخه و زمان دریافت</dt>
              <dd>
                {toPersianDigits(String(bid.revision))} · {formatJalaliDateTime(bid.receivedAt)}
              </dd>
            </div>
          </dl>
          {bid.content.answers.length > 0 ? (
            <dl className="mt-3 flex flex-col gap-2">
              {bid.content.answers.map((answer) => (
                <div key={answer.criterionCode}>
                  <dt className="text-sm text-content-muted">
                    <IsolatedText>
                      {criteria.get(answer.criterionCode) ?? answer.criterionCode}
                    </IsolatedText>
                  </dt>
                  <dd className="whitespace-pre-line">
                    <IsolatedText>{answer.response}</IsolatedText>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {bid.content.note ? (
            <p className="mt-3 whitespace-pre-line text-sm">
              یادداشت: <IsolatedText>{bid.content.note}</IsolatedText>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
