import type { ReactNode } from 'react';

import { EmptyState, ErrorState, NoAccessState, Section, StatusBadge } from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import { approvalStatusLabel, workflowLabel } from '@/lib/project-commands';
import type { ProjectApproval, ReadResult } from '@/server/projects';

import { formatEstimate } from '../ProjectsScreen';

import { GrantApprovalForm, RejectApprovalForm } from './ProjectForms';
import type { ProjectPlace } from './project-runner';
import type { ProjectToken } from './ProjectCommands';

/**
 * The approval rounds of a project, in round and step order, and — on a step
 * this person is the authority of — the decision forms.
 *
 * A step is shown as the service shows it to the project's readers: who is
 * asked, in which order, what was decided and why. Whether a decision form is
 * drawn is the page's call (`mayDecide`: the step is PENDING and the person acts
 * for the authority organization with its role), and it hands over a token for
 * each; the service decides again on every send, and answers only the named
 * authority.
 */

export interface DecisionTokens {
  readonly grant: ProjectToken;
  readonly reject: ProjectToken;
}

export interface ProjectApprovalsProps {
  readonly result: ReadResult<ProjectApproval[]>;
  readonly csrfToken: string;
  /** The steps this person may decide, by approval id. */
  readonly decisions: Readonly<Record<string, DecisionTokens>>;
}

function groupByRound(steps: readonly ProjectApproval[]): ProjectApproval[][] {
  const rounds = new Map<string, ProjectApproval[]>();
  for (const step of steps) {
    const key = `${step.workflowKey}\n${step.round}`;
    rounds.set(key, [...(rounds.get(key) ?? []), step]);
  }
  return [...rounds.values()]
    .reverse()
    .map((round) => [...round].sort((a, b) => a.stepOrder - b.stepOrder));
}

export function StepRow({
  step,
  csrfToken,
  place,
  tokens,
  showProject = false,
}: {
  step: ProjectApproval;
  csrfToken: string;
  place: ProjectPlace;
  tokens: DecisionTokens | undefined;
  /** In the authority's inbox the step is the whole item, so it names its project. */
  showProject?: boolean;
}) {
  const identity = { targetId: step.id, place, csrfToken };
  return (
    <li className="rounded-md border border-border p-3">
      {showProject && step.project ? (
        <p className="mb-1 font-medium">
          پروژه: {step.project.title}
          <span className="text-sm text-content-muted">
            {' '}
            · برآورد: {formatEstimate(step.project.estimatedCostMinor)}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {showProject ? `${workflowLabel(step.workflowKey)}، ` : ''}مرحله{' '}
          {toPersianDigits(String(step.stepOrder))}: {step.approvalType}
        </span>
        <StatusBadge status={step.status} label={approvalStatusLabel(step.status)} />
      </div>
      <p className="mt-1 text-sm text-content-muted">مرجع: {step.authorityLabel}</p>
      {step.requestedAt ? (
        <p className="text-sm text-content-muted">
          درخواست: {formatJalaliDateLong(step.requestedAt)}
        </p>
      ) : null}
      {step.decidedAt ? (
        <p className="text-sm">تصمیم: {formatJalaliDateLong(step.decidedAt)}</p>
      ) : null}
      {step.decisionNumber ? <p className="text-sm">شماره تصمیم: {step.decisionNumber}</p> : null}
      {step.conditions ? <p className="text-sm">شرایط: {step.conditions}</p> : null}
      {step.reason ? <p className="text-sm">دلیل رد: {step.reason}</p> : null}
      {tokens ? (
        <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
          <p className="text-sm font-medium">این مرحله به نام شما و منتظر تصمیم شماست.</p>
          <GrantApprovalForm {...identity} {...tokens.grant} />
          <RejectApprovalForm {...identity} {...tokens.reject} />
        </div>
      ) : null}
    </li>
  );
}

export function ProjectApprovals({ result, csrfToken, decisions }: ProjectApprovalsProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="موافقت‌های این پروژه در اختیار شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="موافقتی پیدا نشد"
        description="پروژه پیدا نشد یا در سازمان فعال شما نیست."
      />
    );
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="موافقت‌های پروژه خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const rounds = groupByRound(result.data);
  if (rounds.length === 0) {
    return (
      <EmptyState
        title="هنوز موافقتی خواسته نشده"
        description="پس از درخواست موافقت، مرحله‌های سیاست فعال اینجا دیده می‌شود."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {rounds.map((round) => {
        const first = round[0];
        if (!first) return null;
        return (
          <section
            key={`${first.workflowKey}-${first.round}`}
            aria-labelledby={`round-${first.workflowKey}-${first.round}`}
            className="flex flex-col gap-2"
          >
            <h3
              id={`round-${first.workflowKey}-${first.round}`}
              className="text-base font-semibold"
            >
              {workflowLabel(first.workflowKey)}، دور {toPersianDigits(String(first.round))}
            </h3>
            <ul className="flex flex-col gap-2">
              {round.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  csrfToken={csrfToken}
                  place="project"
                  tokens={decisions[step.id]}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function ApprovalsSection({ children }: { children: ReactNode }) {
  return (
    <Section
      headingId="project-approvals"
      title="موافقت‌ها"
      description="سامانه هیچ پروژه‌ای را خودکار تایید نمی‌کند: هر مرحله را مرجع نام‌برده تصمیم می‌گیرد."
    >
      {children}
    </Section>
  );
}
