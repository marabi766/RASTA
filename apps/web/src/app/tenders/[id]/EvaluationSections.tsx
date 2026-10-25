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
import { bidStatusLabel } from '@/lib/bid-fields';
import { standingVerdictLabel } from '@/lib/labels';
import {
  formatJalaliDateTime,
  formatMoney,
  formatScaledDecimal,
  toPersianDigits,
} from '@/lib/format';
import {
  EVALUATION_STAGE_TEXT,
  READINESS_BLOCKED_TEXT,
  awardRequestStatusLabel,
  disqualificationLabel,
  recusalLabel,
} from '@/lib/tender-evaluation-fields';
import type { ReadResult } from '@/server/assets';
import type {
  AwardApproval,
  AwardNote,
  EvaluationMatrix,
  EvaluationNote,
  MatrixBid,
} from '@/server/tender-evaluation';
import type { ApprovalRequest, TenderAward } from '@/server/tender-owner';

import { RequestView, type RequestWording } from './OwnerSections';

/**
 * The evaluation and the award on `/tenders/[id]` (EXP-004): the matrix as
 * construction-service shows it to the owner's evaluators — every opened bid,
 * its decision, each evaluator's latest scores and totals, the ranking — and
 * the award: its approval round, the bid an award step names, and the award
 * once made. Server components; the forms inside are `OwnerCommands`. Scores
 * cross the API as integers (the points × 100; a weighted total × 10⁶) and are
 * said here as decimals, in Persian digits, never through a float.
 */

/** A weighted total is Σ weightBp × score × 100: the points × 10⁶. */
const TOTAL_SCALE = 6;

const points = (scaled: number): string => formatScaledDecimal(String(scaled), 2);
const weighted = (scaled: string): string => formatScaledDecimal(scaled, TOTAL_SCALE);

const EVALUATION_NOTES: Readonly<Record<Exclude<EvaluationNote, 'READINESS_BLOCKED'>, string>> = {
  NO_QUALIFIED_BID:
    'هیچ پیشنهاد واجد شرایطی نماند، پس ارزیابی کامل نمی‌شود؛ این مناقصه فقط لغو می‌شود (لغو در این صفحه نیست).',
  EVALUATION_INCOMPLETE:
    'ارزیابی هنوز کامل نمی‌شود: پیشنهادی بی‌تصمیم مانده، یا پیشنهاد واجد شرایطی به شمار لازم ارزیاب کامل ندارد.',
};

const AWARD_NOTES: Readonly<Record<AwardNote, string>> = {
  AWARD_PENDING:
    'درخواست واگذاری در انتظار تصمیم مرجعی است که سیاست موافقت نام برده. انتخاب دیگری، درخواستِ در انتظار را پایان می‌دهد و از نو موافقت می‌خواهد.',
  OWN_AWARD_REQUEST:
    'درخواست واگذاری را شما داده‌اید و در انتظار تصمیم مرجع است. تفکیک وظایف: کسی که درخواست داده خودش با آن موافقت نمی‌کند. انتخاب دیگری، این درخواست را پایان می‌دهد و از نو موافقت می‌خواهد.',
  AWARD_APPROVED:
    'با درخواست واگذاری موافقت شده است؛ فقط همان انتخاب، با همان دلیل، اجرا می‌شود. پیش از اجرا صلاحیت کنونی برنده دوباره پرسیده می‌شود.',
  AWARDER_IS_EVALUATOR:
    'تفکیک وظایف: شما در ارزیابی این مناقصه نقش داشته‌اید (تصمیم، امتیاز، کناره‌گیری یا تکمیل ارزیابی)، پس واگذاری با شخص دیگری است.',
  AWARD_REQUESTS_UNREAD:
    'درخواست‌های موافقت واگذاری خوانده نشد، پس معلوم نیست چه کاری در انتظار است و فرم واگذاری عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  AWARD_MATRIX_UNREAD:
    'ماتریس ارزیابی برای شما خوانده نمی‌شود، پس این صفحه نه رتبهٔ پیشنهادها را می‌داند و نه این‌که شما در ارزیابی نقش داشته‌اید یا نه. اگر انتخابتان تنها رتبهٔ نخست نباشد و دلیلی ننویسید، یا در ارزیابی نقش داشته باشید، سرویس واگذاری را با دلیلش رد می‌کند.',
  AWARD_BIDS_UNREAD:
    'نه ماتریس ارزیابی و نه فهرست پیشنهادهای گشوده این بار خوانده نشد، پس پیشنهاد واجد شرایطی نیست که این صفحه نام ببرد و فرم درخواست واگذاری عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  AWARD_CANDIDATES_UNREADABLE:
    'در این نسخهٔ پورتال، آغاز واگذاری به خواندن ماتریس ارزیابی یا فهرست پیشنهادهای گشوده نیاز دارد و نقش‌های شما هیچ‌کدام را نمی‌خوانند؛ پس پیشنهادی نیست که این صفحه نام ببرد و فرم درخواست واگذاری عرضه نمی‌شود. اجرای واگذاریِ موافقت‌شده به این خواندن نیاز ندارد.',
  AWARD_STEP_UNREAD:
    'مرحلهٔ موافقت واگذاری، که پیشنهاد انتخاب‌شده را نام می‌برد، خوانده نشد؛ پس فرم آن عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  AWARD_STEP_REFUSED:
    'سرویس این مرحلهٔ موافقت واگذاری را به شما نشان نمی‌دهد — مثلاً چون در ارزیابی نقش داشته‌اید، عضو سازمانی هستید که پیشنهاد داده، یا نقش لازم را اکنون ندارید — و تصمیم دربارهٔ آن را هم از شما نمی‌پذیرد.',
};

