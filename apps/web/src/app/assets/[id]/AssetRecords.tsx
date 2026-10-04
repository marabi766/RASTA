import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  Section,
  StatusBadge,
} from '@/ui';
import type { ValidityWindow } from '@/lib/asset-record-fields';
import { formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import { inspectionResultLabel, policyCoverageLabel } from '@/lib/labels';
import type { ReadResult } from '@/server/assets';
import {
  validityWindowOf,
  type InspectionSummary,
  type InsurancePolicySummary,
} from '@/server/asset-records';

/**
 * The machine's insurance policies and technical inspections on `/assets/[id]`
 * (EXP-002, slice 6): what is recorded, whether each record is in force, and —
 * for the roles that may — the form to record another.
 *
 * Pure, like the dossier next to it: every state is reachable in a test.
 *
 * ## "In force" is the server's judgement
 *
 * Each record's window — not begun, open, closed — is decided here from `now`,
 * the clock of the server that drew the page, and written into the markup. This
 * component has no hooks and is never a client component, so the visitor's
 * clock cannot move a policy from expired to current (or the other way) on
 * their screen. The service's own `daysUntilExpiry` is shown beside it, so the
 * two agree by construction.
 */

export interface AssetRecordsProps {
  readonly policies: ReadResult<InsurancePolicySummary[]>;
  readonly inspections: ReadResult<InspectionSummary[]>;
  /** The server's clock when the page was drawn. */
  readonly now: Date;
  /** The form that records a policy, when this person may use it. */
  readonly policyForm?: ReactNode;
  /** The form that records an inspection, when this person may use it. */
  readonly inspectionForm?: ReactNode;
}

/**
 * Which badge a window wears, from the statuses `StatusBadge` already
 * tabulates (docs/16 § 16.5): a record in force is `ACTIVE`, one that has
 * lapsed `FAILED`, one that has not begun `PENDING`. The word is this screen's.
 */
const WINDOW_BADGE: Readonly<Record<ValidityWindow, { status: string; label: string }>> = {
  CURRENT: { status: 'ACTIVE', label: 'معتبر' },
  EXPIRED: { status: 'FAILED', label: 'منقضی' },
  FUTURE: { status: 'PENDING', label: 'هنوز آغاز نشده' },
};

/** The same tabulated statuses for an inspection's result. */
const RESULT_BADGE: Readonly<Record<string, string>> = {
  PASSED: 'APPROVED',
  CONDITIONAL: 'IN_PROGRESS',
  FAILED: 'FAILED',
};

const fa = (value: number): string => toPersianDigits(String(value));

/**
 * "N days left" / "expires today" / "N days past". The service's count is
 * positive until the instant passes, so it is read as given.
 */
function daysWording(days: number): string {
  if (days > 0) return `${fa(days)} روز مانده`;
  if (days === 0) return 'امروز منقضی می‌شود';
  return `${fa(Math.abs(days))} روز از انقضا گذشته`;
}

function Pair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-content-subtle">{term}</dt>
      <dd className="text-sm text-content">{children}</dd>
    </div>
  );
}

function Failure({
  result,
  what,
}: {
  result: Exclude<ReadResult<unknown>, { kind: 'OK' }>;
  what: string;
}) {
  switch (result.kind) {
    case 'FORBIDDEN':
      return <Alert tone="info">اجازهٔ دیدن {what} این دارایی به شما داده نشده است.</Alert>;
    case 'NOT_FOUND':
      return (
        <EmptyState
          title="این دارایی پیدا نشد"
          description="شناسه اشتباه است یا در سازمان فعال شما نیست."
        />
      );
    case 'UNAVAILABLE':
      return <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />;
    case 'MALFORMED':
      return <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />;
  }
}

