import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isSupplierCapability, isSupplierStatus } from '@/lib/supplier-fields';
import { currentSession } from '@/server/current-session';
import { fetchSuppliers, type SupplierListQuery } from '@/server/suppliers';
import { mintSubmissionId } from '@/server/submission';
import { canRegisterSupplier, supplierActor } from '@/server/supplier-commands';
import { RELEASE_PARAM, supplierWriteScope } from '@/server/supplier-unresolved';
import { readUnresolved } from '@/server/unresolved-request';
import { PortalSidebar } from '@/app/PortalSidebar';

import { RegisterSupplierForm } from './SupplierForms';
import { SuppliersScreen } from './SuppliersScreen';
import { SupplierPendingNotices } from './UnresolvedSupplierNotice';

/**
 * The `/suppliers` route — تامین‌کنندگان (docs/16 § ۱۶٫۶): the directory, and
 * the form that registers this organization's own profile.
 *
 * **No access decision for the directory here**, as on every portal route:
 * whether this caller may browse it is supplier-service's answer, against the
 * roles in their token, and a refusal is rendered as an outcome
 * (`docs/16` § ۱۶٫۱۱). The registration form is drawn only for a person the
 * service would admit (`canRegisterSupplier`: a supplier-side role and an
 * organization); the service refuses again on the send.
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

  const [result, unresolved] = await Promise.all([
    fetchSuppliers(session, query),
    // A registration whose answer was lost: it keeps its warning until reconciled.
    readUnresolved(session, supplierWriteScope(null)),
  ]);
  const actor = supplierActor(session.accessToken);

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
      sidebar={<PortalSidebar session={session} currentHref="/suppliers" />}
    >
      <PageHeader
        title="تامین‌کنندگان"
        description="تامین‌کنندگان کالا، تعمیرگاه‌ها و پیمانکارانی که این سازمان می‌تواند ببیند."
      />
      <div className="mt-4">
        <SuppliersScreen
          result={result}
          query={query}
          ownOrganizationId={actor?.organizationId ?? null}
          register={
            actor && canRegisterSupplier(actor) ? (
              <div className="flex flex-col gap-4">
                <SupplierPendingNotices
                  session={session}
                  pending={unresolved}
                  supplierId={null}
                  release={one(params[RELEASE_PARAM])}
                />
                <RegisterSupplierForm
                  key={unresolved.kind === 'NONE' ? 'open' : 'held'}
                  csrfToken={session.csrfToken}
                  submissionId={mintSubmissionId(session)}
                  held={unresolved.kind !== 'NONE'}
                />
              </div>
            ) : null
          }
        />
      </div>
    </AppShell>
  );
}
