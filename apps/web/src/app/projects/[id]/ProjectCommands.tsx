import type { ReactNode } from 'react';

import { Alert, Section } from '@/ui';
import {
  POLICY_CLOSED_TEXT,
  POLICY_CLOSED_TITLE,
  POLICY_UNKNOWN_TEXT,
  PROJECT_COMMAND_LABELS,
  type ProjectCommand,
  type ProjectFormValues,
} from '@/lib/project-commands';
import type { ExecutionPolicy, ReadResult } from '@/server/projects';

import {
  CancelProjectForm,
  CompleteProjectForm,
  EditProjectForm,
  RequestApprovalForm,
  StartProjectForm,
  type ProjectFormIdentity,
} from './ProjectForms';

/**
 * What the page offers to do to a project: edit it, ask for approval, start it,
 * complete it, cancel it.
 *
 * The page decides **which** commands to offer — the ones the project's status
 * allows, to a person whose token holds a project-writing role
 * (`offeredCommands`) — and signs a baseline for each (`sealProjectBaseline`);
 * this renders exactly the ones it was given a token for. So there is no status
 * or role logic here to drift from the page's, and a command with no token
 * cannot be drawn. The service decides again on every send and refuses a person
 * without the role in fixed words.
 */

export interface ProjectToken {
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this project and its version. */
  readonly baseline: string;
}

export interface ProjectCommandsProps {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly csrfToken: string;
  readonly tokens: Readonly<Partial<Record<ProjectCommand, ProjectToken>>>;
  /** The project's current record as the edit form's text. */
  readonly initialValues: ProjectFormValues;
}

function Block({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold text-content">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The system is closed: said as a state of the organization, with what to do and who does it. */
export function PolicyState({ policy }: { policy: ReadResult<ExecutionPolicy> }) {
  if (policy.kind === 'OK' && policy.data.kind === 'CLOSED') {
    return (
      <Alert tone="warning" title={POLICY_CLOSED_TITLE}>
        {POLICY_CLOSED_TEXT}
      </Alert>
    );
  }
  if (policy.kind === 'OK' && policy.data.kind === 'OPEN') {
    const { label, isSample, steps } = policy.data;
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          سیاست موافقت اجرا: <strong>{label}</strong>
          {isSample ? ' (نمونه)' : ''}
        </p>
        {steps.length > 0 ? (
          <ol className="list-decimal ps-6 text-content-muted">
            {steps.map((step, index) => (
              <li key={`${index}-${step.approvalType}`}>
                {step.approvalType}، مرجع: {step.authorityLabel}
              </li>
            ))}
          </ol>
        ) : null}
        <p className="text-content-muted">
          مرحله‌هایی که به برآورد این پروژه می‌خورد در درخواست موافقت کپی می‌شود.
        </p>
      </div>
    );
  }
  return <Alert tone="info">{POLICY_UNKNOWN_TEXT}</Alert>;
}

export function ProjectCommands({
  projectId,
  projectTitle,
  csrfToken,
  tokens,
  initialValues,
}: ProjectCommandsProps) {
  const identity = (command: ProjectCommand): ProjectFormIdentity | null => {
    const token = tokens[command];
    if (!token) return null;
    return { targetId: projectId, place: 'project', csrfToken, ...token };
  };

  const edit = identity('edit');
  const request = identity('requestApproval');
  const start = identity('start');
  const complete = identity('complete');
  const cancel = identity('cancel');

  return (
    <div className="flex flex-col gap-8">
      {edit ? (
        <Block headingId="project-edit" title={PROJECT_COMMAND_LABELS.edit}>
          <EditProjectForm {...edit} initialValues={initialValues} />
        </Block>
      ) : null}

      {request ? (
        <Block headingId="project-request" title={PROJECT_COMMAND_LABELS.requestApproval}>
          <RequestApprovalForm {...request} />
        </Block>
      ) : null}

      {start ? (
        <Block headingId="project-start" title={PROJECT_COMMAND_LABELS.start}>
          <StartProjectForm {...start} />
        </Block>
      ) : null}

      {complete ? (
        <Block headingId="project-complete" title={PROJECT_COMMAND_LABELS.complete}>
          <CompleteProjectForm {...complete} />
        </Block>
      ) : null}

      {cancel ? (
        <Block headingId="project-cancel" title={PROJECT_COMMAND_LABELS.cancel}>
          <CancelProjectForm {...cancel} projectTitle={projectTitle} />
        </Block>
      ) : null}
    </div>
  );
}

export function ProjectCommandsSection({ children }: { children: ReactNode }) {
  return (
    <Section
      headingId="project-commands"
      title="اقدام‌ها"
      description="اقدام‌های این پروژه در وضعیت کنونی آن. سرویس پروژه‌ها در هر ارسال دوباره تصمیم می‌گیرد."
    >
      {children}
    </Section>
  );
}
