import type { ReactNode } from 'react';

import {
  Alert,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { DemoModeNotice } from '@/app/DemoModeNotice';
import type { DemoMode } from '@/lib/demo-mode';
import {
  IRR,
  formatJalaliDate,
  formatJalaliDateLong,
  formatMoney,
  toPersianDigits,
} from '@/lib/format';
import {
  CONTRACT_COMMAND_DONE,
  amendmentReasonLabel,
  cancelReasonLabel,
  type ContractCommand,
} from '@/lib/contract-command-fields';
import { amendmentStatusLabel, contractStatusLabel, formatShareBp } from '@/lib/contract-fields';
import { statementStatusLabel } from '@/lib/statement-fields';
import type { Binding } from '@/lib/unresolved-order';
import type { Statement, StatementPage } from '@/server/contract-statements';
import type {
  Amendment,
  AmendmentPage,
  ContractDetail,
  Milestone,
  MilestonePage,
  ReadResult,
} from '@/server/contracts';

import { ContractCommands } from './ContractCommands';
import { amendmentLabel, type ContractCommandOffers } from './contract-offers';
import { StatementCommands, type OfferedStatementCommand } from './StatementCommands';
import type { MilestoneOption } from './StatementCommandForm';
import { contextHref } from '@/lib/page-context';

/**
 * The contract detail (docs/16 § ۱۶٫۶, `/contracts/[id]`).
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
 * The contract's own commands are drawn where they act — signing and
 * cancelling under the signatures, proposing and signing amendments with the
 * amendments, planning and changing milestones with the milestones — each only
 * where `server/contract-commands.ts` says contract-service would accept the
 * caller (`contract-offers.ts`), each slot drawn even when it offers nothing so
 * a command whose outcome is unknown is shown where it was sent. The
 * contract's **statements** are listed below them, read like the amendments,
 * each linking to its own page (`statements/[statementId]`); the contractor's
 * draft form is drawn under the list when `server/contract-statements.ts` says
 * contract-service would accept it (`canDraftStatement`).
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

function AmendmentRow({
  amendment,
  commands,
}: {
  amendment: Amendment;
  commands: ContractCommandOffers | null;
}) {
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{amendmentLabel(amendment)}</span>
        <StatusBadge status={amendment.status} label={amendmentStatusLabel(amendment.status)} />
      </div>
      <p className="mt-1">
        مبلغ: <span className="font-medium">{formatMoney(amendment.deltaMinor, IRR)}</span>
      </p>
      <p className="mt-1 text-content-muted">دلیل: {amendmentReasonLabel(amendment.reasonCode)}</p>
      <p className="mt-1 text-content-muted">{amendment.reasonText}</p>
      <p className="mt-1 text-content-muted">
        امضای کارفرما: {signedAtText(amendment.employerSignedAt)} · امضای پیمانکار:{' '}
        {signedAtText(amendment.contractorSignedAt)}
      </p>
      {amendment.authorityReviewRequired ? (
        <p className="mt-1 text-content-muted">این امضا در حال بازبینی اختیار است.</p>
      ) : null}
      {commands ? (
        <div className="mt-3">
          <ContractCommands
            contractId={amendment.contractId}
            slot="AMENDMENT"
            subjectId={amendment.id}
            subjectLabel={amendmentLabel(amendment)}
            offered={commands.amendments[amendment.id] ?? []}
            context={commands.context}
          />
        </div>
      ) : null}
    </li>
  );
}

/** The amendments, read separately and able to fail on their own, paged by `amendmentCursor`. */
function AmendmentsSection({
  context,
  contractId,
  result,
  commands,
}: {
  context: string;
  contractId: string;
  result: ReadResult<AmendmentPage>;
  commands: ContractCommandOffers | null;
}) {
  const propose = commands ? (
    <div className="mt-4">
      <ContractCommands
        contractId={contractId}
        slot="NEW_AMENDMENT"
        subjectId={null}
        offered={commands.newAmendment}
        context={commands.context}
      />
    </div>
  ) : null;

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
        {propose}
      </Section>
    );
  }

  const { items, nextCursor } = result.data;

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
            <AmendmentRow key={amendment.id} amendment={amendment} commands={commands} />
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="mt-4">
          <ButtonLink
            href={contextHref(context, `/contracts/${encodeURIComponent(contractId)}`, {
              amendmentCursor: nextCursor,
            })}
            tone="secondary"
          >
            صفحهٔ بعدِ الحاقیه‌ها
          </ButtonLink>
        </div>
      ) : null}
      {propose}
    </Section>
  );
}