export interface EvaluationSectionProps {
  readonly matrix: ReadResult<EvaluationMatrix>;
  readonly notes: readonly EvaluationNote[];
  readonly commands?: ReactNode;
}

/** The evaluation: the matrix, what stands in the way of completing it, and the evaluators' forms. */
export function EvaluationSection({ matrix, notes, commands }: EvaluationSectionProps) {
  return (
    <Section headingId="tender-evaluation" title="ارزیابی پیشنهادها">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-muted">
          سامانه رتبه‌بندی می‌کند و برنده را برنمی‌گزیند؛ رتبهٔ مشترک برنده‌ای نمی‌سازد. هر بار که
          این بخش خوانده می‌شود، سرویس آن را برای هر پیشنهاد در دفتر دسترسی ثبت می‌کند.
        </p>
        <MatrixView matrix={matrix} notes={notes} />
        {commands}
      </div>
    </Section>
  );
}

function MatrixView({
  matrix,
  notes,
}: {
  readonly matrix: ReadResult<EvaluationMatrix>;
  readonly notes: readonly EvaluationNote[];
}) {
  if (matrix.kind === 'FORBIDDEN' || matrix.kind === 'NOT_FOUND') {
    return (
      <NoAccessState description="ارزیابی این مناقصه برای شما خوانده نمی‌شود: یا نقش ارزیابی را اکنون ندارید، یا عضو سازمانی هستید که پیشنهاد داده است، یا — اگر این قاعده برقرار باشد — مناقصه را خودتان ساخته یا منتشر کرده‌اید." />
    );
  }
  if (matrix.kind === 'UNAVAILABLE' && matrix.status === 422) {
    return <p>پیشنهادهای این مناقصه هنوز گشوده نشده‌اند و ارزیابی‌ای در کار نیست.</p>;
  }
  if (matrix.kind !== 'OK') {
    return (
      <ErrorState
        description="ماتریس ارزیابی خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={matrix.correlationId}
      />
    );
  }
  const view = matrix.data;
  const labels = new Map(view.criteria.map((criterion) => [criterion.code, criterion.label]));
  return (
    <div className="flex flex-col gap-4">
      <p>{EVALUATION_STAGE_TEXT[view.status] ?? view.status}</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-content-muted">بیشترین امتیاز وزنی یک ارزیاب</dt>
          <dd>{weighted(view.maxTotalScaled)}</dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">ارزیاب کامل لازم برای هر پیشنهاد</dt>
          <dd>{toPersianDigits(String(view.minEvaluators))}</dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">پیشنهاد بی‌تصمیم</dt>
          <dd>{toPersianDigits(String(view.undecidedBidCount))}</dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-1 text-sm" aria-label="معیارهای منجمد">
        {view.criteria.map((criterion) => (
          <li key={criterion.code}>
            <IsolatedText>{criterion.label}</IsolatedText> — وزن{' '}
            {formatScaledDecimal(String(criterion.weightBp), 2)}٪ · بیشینه{' '}
            {formatScaledDecimal(String(criterion.maxScore), 0)}
            {criterion.scoringMethod === 'PASS_FAIL' ? ' · قبول/رد' : ''}
          </li>
        ))}
      </ul>
      {view.readinessBlockedBy !== null ? (
        <Alert tone="warning">
          {READINESS_BLOCKED_TEXT[view.readinessBlockedBy] ??
            'ارزیاب‌های شمرده‌شده افراد جداگانه‌ای شناخته نمی‌شوند و ارزیابی کامل نمی‌شود.'}
        </Alert>
      ) : null}
      {notes
        .filter(
          (note): note is Exclude<EvaluationNote, 'READINESS_BLOCKED'> =>
            note !== 'READINESS_BLOCKED',
        )
        .map((note) => (
          <Alert key={note} tone="info">
            {EVALUATION_NOTES[note]}
          </Alert>
        ))}
      {view.bids.length === 0 ? (
        <EmptyState
          title="پیشنهادی گشوده نشد"
          description="این مناقصه پیشنهاد گشوده‌شده‌ای ندارد."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="پیشنهادها در ماتریس">
          {view.bids.map((bid) => (
            <MatrixRow
              key={bid.bidId}
              bid={bid}
              labels={labels}
              required={view.blockers.find((blocker) => blocker.bidId === bid.bidId)?.required}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MatrixRow({
  bid,
  labels,
  required,
}: {
  readonly bid: MatrixBid;
  readonly labels: ReadonlyMap<string, string>;
  /** Set when the bid is short of complete evaluators: how many it needs. */
  readonly required?: number;
}) {
  const decision = bid.qualification;
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-content-muted">پیشنهاددهنده</dt>
          <dd>
            <Identifier>{bid.bidderOrganizationId}</Identifier>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">وضعیت</dt>
          <dd>
            <StatusBadge status={bid.bidStatus} label={bidStatusLabel(bid.bidStatus)} />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">رتبه</dt>
          <dd>
            {bid.rank === null
              ? '—'
              : `${toPersianDigits(String(bid.rank))}${bid.tied ? ' (مشترک)' : ''}`}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-content-muted">جمع امتیاز وزنی</dt>
          <dd>
            {bid.totalScaled === null ? '—' : weighted(bid.totalScaled)} ·{' '}
            {toPersianDigits(String(bid.evaluatorCount))} ارزیاب کامل
            {required !== undefined ? ` از ${toPersianDigits(String(required))} لازم` : ''}
          </dd>
        </div>
      </dl>
      {decision ? (
        <p className="mt-3 text-sm">
          {decision.decision === 'QUALIFIED' ? 'واجد شرایط' : 'فاقد شرایط'}
          {decision.reasonCode ? ` — ${disqualificationLabel(decision.reasonCode)}` : ''} ·{' '}
          <Identifier>{decision.decidedBy}</Identifier> · {formatJalaliDateTime(decision.decidedAt)}
          {decision.reasonText ? (
            <>
              <br />
              شرح: <IsolatedText>{decision.reasonText}</IsolatedText>
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-3 text-sm">هنوز کسی دربارهٔ این پیشنهاد تصمیم نگرفته است.</p>
      )}
      {bid.evaluations.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 text-sm" aria-label="امتیاز ارزیاب‌ها">
          {bid.evaluations.map((evaluation) => (
            <li key={evaluation.evaluatorId}>
              ارزیاب <Identifier>{evaluation.evaluatorId}</Identifier>:{' '}
              {evaluation.totalScaled === null
                ? 'هنوز همهٔ معیارها را امتیاز نداده'
                : `امتیاز وزنی ${weighted(evaluation.totalScaled)}`}
              {evaluation.cells.length > 0 ? (
                <>
                  {' — '}
                  {evaluation.cells.map((cell, index) => (
                    <span key={cell.criterionCode}>
                      {index > 0 ? '، ' : ''}
                      <IsolatedText>
                        {labels.get(cell.criterionCode) ?? cell.criterionCode}
                      </IsolatedText>{' '}
                      {points(cell.scoreScaled)}
                    </span>
                  ))}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {bid.recusals.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-sm" aria-label="کناره‌گیری از ارزیابی">
          {bid.recusals.map((recusal) => (
            <li key={recusal.evaluatorId}>
              <Identifier>{recusal.evaluatorId}</Identifier> کنار رفت —{' '}
              {recusalLabel(recusal.reasonCode)} · {formatJalaliDateTime(recusal.recusedAt)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const AWARD_WORDING: RequestWording = {
  latest: 'آخرین درخواست واگذاری',
  none: 'هنوز درخواست واگذاری‌ای برای این مناقصه ثبت نشده است.',
  unread: 'درخواست‌های موافقت واگذاری خوانده نشد. کمی بعد دوباره تلاش کنید.',
  statusLabel: awardRequestStatusLabel,
};

export interface AwardSectionProps {
  readonly status: string;
  readonly request: ReadResult<ApprovalRequest | null> | null;
  /** The award step read for this person, with the bid its request names. */
  readonly step: ReadResult<AwardApproval> | null;
  /** The award once made; null when not read. */
  readonly award: ReadResult<TenderAward> | null;
  readonly notes: readonly AwardNote[];
  readonly commands?: ReactNode;
}

/** The award: its approval round, the bid a step names, the award once made, and the forms. */
export function AwardSection({ status, request, step, award, notes, commands }: AwardSectionProps) {
  return (
    <Section headingId="tender-award" title="واگذاری">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-muted">
          شخصی برنده را برمی‌گزیند و سامانه انتخاب نمی‌کند. واگذاری موافقت می‌خواهد؛ کسی که درخواست
          داده و — اگر این قاعده برقرار باشد — کسی که در ارزیابی نقش داشته، با آن موافقت نمی‌کند.
        </p>
        {status === 'AWARDED' ? <AwardView award={award} /> : null}
        <RequestView request={request} wording={AWARD_WORDING} />
        {step?.kind === 'OK' && step.data.request?.bid ? (
          <StepBid bid={step.data.request.bid} />
        ) : null}
        {notes.map((note) => (
          <Alert key={note} tone="info">
            {AWARD_NOTES[note]}
          </Alert>
        ))}
        {commands}
      </div>
    </Section>
  );
}

export function StepBid({
  bid,
}: {
  readonly bid: NonNullable<NonNullable<AwardApproval['request']>['bid']>;
}) {
  return (
    <dl
      className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
      aria-label="پیشنهادی که درخواست نام برده"
    >
      <div>
        <dt className="text-sm text-content-muted">پیشنهاد انتخاب‌شده</dt>
        <dd>
          <Identifier>{bid.bidderOrganizationId}</Identifier>
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">رتبه در ماتریس</dt>
        <dd>
          {toPersianDigits(String(bid.rank))}
          {bid.tied ? ' (مشترک)' : ''}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">صلاحیت به گفتهٔ سرویس تأمین‌کنندگان</dt>
        <dd>
          {standingVerdictLabel(bid.standingVerdict)} · {formatJalaliDateTime(bid.standingAsOf)}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">دلیل انتخاب</dt>
        <dd className="whitespace-pre-line">
          {bid.justification === null ? (
            'بی‌دلیل (تنها رتبهٔ نخست)'
          ) : (
            <IsolatedText>{bid.justification}</IsolatedText>
          )}
        </dd>
      </div>
    </dl>
  );
}

function AwardView({ award }: { readonly award: ReadResult<TenderAward> | null }) {
  if (award === null) {
    return <p>این مناقصه واگذار شده است.</p>;
  }
  if (award.kind === 'FORBIDDEN') {
    return (
      <NoAccessState description="جزئیات واگذاری، که مبلغ برنده را دارد، برای شما خوانده نمی‌شود: یا نقش واگذاری را اکنون ندارید، یا عضو سازمانی هستید که پیشنهاد داده است." />
    );
  }
  if (award.kind === 'NOT_FOUND') {
    return <p>جزئیات واگذاری پیدا نشد. صفحه را تازه کنید.</p>;
  }
  if (award.kind !== 'OK') {
    return (
      <ErrorState
        description="جزئیات واگذاری خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={award.correlationId}
      />
    );
  }
  const view = award.data;
  return (
    <dl className="grid gap-3 sm:grid-cols-2" aria-label="واگذاری">
      <div>
        <dt className="text-sm text-content-muted">برنده</dt>
        <dd>
          <Identifier>{view.bidderOrganizationId}</Identifier>
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">مبلغ پیشنهاد برنده</dt>
        <dd>{formatMoney(view.amountMinor)}</dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">رتبه در ماتریس منجمد</dt>
        <dd>
          {toPersianDigits(String(view.rank))}
          {view.tied ? ' (مشترک)' : ''}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">واگذاری</dt>
        <dd>
          <Identifier>{view.awardedBy}</Identifier> · {formatJalaliDateTime(view.awardedAt)}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">دلیل انتخاب</dt>
        <dd className="whitespace-pre-line">
          {view.justification === null ? (
            'بی‌دلیل (تنها رتبهٔ نخست)'
          ) : (
            <IsolatedText>{view.justification}</IsolatedText>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-content-muted">صلاحیت برنده پرسیده شد در</dt>
        <dd>{formatJalaliDateTime(view.standingAsOf)}</dd>
      </div>
    </dl>
  );
}
