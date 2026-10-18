import type { ReactNode } from 'react';

import { Alert, Identifier, IsolatedText, Section, StatusBadge } from '@/ui';
import { formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import { awardRequestStatusLabel } from '@/lib/tender-evaluation-fields';
import { stepStatusLabel } from '@/lib/tender-owner-fields';
import type { AuthorityNote, AuthorityStep } from '@/server/tender-authority';

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

export function AuthorityScreen({
  tenderId,
  steps,
  truncated,
  flash,
}: {
  readonly tenderId: string;
  readonly steps: readonly AuthorityStepView[];
  /** The inbox was longer than the pages looked through. */
  readonly truncated: boolean;
  readonly flash?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Section headingId="tender-summary" title="بررسی موافقت مناقصه">
        <p className="text-sm text-content-muted">
          شناسه <Identifier>{tenderId}</Identifier>
        </p>
        <p className="mt-2 text-sm">
          سیاست موافقتِ سازمان مالک، شما را مرجع این مناقصه نام برده است. مشخصات مناقصه از آنِ
          سازمان مالک است و برای شما خوانده نمی‌شود؛ این صفحه فقط مرحله‌هایی را نشان می‌دهد که سرویس
          به مرجع نشان می‌دهد.
        </p>
        {truncated ? (
          <Alert tone="warning">
            صندوق موافقت‌های شما بیش از آن است که این صفحه همه را بخواند؛ ممکن است مرحلهٔ دیگری از
            این مناقصه نشان داده نشده باشد.
          </Alert>
        ) : null}
      </Section>
      {flash}
      {steps.length === 0 ? (
        <p className="text-sm text-content-muted">
          مرحلهٔ دیگری از این مناقصه در صندوق موافقت‌های شما در انتظار تصمیم نیست.
        </p>
      ) : null}
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
    </div>
  );
}