function PolicyList({ policies, now }: { policies: readonly InsurancePolicySummary[]; now: Date }) {
  if (policies.length === 0) {
    return (
      <EmptyState
        title="بیمه‌نامه‌ای ثبت نشده"
        description="تا بیمه‌نامهٔ معتبر ثبت نشود، دارایی قابل فعال‌سازی و اعزام نیست."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-4" data-testid="policy-list">
      {policies.map((policy) => {
        // A cancelled policy is not in force whatever its dates say.
        const window = validityWindowOf(policy.validFrom, policy.validTo, now);
        const badge =
          policy.status === 'CANCELLED'
            ? { status: 'CANCELLED', label: 'لغوشده' }
            : WINDOW_BADGE[window];
        return (
          <li
            key={policy.id}
            data-policy-number={policy.policyNumber}
            data-window={window}
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={badge.status} label={badge.label} />
              <span className="font-medium text-content">{policy.insurerName}</span>
              <Identifier>{policy.policyNumber}</Identifier>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Pair term="پوشش">{policyCoverageLabel(policy.coverage)}</Pair>
              <Pair term="اعتبار">
                {formatJalaliDateLong(policy.validFrom)} تا {formatJalaliDateLong(policy.validTo)}
                {window === 'CURRENT' ? (
                  <span className="block text-content-muted">
                    {daysWording(policy.daysUntilExpiry)}
                  </span>
                ) : null}
              </Pair>
              {policy.premiumMinor !== null ? (
                <Pair term="حق بیمه">{formatMoney(policy.premiumMinor)}</Pair>
              ) : null}
              {policy.insuredValueMinor !== null ? (
                <Pair term="سرمایهٔ بیمه">{formatMoney(policy.insuredValueMinor)}</Pair>
              ) : null}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function InspectionList({
  inspections,
  now,
}: {
  inspections: readonly InspectionSummary[];
  now: Date;
}) {
  if (inspections.length === 0) {
    return (
      <EmptyState
        title="معاینهٔ فنی‌ای ثبت نشده"
        description="گواهی معاینهٔ فنی را ثبت کنید تا اعتبار آن زیر نظر باشد."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-4" data-testid="inspection-list">
      {inspections.map((inspection) => {
        const window = validityWindowOf(inspection.inspectedAt, inspection.validTo, now);
        const wear = WINDOW_BADGE[window];
        return (
          <li
            key={inspection.id}
            data-certificate-no={inspection.certificateNo}
            data-window={window}
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                status={RESULT_BADGE[inspection.result] ?? inspection.result}
                label={inspectionResultLabel(inspection.result)}
              />
              <StatusBadge status={wear.status} label={wear.label} />
              <Identifier>{inspection.certificateNo}</Identifier>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Pair term="تاریخ معاینه">{formatJalaliDateLong(inspection.inspectedAt)}</Pair>
              <Pair term="معاینهٔ بعدی تا">
                {formatJalaliDateLong(inspection.validTo)}
                {window === 'CURRENT' ? (
                  <span className="block text-content-muted">
                    {daysWording(inspection.daysUntilExpiry)}
                  </span>
                ) : null}
              </Pair>
              {inspection.centerName ? (
                <Pair term="مرکز معاینه">{inspection.centerName}</Pair>
              ) : null}
              {inspection.notes ? (
                <Pair term="یادداشت">
                  <IsolatedText>{inspection.notes}</IsolatedText>
                </Pair>
              ) : null}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

export function AssetRecords({
  policies,
  inspections,
  now,
  policyForm,
  inspectionForm,
}: AssetRecordsProps) {
  return (
    <>
      <Section
        headingId="policies"
        title="بیمه‌نامه‌ها"
        description="اعتبار هر بیمه‌نامه بر پایهٔ ساعت سرور هنگام نمایش صفحه سنجیده می‌شود."
      >
        {policies.kind === 'OK' ? (
          <PolicyList policies={policies.data} now={now} />
        ) : (
          <Failure result={policies} what="بیمه‌نامه‌های" />
        )}
        {policyForm}
      </Section>

      <Section
        headingId="inspections"
        title="معاینهٔ فنی"
        description="اعتبار هر گواهی بر پایهٔ ساعت سرور هنگام نمایش صفحه سنجیده می‌شود."
      >
        {inspections.kind === 'OK' ? (
          <InspectionList inspections={inspections.data} now={now} />
        ) : (
          <Failure result={inspections} what="معاینه‌های فنی" />
        )}
        {inspectionForm}
      </Section>
    </>
  );
}
