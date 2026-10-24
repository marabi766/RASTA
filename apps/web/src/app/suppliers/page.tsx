import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isSupplierCapability, isSupplierStatus } from '@/lib/supplier-fields';
import { currentSession } from '@/server/current-session';
import { fetchSuppliers, type SupplierListQuery } from '@/server/suppliers';
import { PortalSidebar } from '@/app/PortalSidebar';

import { SuppliersScreen } from './SuppliersScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/suppliers` route — تأمین‌کنندگان (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No access decision here**, as on every portal route: whether this caller
 * may browse the directory is supplier-service's answer, against the roles
 * in their token, and a refusal is rendered as an outcome (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/suppliers');

  const params = await searchParams;
  const status = one(params.status);
  const capability = one(params.capability);
  // A value the service would not accept is dropped, not forwarded to earn a
  // 400 the person cannot act on.
  const query: SupplierListQuery = {
    status: isSupplierStatus(status) ? status : undefined,
    capability: isSupplierCapability(capability) ? capability : undefined,
    cursor: one(params.cursor),
  };

  const result = await fetchSuppliers(session, query);

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
      <PageHeader
        title="تأمین‌کنندگان"
        description="تأمین‌کنندگان کالا، تعمیرگاه‌ها و پیمانکارانی که این سازمان می‌تواند ببیند."
      />
      <div className="mt-4">
        <SuppliersScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
