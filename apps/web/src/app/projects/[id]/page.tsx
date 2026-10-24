import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, EmptyState, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import {
  PROJECT_NOTICES,
  normalizeProjectValues,
  type ProjectCommand,
  type ProjectFormValues,
} from '@/lib/project-commands';
import {
  NEED_NOTICES,
  normalizeNeedValues,
  type NeedCommand,
  type NeedFormValues,
} from '@/lib/project-need-commands';
import { currentSession } from '@/server/current-session';
import { readFlash } from '@/server/flash';
import {
  canWriteProjects,
  editDigests,
  mayDecide,
  offeredCommands,
  sealProjectBaseline,
  type ProjectBaseline,
} from '@/server/project-commands';
import {
  mayAddNeed,
  mintNeedSubmission,
  needCreateScope,
  needEditDigests,
  offeredNeedCommands,
  sealNeedBaseline,
} from '@/server/project-need-commands';
import { webServerEnv } from '@/server/env';
import { tokenWriteRoles } from '@/server/realm-roles';
import {
  fetchExecutionPolicy,
  fetchProject,
  fetchProjectApprovals,
  fetchProjectNeeds,
  type ProjectApproval,
  type ProjectDetail,
  type ProjectNeed,
} from '@/server/projects';
import { readUnresolved, releaseToken } from '@/server/unresolved-request';
import type { WebSession } from '@/server/session';
import { mintSubmissionId } from '@/server/submission';
import { fetchDemoMode } from '@/server/demo-mode';
import { PortalSidebar } from '@/app/PortalSidebar';

import { NeedsSection, type AddNeedSlot, type NeedTokens } from './NeedsSection';
import { ApprovalsSection, ProjectApprovals, type DecisionTokens } from './ProjectApprovals';
import {
  PolicyState,
  ProjectCommands,
  ProjectCommandsSection,
  type ProjectToken,
} from './ProjectCommands';
import { ProjectDetailScreen } from './ProjectDetailScreen';

/**
 * The `/projects/[id]` route — جزئیات پروژه (docs/16 § ۱۶٫۶).
 *
 * **No role check decides anything here.** Whether this caller may see or change
 * the project is construction-service's answer, against the record: another
 * organization's project is `404` and is rendered as absent. Which commands are
 * *drawn* is the project's status (`commandsFrom`), for a person whose token holds
 * a project-writing role (`canWriteProjects`, the mirror of the service's
 * configuration) and, for an authority's decision, the step's own authority
 * (`mayDecide`) — the service answers no list of what a caller may do, and refuses
 * again on every send.
 */
export const dynamic = 'force-dynamic';

/** The project's current record as the edit form's text — the one source for what it shows and what it signs. */
function editValuesOf(project: ProjectDetail): ProjectFormValues {
  return normalizeProjectValues({
    title: project.title,
    operationType: project.operationType,
    locationDescription: project.locationDescription,
    scopeOfWork: project.scopeOfWork,
    estimatedCost: project.estimatedCostMinor ?? '',
  });
}

function projectTokens(
  session: WebSession,
  project: ProjectDetail & { version: number },
  offered: readonly ProjectCommand[],
  initialValues: ProjectFormValues,
): Partial<Record<ProjectCommand, ProjectToken>> {
  return Object.fromEntries(
    offered.map((command) => {
      const baseline: ProjectBaseline = {
        targetId: project.id,
        projectId: project.id,
        command,
        version: project.version,
        status: project.status,
        digests: command === 'edit' ? editDigests(initialValues) : null,
      };
      return [
        command,
        {
          submissionId: mintSubmissionId(session),
          baseline: sealProjectBaseline(session, baseline),
        },
      ];
    }),
  );
}

function decisionTokens(
  session: WebSession,
  projectId: string,
  steps: readonly ProjectApproval[],
): Record<string, DecisionTokens> {
  const tokens: Record<string, DecisionTokens> = {};
  for (const step of steps) {
    if (!mayDecide(session.accessToken, step)) continue;
    const token = (command: 'grant' | 'reject'): ProjectToken => ({
      submissionId: mintSubmissionId(session),
      baseline: sealProjectBaseline(session, {
        targetId: step.id,
        projectId,
        command,
        version: step.version,
        status: step.status,
        digests: null,
      }),
    });
    tokens[step.id] = { grant: token('grant'), reject: token('reject') };
  }
  return tokens;
}

