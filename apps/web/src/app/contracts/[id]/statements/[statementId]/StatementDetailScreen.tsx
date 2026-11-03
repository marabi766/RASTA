import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
  TableScroll,
} from '@/ui';
import { DemoModeNotice, MoneyActionWithheld } from '@/app/DemoModeNotice';
import { MONEY_EFFECTS, mayOffer, type DemoMode } from '@/lib/demo-mode';
import { formatShareBp } from '@/lib/contract-fields';
import { IRR, formatJalaliDateTime, formatMoney, toPersianDigits } from '@/lib/format';
import { roleLabel } from '@/lib/organization-fields';
import {
  STATEMENT_CHAIN_LABELS,
  STEP_OUTCOME_LABELS,
  statementStatusLabel,
  type StatementChain,
  type StatementCommand,
} from '@/lib/statement-fields';
import type { Binding } from '@/lib/unresolved-order';
import type { ReadResult } from '@/server/assets';
import type { Statement, StatementStep } from '@/server/contract-statements';

import { StatementCommands, type OfferedStatementCommand } from '../../StatementCommands';

/**
 * One statement (`/contracts/[id]/statements/[statementId]`), and the forms
 * this viewer may use on it.
 *
 * Every outcome is fixed Persian text. Another organization's statement, and
 * one that does not exist, both answer `404` and read the same here (S-03).
 * Money is shown exactly as contract-service computed it — gross, each
 * deduction, net, as decimal strings formatted, never added here.
 *
 * Each step of both chains shows its authority (the organization, the role and
 * the label the employer's policy gave it), its decision and when. **Not who
 * decided**: the statement view never names a person (contract-service
 * `statementViewSchema`: "never by which person"), so neither does this page.
 */

const NOT_FOUND_TITLE = 'این صورت‌وضعیت پیدا نشد';
const NOT_FOUND_DESCRIPTION = 'شناسه اشتباه است یا این صورت‌وضعیت برای شما در دسترس نیست.';

/** The confirmation a redirect carried, by the command that earned it. */
const NOTICE_MESSAGES: Readonly<Record<StatementCommand, string>> = {
  DRAFT: 'پیش‌نویس صورت‌وضعیت ثبت شد.',
  SUBMIT: 'صورت‌وضعیت برای تأیید ارسال شد و زنجیره‌های تأیید آن ثبت شد.',
  APPROVE: 'تأیید این مرحله ثبت شد.',
  REJECT: 'صورت‌وضعیت رد شد.',
};

