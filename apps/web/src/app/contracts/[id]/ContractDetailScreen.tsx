import type { ReactNode } from 'react';

import { EmptyState, ErrorState, Identifier, NoAccessState, Section, StatusBadge } from '@/ui';
import {
  IRR,
  formatJalaliDate,
  formatJalaliDateLong,
  formatMoney,
  toPersianDigits,
} from '@/lib/format';
import { amendmentStatusLabel, contractStatusLabel, formatShareBp } from '@/lib/contract-fields';
import type {
  Amendment,
  AmendmentPage,
  ContractDetail,
  Milestone,
  MilestonePage,
  ReadResult,
} from '@/server/contracts';

/**
 * The contract detail (docs/16 § ۱۶٫۶, `/contracts/[id]`), read-only.
 *
 * Every outcome the server can hand back is rendered with fixed Persian text;
 * a refusal's own wording is never echoed. A contract of another
 * organization answers 404 from contract-service, exactly like an id that
 * does not exist (ADR-068 § 7, S-03), and is shown with the same words — a
 * distinct "exists but not yours" would confirm the id to somebody who should
 * not learn it.
 *
 * Amendments and milestones are read separately from the contract itself
 * (like the tender's criteria) and may fail on their own without hiding the
 * contract above them.
 *
 * Signing, cancelling, proposing an amendment and planning a milestone are
 * all out of scope here — read-only, and no statement is read or shown
 * (`server/contracts.ts` explains why).
 */

const NOT_FOUND_TITLE = 'این قرارداد پیدا نشد';
const NOT_FOUND_DESCRIPTION = 'شناسه اشتباه است یا این قرارداد برای شما در دسترس نیست.';

function Failure({ result }: { result: Exclude<ReadResult<unknown>, { kind: 'OK' }> }) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این قرارداد در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title={NOT_FOUND_TITLE} description={NOT_FOUND_DESCRIPTION} />;
  }

  return (
    <ErrorState
      description="جزئیات قرارداد خوانده نشد. کمی بعد دوباره تلاش کنید."
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

function signedAtText(value: string | null): string {
  return value ? formatJalaliDateLong(value) : 'هنوز امضا نشده';
}

function AmendmentRow({ amendment }: { amendment: Amendment }) {
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          الحاقیهٔ {toPersianDigits(String(amendment.amendmentNumber))}
        </span>
        <StatusBadge status={amendment.status} label={amendmentStatusLabel(amendment.status)} />
      </div>
      <p className="mt-1">
        مبلغ: <span className="font-medium">{formatMoney(amendment.deltaMinor, IRR)}</span>
      </p>
      <p className="mt-1 text-content-muted">{amendment.reasonText}</p>
      <p className="mt-1 text-content-muted">
        امضای کارفرما: {signedAtText(amendment.employerSignedAt)} · امضای پیمانکار:{' '}
        {signedAtText(amendment.contractorSignedAt)}
      </p>
      {amendment.authorityReviewRequired ? (
        <p className="mt-1 text-content-muted">این امضا در حال بازبینی اختیار است.</p>
      ) : null}
    </li>
  );
}

