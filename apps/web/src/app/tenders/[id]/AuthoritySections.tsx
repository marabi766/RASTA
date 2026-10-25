import type { ReactNode } from 'react';

import { Alert, ButtonLink, Identifier, IsolatedText, Section, StatusBadge } from '@/ui';
import { formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import { awardRequestStatusLabel } from '@/lib/tender-evaluation-fields';
import { stepStatusLabel } from '@/lib/tender-owner-fields';
import type { AuthorityNote, AuthorityStep } from '@/server/tender-authority';

import { THRESHOLD_WARNING_TEXT } from '@/lib/procurement-threshold-fields';
import { StepBid } from './EvaluationSections';

/**
 * The page of a tender approval's authority who may not read the tender
 * (`server/tender-authority.ts`): an authority of another organization, named
 * by the owner's publication or award policy. Its steps of this tender as the
 * service shows them to it — the project's title, the step, the request and,
 * for an award, the bid it names — and the decision forms; nothing of the
 * tender itself.
 */

const NOTES: Readonly<Record<AuthorityNote, string>> = {
  STEP_REFUSED:
    'سرویس این مرحله را به شما نشان نمی‌دهد — مثلاً چون در ارزیابی نقش داشته‌اید، عضو سازمانی هستید که پیشنهاد داده، یا نقش لازم را اکنون ندارید — و تصمیم دربارهٔ آن را هم از شما نمی‌پذیرد.',
  STEP_UNREAD:
    'این مرحله برای نسخه‌اش خوانده نشد، پس فرم تصمیم عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.',
  OWN_REQUEST:
    'این درخواست را شما داده‌اید. تفکیک وظایف: کسی که درخواست داده خودش با آن موافقت نمی‌کند؛ ردکردن آن با شماست.',
  NOT_DECIDABLE:
    'این مرحله، آن‌طور که اکنون خوانده شد، در انتظار تصمیم شما نیست: یا تصمیم گرفته شده، یا درخواستش پایان یافته، یا سازمان یا نقشی که نام می‌برد شما نیستید.',
};

const WORKFLOW_TITLES: Readonly<Record<string, string>> = {
  'tender.publication': 'موافقت با انتشار مناقصه',
  'tender.award': 'موافقت با واگذاری مناقصه',
};

export interface AuthorityStepView {
  readonly step: AuthorityStep;
  readonly notes: readonly AuthorityNote[];
  readonly commands?: ReactNode;
}

/** Where the walk through the caller's approval inbox stands. */
export interface InboxWalk {
  /** The inbox was longer than the pages looked through. */
  readonly truncated: boolean;
  /** Where the walk through the inbox goes on, when `truncated`. */
  readonly continueHref?: string | null;
  /** The walk's start, when this page began further on. */
  readonly restartHref?: string | null;
  /**
   * A page of the inbox could not be read (PR 346 review 3, finding 2): the steps found before it
   * are shown, and the walk is retried from the page that failed.
   */
  readonly failure?: { readonly correlationId: string | null; readonly retryHref: string } | null;
}

/** The walk's warnings and the ways on: retry, go on, start again. */
function InboxStatus({ walk, found }: { readonly walk: InboxWalk; readonly found: boolean }) {
  const { truncated, continueHref = null, restartHref = null, failure = null } = walk;
  return (
    <>
      {failure ? (
        <Alert tone="danger" title="صندوق موافقت‌ها خوانده نشد">
          بخشی از صندوق موافقت‌های شما خوانده نشد، پس جست‌وجوی مرحله‌های این مناقصه کامل نیست
          {found ? '؛ مرحله‌هایی که تا اینجا پیدا شد در زیر آمده است' : ''}. کمی بعد دوباره امتحان
          کنید؛ جست‌وجو از همان جایی که ماند ادامه می‌یابد.
          {failure.correlationId ? (
            <>
              {' '}
              کد پیگیری: <Identifier>{failure.correlationId}</Identifier>
            </>
          ) : null}
        </Alert>
      ) : null}
      {truncated && !failure ? (
        <Alert tone="warning">
          صندوق موافقت‌های در انتظار شما بیش از آن است که این صفحه یک‌جا بخواند؛ ممکن است مرحلهٔ
          {found ? ' دیگری' : ''} از این مناقصه در ادامهٔ صندوق باشد.
        </Alert>
      ) : null}
      {failure || (truncated && continueHref) || restartHref ? (
        <div className="mt-3 flex flex-wrap gap-3">
          {failure ? (
            <ButtonLink href={failure.retryHref} tone="secondary">
              تلاش دوباره برای خواندن صندوق
            </ButtonLink>
          ) : continueHref ? (
            <ButtonLink href={continueHref} tone="secondary">
              ادامهٔ جست‌وجو در صندوق موافقت‌ها
            </ButtonLink>
          ) : null}
          {restartHref ? (
            <ButtonLink href={restartHref} tone="quiet">
              جست‌وجو از آغاز صندوق
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** One section per step: the project, the step, the request and its bid, the notes and forms. */
function AuthoritySteps({ steps }: { readonly steps: readonly AuthorityStepView[] }) {
  return (
    <>
      {steps.map(({ step, notes, commands }) => (
        <Section
          key={step.id}
          headingId={`tender-authority-${step.id.replace(/[^A-Za-z0-9_-]/g, '_')}`}
          title={WORKFLOW_TITLES[step.workflowKey] ?? step.workflowKey}
        >
          <div className="flex flex-col gap-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-content-muted">پروژه</dt>
                <dd>
                  <IsolatedText>{step.project.title}</IsolatedText>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-content-muted">
                  مرحلهٔ {toPersianDigits(String(step.stepOrder))}
                </dt>
                <dd>
                  <IsolatedText>{step.authorityLabel}</IsolatedText> ·{' '}
                  <StatusBadge status={step.status} label={stepStatusLabel(step.status)} />
                </dd>
              </div>
              <div>
                <dt className="text-sm text-content-muted">درخواست</dt>
                <dd>
                  {step.request
                    ? awardRequestStatusLabel(step.request.status)
                    : 'درخواستی خوانده نشد'}
                  {step.requestedAt ? ` · ${formatJalaliDateTime(step.requestedAt)}` : ''}
                </dd>
              </div>
            </dl>
            {step.request?.procurementThresholdWarning ? (
              <Alert tone="warning">{THRESHOLD_WARNING_TEXT}</Alert>
            ) : null}
            {step.request?.bid ? <StepBid bid={step.request.bid} /> : null}
            {notes.map((note) => (
              <Alert key={note} tone="info">
                {NOTES[note]}
              </Alert>
            ))}
            {commands}
          </div>
        </Section>
      ))}
    </>
  );
}

const complete = (walk: InboxWalk) => !walk.truncated && !walk.failure;

export function AuthorityScreen({
  tenderId,
  steps,
  flash,
  ...walk
}: InboxWalk & {
  readonly tenderId: string;
  readonly steps: readonly AuthorityStepView[];
  readonly flash?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Section headingId="tender-summary" title="بررسی موافقت مناقصه">
        <p className="text-sm text-content-muted">
          شناسه <Identifier>{tenderId}</Identifier>
        </p>
        {steps.length > 0 ? (
          <p className="mt-2 text-sm">
            سیاست موافقتِ سازمان مالک، شما را مرجع این مناقصه نام برده است. مشخصات مناقصه از آنِ
            سازمان مالک است و برای شما خوانده نمی‌شود؛ این صفحه فقط مرحله‌هایی را نشان می‌دهد که
            سرویس به مرجع نشان می‌دهد.
          </p>
        ) : (
          <p className="mt-2 text-sm">
            مشخصات این مناقصه برای شما خوانده نمی‌شود. اگر سیاست موافقتِ سازمان مالک شما را مرجع آن
            نام برده باشد، مرحله‌اش در صندوق موافقت‌های شماست و این صفحه آن را آنجا می‌جوید.
          </p>
        )}
        <InboxStatus walk={walk} found={steps.length > 0} />
      </Section>
      {flash}
      {steps.length === 0 && complete(walk) ? (
        <p className="text-sm text-content-muted">
          مرحلهٔ دیگری از این مناقصه در صندوق موافقت‌های شما در انتظار تصمیم نیست.
        </p>
      ) : null}
      <AuthoritySteps steps={steps} />
    </div>
  );
}

/**
 * The caller's approval decisions on this tender, beside what its bid-side roles
 * read (PR 346 review 3, finding 1): an opener or evaluator who is also named by
 * the owner's award or publication policy decides its step here. Nothing when
 * a completed walk found none.
 */
export function AuthorityInboxSection({
  steps,
  ...walk
}: InboxWalk & { readonly steps: readonly AuthorityStepView[] }) {
  if (steps.length === 0 && complete(walk) && !walk.restartHref) return null;
  return (
    <>
      <Section headingId="tender-authority-inbox" title="موافقت‌های شما در این مناقصه">
        <p className="text-sm">
          {steps.length > 0
            ? 'سیاست موافقتِ سازمان مالک، شما را مرجع مرحله‌ای از این مناقصه نام برده است؛ تصمیم دربارهٔ آن جدا از نقش شما در گشایش یا ارزیابی است.'
            : 'مرحله‌ای از این مناقصه در آن بخش از صندوق موافقت‌های شما که خوانده شد نیست.'}
        </p>
        <InboxStatus walk={walk} found={steps.length > 0} />
      </Section>
      <AuthoritySteps steps={steps} />
    </>
  );
}
