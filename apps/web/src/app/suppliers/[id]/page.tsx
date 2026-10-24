import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchSupplier } from '@/server/suppliers';
import { PortalSidebar } from '@/app/PortalSidebar';

import { SupplierDetailScreen } from './SupplierDetailScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/suppliers/[id]` route — پروندهٔ تأمین‌کننده (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No role check here.** Whether this caller may see this supplier's private
 * record is supplier-service's answer, against the record: another
 * organization's supplier is `404` and is rendered as absent, exactly like an
 * id that does not exist (`access.ts`: a `403` would confirm the profile
 * exists and that somebody else owns it).
 */
export const dynamic = 'force-dynamic';

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/suppliers/${id}`)}`);

  const result = await fetchSupplier(session, id);

  return (
    <AppShell
      key={actingScope(session)}
      topBar={
        <TopBar organizationName={actingOrganizationLabel(session)}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<PortalSidebar session={session} currentHref="/suppliers" />}
    >
      <PageHeader title="پروندهٔ تأمین‌کننده" description="صلاحیت‌ها، وضعیت و تاریخچهٔ تعلیق." />
      <div className="mt-2">
        <ButtonLink href="/suppliers" tone="quiet">
          بازگشت به فهرست تأمین‌کنندگان
        </ButtonLink>
      </div>
      <div className="mt-4">
        <SupplierDetailScreen result={result} />
      </div>
    </AppShell>
  );
}
