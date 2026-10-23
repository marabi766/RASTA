import { EmptyState, ErrorState, NoAccessState, Section } from '@/ui';
import type { ApprovalInbox as Inbox, ReadResult } from '@/server/projects';
import { toPersianDigits } from '@/lib/format';

import { StepRow, type DecisionTokens } from './[id]/ProjectApprovals';

/**
 * The authority's inbox (`GET /v1/approvals`): the project approval steps
 * addressed to the organization the person acts for and to one of their roles
 * there, still undecided. An authority of another organization cannot read the
 * project it is asked about — the step carries the title and estimate the
 * project's own organization chose to show it — so a decision is made here and
 * the person lands back here.
 *
 * Every item in the inbox is addressed to this person's organization and one of
 * their roles, which is the service's own rule (`inboxScope`), so a decision
 * form is drawn for each; the page hands over its tokens. Nothing is approved
 * by a timeout: an empty inbox means nothing is waiting, not that anything was
 * decided.
 */

export interface ApprovalInboxProps {
  readonly result: ReadResult<Inbox>;
  readonly csrfToken: string;
  readonly decisions: Readonly<Record<string, DecisionTokens>>;
}

export function ApprovalInbox({ result, csrfToken, decisions }: ApprovalInboxProps) {
  return (
    <Section
      headingId="approval-inbox"
      title="تصمیم‌های منتظر شما"
      description="مرحله‌هایی از موافقت پروژه‌ها که به نام سازمان فعال و نقش شما نوشته شده و هنوز تصمیم نگرفته‌اید."
    >
      <InboxBody result={result} csrfToken={csrfToken} decisions={decisions} />
    </Section>
  );
}

function InboxBody({ result, csrfToken, decisions }: ApprovalInboxProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="صندوق تصمیم‌ها برای این نقش در دسترس نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="تصمیمی منتظر نیست" description="این نشست سازمان فعالی ندارد." />;
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="صندوق تصمیم‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const { items, hasMore } = result.data;
  if (items.length === 0) {
    return (
      <EmptyState
        title="تصمیمی منتظر شما نیست"
        description="هیچ مرحله موافقتی به نام سازمان فعال و نقش شما منتظر نیست."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-content-muted">
        {toPersianDigits(String(items.length))} مرحله منتظر تصمیم{hasMore ? ' (بیشتر هم هست)' : ''}
      </p>
      <ul className="flex flex-col gap-3">
        {items.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            csrfToken={csrfToken}
            place="inbox"
            tokens={decisions[step.id]}
            showProject
          />
        ))}
      </ul>
    </div>
  );
}
