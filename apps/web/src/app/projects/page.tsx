import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isProjectStatus } from '@/lib/project-fields';
import { currentSession } from '@/server/current-session';
import { fetchProjects, type ProjectListQuery } from '@/server/projects';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ProjectsScreen } from './ProjectsScreen';

/**
 * The `/projects` route — پروژه‌های عمرانی (docs/16 § ۱۶٫۶).
 *
 * **No role check here**, as on every portal route: construction-service
 * decides who may read (configured roles; the oversight role is always
 * refused) and a refusal is rendered as an outcome (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

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

  const result = await fetchProjects(session, query);

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
      <div className="mt-4">
        <ProjectsScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