/** A need's record as the edit form's text — the one source for what it shows and what it signs. */
function needEditValuesOf(need: ProjectNeed): NeedFormValues {
  return normalizeNeedValues({
    title: need.title,
    description: need.description,
    quantity: need.quantity ?? '',
    unit: need.unit ?? '',
    estimatedCost: need.estimatedCostMinor ?? '',
  });
}

/** For each need the commands its status and its project's offer, each with a baseline signed for it. */
function needTokens(
  session: WebSession,
  project: ProjectDetail,
  needs: readonly ProjectNeed[],
  editValues: Readonly<Record<string, NeedFormValues>>,
  canWrite: boolean,
): NeedTokens {
  const tokens: Record<
    string,
    Partial<Record<NeedCommand, { submissionId: string; baseline: string }>>
  > = {};
  for (const need of needs) {
    const offered = offeredNeedCommands({
      projectStatus: project.status,
      needStatus: need.status,
      canWrite,
    });
    const own: Partial<Record<NeedCommand, { submissionId: string; baseline: string }>> = {};
    for (const command of offered) {
      const values = editValues[need.id];
      own[command] = {
        submissionId: mintSubmissionId(session),
        baseline: sealNeedBaseline(session, {
          needId: need.id,
          projectId: project.id,
          command,
          version: need.version,
          status: need.status,
          digests: command === 'edit' && values ? needEditDigests(values) : null,
        }),
      };
    }
    tokens[need.id] = own;
  }
  return tokens;
}

/**
 * What the area under the needs draws. An unresolved add is shown whatever the
 * project's status is now (it is only ever released by the person), a form only
 * for an editable project, a person who may write projects and a list that could
 * be read; a store that could not say is not "no hold".
 */
function addSlot(input: {
  readonly session: WebSession;
  readonly projectId: string;
  readonly projectStatus: string;
  readonly canWrite: boolean;
  readonly listRead: boolean;
  readonly pending: Awaited<ReturnType<typeof readUnresolved>> | null;
}): AddNeedSlot {
  if (!input.canWrite) return { kind: 'NOT_OFFERED', reason: 'ROLE' };
  const offered = mayAddNeed({ projectStatus: input.projectStatus, canWrite: input.canWrite });
  const pending = input.pending;
  if (pending?.kind === 'PENDING') {
    return {
      kind: 'PENDING',
      request: pending.request,
      releaseToken: releaseToken(input.session, needCreateScope(input.projectId), pending.request),
    };
  }
  if (!offered) return { kind: 'NOT_OFFERED', reason: 'STATUS' };
  if (pending === null || pending.kind === 'UNAVAILABLE') return { kind: 'UNCHECKED' };
  if (!input.listRead) return { kind: 'LIST_UNREAD' };
  return { kind: 'FORM', submission: mintNeedSubmission(input.session, input.projectId) };
}