function MilestoneRow({
  milestone,
  commands,
}: {
  milestone: Milestone;
  commands: ContractCommandOffers | null;
}) {
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
      {commands ? (
        <div className="mt-3">
          <ContractCommands
            contractId={milestone.contractId}
            slot="MILESTONE"
            subjectId={milestone.id}
            subjectLabel={milestone.title}
            offered={commands.milestones[milestone.id] ?? []}
            context={commands.context}
            collapsedLabel={`ویرایش «${milestone.title}»`}
          />
        </div>
      ) : null}
    </li>
  );
}

/** The planned milestones, read separately and able to fail on their own. */
function MilestonesSection({
  contractId,
  result,
  commands,
}: {
  contractId: string;
  result: ReadResult<MilestonePage>;
  commands: ContractCommandOffers | null;
}) {
  const plan = commands ? (
    <div className="mt-4">
      <ContractCommands
        contractId={contractId}
        slot="NEW_MILESTONE"
        subjectId={null}
        offered={commands.newMilestone}
        context={commands.context}
      />
    </div>
  ) : null;

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
        {plan}
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
            <MilestoneRow key={milestone.id} milestone={milestone} commands={commands} />
          ))}
        </ul>
      )}
      {plan}
    </Section>
  );
}

function StatementRow({ contractId, statement }: { contractId: string; statement: Statement }) {
  const number = toPersianDigits(String(statement.statementNumber));
  return (
    <li className="rounded-md border border-border bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <a
          href={`/contracts/${encodeURIComponent(contractId)}/statements/${encodeURIComponent(statement.id)}`}
          className="font-medium underline"
        >
          صورت‌وضعیت شمارهٔ {number}
        </a>
        <StatusBadge status={statement.status} label={statementStatusLabel(statement.status)} />
      </div>
      <dl className="mt-2 grid gap-2 sm:grid-cols-3">
        <Term label="مبلغ ناخالص">{formatMoney(statement.grossMinor, IRR)}</Term>
        <Term label="کسورات">{formatMoney(statement.deductionsMinor, IRR)}</Term>
        <Term label="مبلغ خالص">
          <span className="font-medium">{formatMoney(statement.netMinor, IRR)}</span>
        </Term>
      </dl>
      <p className="mt-1 text-content-muted">
        {statement.submittedAt
          ? `ارسال در ${formatJalaliDateLong(statement.submittedAt)}`
          : 'هنوز ارسال نشده'}
      </p>
    </li>
  );
}

/** What the draft form needs, when the page offers it. */
export interface StatementDraftOffer {
  readonly offered: readonly OfferedStatementCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  readonly milestones: readonly MilestoneOption[];
}

