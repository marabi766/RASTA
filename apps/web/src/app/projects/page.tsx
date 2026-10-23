import { redirect } from 'next/navigation';

import { Alert, AppShell, Button, EmptyState, PageHeader, Section, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { INBOX_FLASH_SUBJECT, PROJECT_NOTICE_TEXT, PROJECT_NOTICES } from '@/lib/project-commands';
import { isProjectStatus } from '@/lib/project-fields';
import { currentSession } from '@/server/current-session';
import { readFlash } from '@/server/flash';
import { canWriteProjects, mayDecide, sealProjectBaseline } from '@/server/project-commands';
import { webServerEnv } from '@/server/env';
import { tokenWriteRoles } from '@/server/realm-roles';
import {
  fetchApprovalInbox,
  fetchProjects,
  type ApprovalInbox as Inbox,
  type ProjectListQuery,
} from '@/server/projects';
import type { WebSession } from '@/server/session';
import { mintSubmissionId } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ApprovalInbox } from './ApprovalInbox';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectsScreen } from './ProjectsScreen';
import type { DecisionTokens } from './[id]/ProjectApprovals';

/**
 * The `/projects` route — پروژه‌های عمرانی (docs/16 § ۱۶٫۶).
 *
 * **No role check here**, as on every portal route: construction-service
 * decides who may read (configured roles; the oversight role is always
 * refused) and a refusal is rendered as an outcome (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

function inboxDecisions(session: WebSession, inbox: Inbox): Record<string, DecisionTokens> {
  const tokens: Record<string, DecisionTokens> = {};
  for (const step of inbox.items) {
    if (!mayDecide(session.accessToken, step)) continue;
    const token = (command: 'grant' | 'reject') => ({
      submissionId: mintSubmissionId(session),
      baseline: sealProjectBaseline(session, {
        targetId: step.id,
        projectId: step.projectId,
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

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/projects');

  const params = await searchParams;
  const status = one(params.status);
  // A status the service would not accept is dropped, not forwarded to earn a
  // 400 the person cannot act on.
  const query: ProjectListQuery = {
    status: isProjectStatus(status) ? status : undefined,
    cursor: one(params.cursor),
  };

  const [result, inbox] = await Promise.all([
    fetchProjects(session, query),
    fetchApprovalInbox(session),
  ]);
  const notice = readFlash(session, one(params[FLASH_PARAM]), INBOX_FLASH_SUBJECT, PROJECT_NOTICES);

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
      <PageHeader
        title="پروژه‌های عمرانی"
        description="پروژه‌هایی که این سازمان ثبت کرده و مرحله‌ای که هر کدام در آن است."
      />
      <div className="mt-4 flex flex-col gap-6">
        {notice ? (
          <Alert tone={PROJECT_NOTICE_TEXT[notice].tone}>{PROJECT_NOTICE_TEXT[notice].text}</Alert>
        ) : null}
        <ApprovalInbox
          result={inbox}
          csrfToken={session.csrfToken}
          decisions={inbox.kind === 'OK' ? inboxDecisions(session, inbox.data) : {}}
        />
        <Section
          headingId="create-project"
          title="ثبت پروژه تازه"
          description="پروژه به صورت پیش‌نویس ساخته می‌شود؛ درخواست موافقت از صفحه خود پروژه است."
        >
          {canWriteProjects(tokenWriteRoles(session.accessToken), webServerEnv()) ? (
            <CreateProjectForm
              csrfToken={session.csrfToken}
              submissionId={mintSubmissionId(session)}
            />
          ) : (
            <EmptyState
              title="ثبت پروژه برای نقش شما در دسترس نیست"
              description="نقش‌های مجاز ثبت و تغییر پروژه را تنظیمات استقرار تعیین می‌کند، و نشست باید سازمان فعال داشته باشد."
            />
          )}
        </Section>
        <ProjectsScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