/** The statuses in which the approval policy decides whether the next step can be taken. */
const POLICY_RELEVANT = ['DRAFT', 'CHANGES_REQUESTED', 'PENDING_APPROVAL'];

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/projects/${id}`)}`);

  const canWrite = canWriteProjects(tokenWriteRoles(session.accessToken), webServerEnv());
  const needsCursor = typeof query.needs === 'string' && query.needs !== '' ? query.needs : null;

  const [result, approvals, demoMode, needsRead, pendingAdd] = await Promise.all([
    fetchProject(session, id),
    fetchProjectApprovals(session, id),
    fetchDemoMode(session),
    fetchProjectNeeds(session, id, needsCursor ?? undefined),
    // An unresolved add is looked for whatever the project's status is now: it stays
    // until it is resolved or released, and nothing the person does elsewhere erases it.
    canWrite ? readUnresolved(session, needCreateScope(id)) : Promise.resolve(null),
  ]);

  const project = result.kind === 'OK' ? result.data : null;
  const policy =
    project && POLICY_RELEVANT.includes(project.status)
      ? await fetchExecutionPolicy(session)
      : null;
  // The system is closed with no active policy: the request is not offered, and the
  // state is said instead (docs/24 Q-02). A policy that could not be read is not
  // "closed" — the request stays offered and the service decides.
  const closed = policy?.kind === 'OK' && policy.data.kind === 'CLOSED';

  const offered = project
    ? offeredCommands({ status: project.status, canWrite, policyClosed: closed })
    : [];
  const editValues = project ? editValuesOf(project) : null;
  const tokens =
    project && project.version !== undefined && editValues
      ? projectTokens(session, { ...project, version: project.version }, offered, editValues)
      : {};
  const decisions =
    project && approvals.kind === 'OK' ? decisionTokens(session, id, approvals.data) : {};

  const needList = needsRead.kind === 'OK' ? needsRead.data.items : [];
  const needEditValues = Object.fromEntries(
    needList.map((need) => [need.id, needEditValuesOf(need)]),
  );
  const needCommandTokens = project
    ? needTokens(session, project, needList, needEditValues, canWrite)
    : {};
  const add = addSlot({
    session,
    projectId: id,
    projectStatus: project?.status ?? '',
    canWrite,
    listRead: needsRead.kind === 'OK',
    pending: pendingAdd,
  });
  const release = typeof query.release === 'string' ? query.release : undefined;
  const releaseRefused = release === 'STALE' || release === 'IN_PROGRESS' ? release : null;

  const flash = query[FLASH_PARAM];

  return (
    <AppShell
      topBar={
        <TopBar organizationName={session.organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<PortalSidebar session={session} currentHref="/projects" />}
    >
      <PageHeader title="جزئیات پروژه" description="مشخصات پروژه، موافقت‌ها و اقدام‌های آن." />
      <div className="mt-2">
        <ButtonLink href="/projects" tone="quiet">
          بازگشت به فهرست پروژه‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ProjectDetailScreen
          result={result}
          demoMode={demoMode}
          notice={readFlash(session, typeof flash === 'string' ? flash : undefined, id, [
            ...PROJECT_NOTICES,
            ...NEED_NOTICES,
          ])}
          needList={
            project ? (
              <NeedsSection
                projectId={id}
                csrfToken={session.csrfToken}
                result={needsRead}
                cursor={needsCursor}
                tokens={needCommandTokens}
                editValues={needEditValues}
                add={add}
                releaseRefused={releaseRefused}
              />
            ) : undefined
          }
          approvals={
            project ? (
              <ApprovalsSection>
                {policy ? <PolicyState policy={policy} /> : null}
                <ProjectApprovals
                  result={approvals}
                  csrfToken={session.csrfToken}
                  decisions={decisions}
                />
              </ApprovalsSection>
            ) : undefined
          }
          commands={
            project && editValues ? (
              <ProjectCommandsSection>
                {Object.keys(tokens).length > 0 ? (
                  <ProjectCommands
                    projectId={id}
                    projectTitle={project.title}
                    csrfToken={session.csrfToken}
                    tokens={tokens}
                    initialValues={editValues}
                  />
                ) : (
                  <EmptyState
                    title="اقدامی برای این وضعیت نیست"
                    description={
                      !canWrite
                        ? 'نقش شما اجازه تغییر پروژه ندارد. نقش‌های مجاز را تنظیمات استقرار تعیین می‌کند.'
                        : project.version === undefined
                          ? 'نسخه پروژه از سرویس نیامد و بدون آن فرمانی فرستاده نمی‌شود.'
                          : project.status === 'COMPLETED' || project.status === 'CANCELLED'
                            ? 'این پروژه در وضعیت پایانی است و فرمان دیگری ندارد.'
                            : 'در این وضعیت منتظر تصمیم مرجع یا مرحله بعد هستیم.'
                    }
                  />
                )}
              </ProjectCommandsSection>
            ) : undefined
          }
        />
      </div>
    </AppShell>
  );
}