/** The amendments, read separately and able to fail on their own. */
function AmendmentsSection({ result }: { result: ReadResult<AmendmentPage> }) {
  if (result.kind !== 'OK') {
    return (
      <Section headingId="contract-amendments" title="الحاقیه‌ها">
        {result.kind === 'FORBIDDEN' || result.kind === 'NOT_FOUND' ? (
          <NoAccessState description="الحاقیه‌های این قرارداد در اختیار شما نیست." />
        ) : (
          <ErrorState
            description="الحاقیه‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
            correlationId={result.correlationId}
          />
        )}
      </Section>
    );
  }

  const { items } = result.data;

  return (
    <Section headingId="contract-amendments" title="الحاقیه‌ها">
      {items.length === 0 ? (
        <EmptyState
          title="الحاقیه‌ای نیست"
          description="برای این قرارداد هنوز الحاقیه‌ای ثبت نشده است."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((amendment) => (
            <AmendmentRow key={amendment.id} amendment={amendment} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function MilestoneRow({ milestone }: { milestone: Milestone }) {
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{milestone.title}</span>
        <span className="text-content-muted">{formatJalaliDate(milestone.plannedDate)}</span>
      </div>
      <p className="mt-1 text-content-muted">
        {milestone.plannedShareBp !== null
          ? `سهم برنامه‌ریزی‌شده: ${formatShareBp(milestone.plannedShareBp)}`
          : 'بدون سهم برنامه‌ریزی‌شده'}
        {' · '}
        {milestone.referenced ? 'در صورت‌وضعیتی ذکر شده' : 'هنوز در هیچ صورت‌وضعیتی ذکر نشده'}
      </p>
    </li>
  );
}

/** The planned milestones, read separately and able to fail on their own. */
function MilestonesSection({ result }: { result: ReadResult<MilestonePage> }) {
  if (result.kind !== 'OK') {
    return (
      <Section headingId="contract-milestones" title="Milestoneها">
        {result.kind === 'FORBIDDEN' || result.kind === 'NOT_FOUND' ? (
          <NoAccessState description="Milestoneهای این قرارداد در اختیار شما نیست." />
        ) : (
          <ErrorState
            description="Milestoneها خوانده نشد. کمی بعد دوباره تلاش کنید."
            correlationId={result.correlationId}
          />
        )}
      </Section>
    );
  }

  const { items } = result.data;

  return (
    <Section headingId="contract-milestones" title="Milestoneها">
      {items.length === 0 ? (
        <EmptyState
          title="Milestoneای نیست"
          description="برای این قرارداد هنوز Milestoneای برنامه‌ریزی نشده است."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((milestone) => (
            <MilestoneRow key={milestone.id} milestone={milestone} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export interface ContractDetailScreenProps {
  readonly result: ReadResult<ContractDetail>;
  /** `null` when the contract itself could not be read, so these were not asked. */
  readonly amendments: ReadResult<AmendmentPage> | null;
  readonly milestones: ReadResult<MilestonePage> | null;
}

export function ContractDetailScreen({
  result,
  amendments,
  milestones,
}: ContractDetailScreenProps) {
  if (result.kind !== 'OK') return <Failure result={result} />;

  const contract = result.data;

  return (
    <div className="flex flex-col gap-6">
      <Section headingId="contract-summary" title="قرارداد">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={contract.status} label={contractStatusLabel(contract.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{contract.id}</Identifier>
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Term label="کارفرما">
            <Identifier>{contract.organizationId}</Identifier>
          </Term>
          <Term label="پیمانکار">
            <Identifier>{contract.contractorOrganizationId}</Identifier>
          </Term>
          <Term label="پروژه">
            <Identifier>{contract.projectId}</Identifier>
          </Term>
          <Term label="مناقصه">
            <Identifier>{contract.tenderId}</Identifier>
          </Term>
          <Term label="مبلغ قرارداد">{formatMoney(contract.amountMinor, IRR)}</Term>
          <Term label="جمع الحاقیه‌های اجراشده">
            {formatMoney(contract.amendmentsTotalMinor, IRR)}
          </Term>
          <Term label="مبلغ جاری">
            <span className="font-medium">{formatMoney(contract.currentAmountMinor, IRR)}</span>
          </Term>
          <Term label="واگذاری در">{formatJalaliDateLong(contract.awardedAt)}</Term>
          <Term label="ثبت در">{formatJalaliDateLong(contract.createdAt)}</Term>
          <Term label="آخرین تغییر وضعیت">{formatJalaliDateLong(contract.statusChangedAt)}</Term>
        </dl>
        {contract.status === 'CANCELLED' && contract.cancelReasonCode ? (
          <p className="mt-3 text-sm">
            دلیل لغو: {contract.cancelReasonCode}
            {contract.cancelNote ? ` — ${contract.cancelNote}` : ''}
          </p>
        ) : null}
      </Section>

      <Section headingId="contract-signatures" title="امضاها">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Term label="امضای کارفرما">{signedAtText(contract.employerSignedAt)}</Term>
          <Term label="امضای پیمانکار">{signedAtText(contract.contractorSignedAt)}</Term>
        </dl>
        {contract.authorityReviewRequired ? (
          <p className="mt-3 text-sm">
            امضای کارفرما در حال بازبینی اختیار است؛ این وضعیت خودِ قرارداد را تغییر نمی‌دهد.
          </p>
        ) : null}
      </Section>

      {amendments ? <AmendmentsSection result={amendments} /> : null}
      {milestones ? <MilestonesSection result={milestones} /> : null}
    </div>
  );
}
