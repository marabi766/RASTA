import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchProject } from '@/server/projects';
import { fetchDemoMode } from '@/server/demo-mode';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ProjectDetailScreen } from './ProjectDetailScreen';

/**
 * The `/projects/[id]` route — جزئیات پروژه (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No role check here.** Whether this caller may see the project is
 * construction-service's answer, against the record: another organization's
 * project is `404` and is rendered as absent.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/projects/${id}`)}`);

  const [result, demoMode] = await Promise.all([fetchProject(session, id), fetchDemoMode(session)]);

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
      <PageHeader title="جزئیات پروژه" description="مشخصات پروژه و وضعیت آن." />
      <div className="mt-2">
        <ButtonLink href="/projects" tone="quiet">
          بازگشت به فهرست پروژه‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ProjectDetailScreen result={result} demoMode={demoMode} />
      </div>
    </AppShell>
  );
}