function Failure({ result }: { result: Exclude<ReadResult<unknown>, { kind: 'OK' }> }) {
  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title={NOT_FOUND_TITLE} description={NOT_FOUND_DESCRIPTION} />;
  }
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این صورت‌وضعیت در اختیار شما نیست." />;
  }
  return (
    <ErrorState
      description="صورت‌وضعیت خوانده نشد. کمی بعد دوباره تلاش کنید."
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

function Lines({ statement }: { statement: Statement }) {
  return (
    <TableScroll label="ردیف‌های صورت‌وضعیت">
      <table className="w-full text-sm">
        <caption className="sr-only">ردیف‌های صورت‌وضعیت</caption>
        <thead>
          <tr className="text-content-muted">
            <th scope="col" className="py-2 text-start font-normal">
              ردیف
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              شرح کار
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              Milestone
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              مبلغ
            </th>
          </tr>
        </thead>
        <tbody>
          {statement.lines.map((line) => (
            <tr key={line.lineNumber} className="border-t border-border">
              <td className="py-2">{toPersianDigits(String(line.lineNumber))}</td>
              <td className="py-2">{line.description}</td>
              <td className="py-2">
                {line.milestoneId ? <Identifier>{line.milestoneId}</Identifier> : '—'}
              </td>
              <td className="py-2">{formatMoney(line.amountMinor, IRR)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong font-medium">
            <th scope="row" colSpan={3} className="py-2 text-start">
              مبلغ ناخالص
            </th>
            <td className="py-2">{formatMoney(statement.grossMinor, IRR)}</td>
          </tr>
        </tfoot>
      </table>
    </TableScroll>
  );
}

function Deductions({ statement }: { statement: Statement }) {
  if (statement.deductions.length === 0) {
    return <p className="text-sm text-content-muted">کسری بر این صورت‌وضعیت اعمال نشده است.</p>;
  }
  return (
    <TableScroll label="کسورات صورت‌وضعیت">
      <table className="w-full text-sm">
        <caption className="sr-only">کسورات صورت‌وضعیت</caption>
        <thead>
          <tr className="text-content-muted">
            <th scope="col" className="py-2 text-start font-normal">
              کسر
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              نرخ (از مبلغ ناخالص)
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              مبلغ
            </th>
          </tr>
        </thead>
        <tbody>
          {statement.deductions.map((deduction) => (
            <tr key={deduction.deductionRuleId} className="border-t border-border">
              <td className="py-2">{deduction.name}</td>
              <td className="py-2">{formatShareBp(deduction.rateBp)}</td>
              <td className="py-2">{formatMoney(deduction.amountMinor, IRR)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong font-medium">
            <th scope="row" colSpan={2} className="py-2 text-start">
              جمع کسورات
            </th>
            <td className="py-2">{formatMoney(statement.deductionsMinor, IRR)}</td>
          </tr>
        </tfoot>
      </table>
    </TableScroll>
  );
}

function StepRow({ step }: { step: StatementStep }) {
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          مرحلهٔ {toPersianDigits(String(step.stepOrder))}: {step.authorityLabel}
        </span>
        {step.decision ? (
          <StatusBadge
            status={step.decision.outcome}
            label={STEP_OUTCOME_LABELS[step.decision.outcome]}
          />
        ) : (
          <StatusBadge status="PENDING_APPROVAL" label="در انتظار تصمیم" />
        )}
      </div>
      <p className="mt-1 text-content-muted">
        مرجع: <Identifier>{step.authorityOrganizationId}</Identifier> — نقش{' '}
        {roleLabel(step.authorityRole)}
      </p>
      <p className="mt-1 text-content-muted">
        {step.decision
          ? `زمان تصمیم: ${formatJalaliDateTime(step.decision.decidedAt)}`
          : 'هنوز تصمیمی ثبت نشده است.'}
      </p>
    </li>
  );
}

function Chain({
  chain,
  steps,
  policyVersion,
}: {
  chain: StatementChain;
  steps: readonly StatementStep[];
  policyVersion: number;
}) {
  const headingId = `statement-chain-${chain.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-base font-medium">
        {STATEMENT_CHAIN_LABELS[chain]}
      </h3>
      <p className="text-sm text-content-muted">
        بر پایهٔ نسخهٔ {toPersianDigits(String(policyVersion))} سیاست کارفرما، همان‌طور که هنگام
        ارسال ثبت شد.
      </p>
      <ol className="flex flex-col gap-2">
        {[...steps]
          .sort((a, b) => a.stepOrder - b.stepOrder)
          .map((step) => (
            <StepRow key={step.stepOrder} step={step} />
          ))}
      </ol>
    </section>
  );
}

export interface StatementDetailScreenProps {
  readonly result: ReadResult<Statement>;
  /** The contract could not be read for an outage — not a refusal — so no submit form could be offered. */
  readonly contractUnavailable: boolean;
  readonly offered: readonly OfferedStatementCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** A command this session confirmed just now (`server/flash.ts`), if any. */
  readonly notice?: StatementCommand;
  readonly pageHref: string;
  /** What the provider says (`fetchDemoMode`, Q-14): «حالت نمایشی», nothing, or that it is unknown. */
  readonly demoMode: DemoMode;
}

export function StatementDetailScreen({
  result,
  contractUnavailable,
  offered,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  notice,
  pageHref,
  demoMode,
}: StatementDetailScreenProps) {
  if (result.kind !== 'OK') return <Failure result={result} />;
  const statement = result.data;
  // Withheld while the provider is unknown only if it moves money (Q-14). None of these does:
  // even the last approval only records the obligation that a separate settlement pays.
  const shown = offered.filter(({ command }) =>
    mayOffer(demoMode, MONEY_EFFECTS.statement[command]),
  );
  const withheld = shown.length < offered.length;

  return (
    <div className="flex flex-col gap-6">
      <DemoModeNotice mode={demoMode} />
      {notice ? <Alert tone="success">{NOTICE_MESSAGES[notice]}</Alert> : null}

      <Section
        headingId="statement-summary"
        title={`صورت‌وضعیت شمارهٔ ${toPersianDigits(String(statement.statementNumber))}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={statement.status} label={statementStatusLabel(statement.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{statement.id}</Identifier>
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Term label="مبلغ ناخالص">{formatMoney(statement.grossMinor, IRR)}</Term>
          <Term label="کسورات">{formatMoney(statement.deductionsMinor, IRR)}</Term>
          <Term label="مبلغ خالص">
            <span className="font-medium">{formatMoney(statement.netMinor, IRR)}</span>
          </Term>
          <Term label="قرارداد">
            <Identifier>{statement.contractId}</Identifier>
          </Term>
          <Term label="کارفرما">
            <Identifier>{statement.organizationId}</Identifier>
          </Term>
          <Term label="پیمانکار">
            <Identifier>{statement.contractorOrganizationId}</Identifier>
          </Term>
          <Term label="ثبت پیش‌نویس">{formatJalaliDateTime(statement.createdAt)}</Term>
          <Term label="ارسال">
            {statement.submittedAt
              ? formatJalaliDateTime(statement.submittedAt)
              : 'هنوز ارسال نشده'}
          </Term>
          <Term label="آخرین تغییر">{formatJalaliDateTime(statement.updatedAt)}</Term>
        </dl>
      </Section>

      <Section headingId="statement-lines" title="ردیف‌ها">
        <Lines statement={statement} />
      </Section>

      <Section headingId="statement-deductions" title="کسورات">
        <Deductions statement={statement} />
      </Section>

      <Section headingId="statement-chains" title="زنجیره‌های تأیید">
        {statement.approvalChains ? (
          <div className="flex flex-col gap-6">
            <Chain
              chain="TECHNICAL"
              steps={statement.approvalChains.technical.steps}
              policyVersion={statement.approvalChains.technical.policyVersion}
            />
            <Chain
              chain="FINANCIAL"
              steps={statement.approvalChains.financial.steps}
              policyVersion={statement.approvalChains.financial.policyVersion}
            />
            <p className="text-sm text-content-muted">
              هر مرحله را مرجعی که سیاست کارفرما نام برده بررسی می‌کند؛ این صفحه نام شخص
              تصمیم‌گیرنده را نشان نمی‌دهد، چون سامانه آن را در اختیار خوانندگان صورت‌وضعیت
              نمی‌گذارد.
            </p>
          </div>
        ) : (
          <p className="text-sm text-content-muted">
            زنجیره‌های تأیید هنگام ارسال صورت‌وضعیت، از سیاست‌های برقرار کارفرما، ثبت می‌شوند.
          </p>
        )}
      </Section>

      {contractUnavailable ? (
        <Alert tone="warning">
          جزئیات قرارداد این صورت‌وضعیت همین حالا خوانده نشد؛ تا خوانده نشود، فرم ارسال صورت‌وضعیت
          عرضه نمی‌شود. کمی بعد صفحه را تازه کنید.
        </Alert>
      ) : null}

      {withheld ? (
        <MoneyActionWithheld title="اقدام‌های مالی این صورت‌وضعیت اکنون در دسترس نیست" />
      ) : null}

      <StatementCommands
        contractId={statement.contractId}
        statementId={statement.id}
        offered={shown}
        csrfToken={csrfToken}
        binding={binding}
        sessionMaxAgeSeconds={sessionMaxAgeSeconds}
        pageHref={pageHref}
      />
    </div>
  );
}
