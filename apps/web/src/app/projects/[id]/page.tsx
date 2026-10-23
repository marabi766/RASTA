import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, EmptyState, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import {
  PROJECT_NOTICES,
  normalizeProjectValues,
  type ProjectCommand,
  type ProjectFormValues,
} from '@/lib/project-commands';
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
import { webServerEnv } from '@/server/env';
import { tokenWriteRoles } from '@/server/realm-roles';
import {
  fetchExecutionPolicy,
  fetchProject,
  fetchProjectApprovals,
  type ProjectApproval,
  type ProjectDetail,
} from '@/server/projects';
import type { WebSession } from '@/server/session';
import { mintSubmissionId } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

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

  const [result, approvals] = await Promise.all([
    fetchProject(session, id),
    fetchProjectApprovals(session, id),
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

  const canWrite = canWriteProjects(tokenWriteRoles(session.accessToken), webServerEnv());
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
          notice={readFlash(
            session,
            typeof flash === 'string' ? flash : undefined,
            id,
            PROJECT_NOTICES,
          )}
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