/** The statements, read separately and able to fail on their own, paged by `statementCursor`. */
function StatementsSection({
  context,
  contractId,
  result,
  draft,
}: {
  context: string;
  contractId: string;
  result: ReadResult<StatementPage>;
  draft: StatementDraftOffer | null;
}) {
  const form = draft ? (
    <div className="mt-4">
      <StatementCommands
        contractId={contractId}
        statementId={null}
        offered={draft.offered}
        csrfToken={draft.csrfToken}
        binding={draft.binding}
        sessionMaxAgeSeconds={draft.sessionMaxAgeSeconds}
        milestones={draft.milestones}
        pageHref={`/contracts/${encodeURIComponent(contractId)}`}
      />
    </div>
  ) : null;

  if (result.kind !== 'OK') {
    return (
      <Section headingId="contract-statements" title="صورت‌وضعیت‌ها">
        {result.kind === 'FORBIDDEN' || result.kind === 'NOT_FOUND' ? (
          <NoAccessState description="صورت‌وضعیت‌های این قرارداد در اختیار شما نیست." />
        ) : (
          <ErrorState
            description="صورت‌وضعیت‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
            correlationId={result.correlationId}
          />
        )}
        {form}
      </Section>
    );
  }

  const { items, nextCursor } = result.data;

  return (
    <Section headingId="contract-statements" title="صورت‌وضعیت‌ها">
      {items.length === 0 ? (
        <EmptyState
          title="صورت‌وضعیتی نیست"
          description="برای این قرارداد هنوز صورت‌وضعیتی ثبت نشده است."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((statement) => (
            <StatementRow key={statement.id} contractId={contractId} statement={statement} />
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="mt-4">
          <ButtonLink
            href={contextHref(context, `/contracts/${encodeURIComponent(contractId)}`, {
              statementCursor: nextCursor,
            })}
            tone="secondary"
          >
            صفحهٔ بعدِ صورت‌وضعیت‌ها
          </ButtonLink>
        </div>
      ) : null}
      {form}
    </Section>
  );
}

export interface ContractDetailScreenProps {
  /** The organization tag this page's URLs carry (`server/page-context.ts`). */
  readonly context: string;
  readonly result: ReadResult<ContractDetail>;
  /** `null` when the contract itself could not be read, so these were not asked. */
  readonly amendments: ReadResult<AmendmentPage> | null;
  readonly milestones: ReadResult<MilestonePage> | null;
  readonly statements?: ReadResult<StatementPage> | null;
  /** The contractor's draft form, when contract-service would accept it; null otherwise. */
  readonly draft?: StatementDraftOffer | null;
  /** The contract's own command forms (`contract-offers.ts`); null when none can be drawn. */
  readonly commands?: ContractCommandOffers | null;
  /** A command this session confirmed just now (`server/flash.ts`), if any. */
  readonly notice?: ContractCommand | null;
  /** What the provider says (`fetchDemoMode`, Q-14): «حالت نمایشی», nothing, or that it is unknown. */
  readonly demoMode: DemoMode;
}

const SIGNING_NOTES: Readonly<Record<'NO_POLICY' | 'UNREAD' | 'INCOMPLETE', string>> = {
  NO_POLICY:
    'برای کارفرما سیاست امضای برقراری نیست؛ تا وقتی سیاستی برقرار نشود، هیچ‌کس از سوی کارفرما امضا نمی‌کند. سامانه هرگز پیش‌فرض اختیار نمی‌دهد.',
  UNREAD:
    'سیاست امضای کارفرما خوانده نشد، پس فرم امضا عرضه نمی‌شود. کمی بعد صفحه را دوباره باز کنید.',
  INCOMPLETE:
    'فهرست سیاست‌های امضای این سازمان کامل خوانده نشد، پس معلوم نیست چه کسی از سوی کارفرما امضا می‌کند و فرم امضا عرضه نمی‌شود.',
};

export function ContractDetailScreen({
  context,
  result,
  amendments,
  milestones,
  statements = null,
  draft = null,
  commands = null,
  notice = null,
  demoMode,
}: ContractDetailScreenProps) {
  if (result.kind !== 'OK') return <Failure result={result} />;

  const contract = result.data;

  return (
    <div className="flex flex-col gap-6">
      <DemoModeNotice mode={demoMode} />
      {notice ? <Alert tone="success">{CONTRACT_COMMAND_DONE[notice]}</Alert> : null}
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
            دلیل لغو: {cancelReasonLabel(contract.cancelReasonCode)}
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
        {commands?.signingNote ? (
          <div className="mt-3">
            <Alert tone="info">{SIGNING_NOTES[commands.signingNote]}</Alert>
          </div>
        ) : null}
        {commands ? (
          <div className="mt-4">
            <ContractCommands
              contractId={contract.id}
              slot="CONTRACT"
              subjectId={null}
              offered={commands.contract}
              context={commands.context}
            />
          </div>
        ) : null}
      </Section>

      {amendments ? (
        <AmendmentsSection
          context={context}
          contractId={contract.id}
          result={amendments}
          commands={commands}
        />
      ) : null}
      {milestones ? (
        <MilestonesSection contractId={contract.id} result={milestones} commands={commands} />
      ) : null}
      {statements ? (
        <StatementsSection
          context={context}
          contractId={contract.id}
          result={statements}
          draft={draft}
        />
      ) : null}
    </div>
  );
}
