import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { FLASH_PARAM } from '@/lib/form-fields';
import { SUPPLIER_NOTICES } from '@/lib/supplier-commands';
import { readFlash } from '@/server/flash';
import { fetchSupplier } from '@/server/suppliers';
import { supplierActor } from '@/server/supplier-commands';
import { RELEASE_PARAM, supplierWriteScope } from '@/server/supplier-unresolved';
import { readUnresolved } from '@/server/unresolved-request';
import { PortalSidebar } from '@/app/PortalSidebar';

import { SupplierPendingNotices } from '../UnresolvedSupplierNotice';
import { SupplierDetailScreen } from './SupplierDetailScreen';
import { NO_COMMANDS, supplierCommandsFor } from './SupplierCommands';

/**
 * The `/suppliers/[id]` route — پرونده‌ی تامین‌کننده (docs/16 § ۱۶٫۶).
 *
 * **No role check on the read.** Whether this caller may see this supplier's
 * private record is supplier-service's answer, against the record: another
 * organization's supplier is `404` and is rendered as absent, exactly like an
 * id that does not exist (`access.ts`: a `403` would confirm the profile
 * exists and that somebody else owns it). The commands are drawn only for a
 * person the service would admit on the record as read
 * (`supplierCommandsFor`); it decides again on every send.
 */
export const dynamic = 'force-dynamic';

export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/suppliers/${id}`)}`);

  const [result, unresolved] = await Promise.all([
    fetchSupplier(session, id),
    // A write on this supplier whose answer was lost: shown whatever the read says.
    readUnresolved(session, supplierWriteScope(id)),
  ]);

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
      <PageHeader title="پرونده‌ی تامین‌کننده" description="صلاحیت‌ها، وضعیت و تاریخچه‌ی تعلیق." />
      <div className="mt-2">
        <ButtonLink href="/suppliers" tone="quiet">
          بازگشت به فهرست تامین‌کنندگان
        </ButtonLink>
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <SupplierPendingNotices
          session={session}
          pending={unresolved}
          supplierId={id}
          release={typeof query[RELEASE_PARAM] === 'string' ? query[RELEASE_PARAM] : undefined}
        />
      </div>
      <div className="mt-4">
        <SupplierDetailScreen
          result={result}
          notice={readFlash(
            session,
            typeof query[FLASH_PARAM] === 'string' ? query[FLASH_PARAM] : undefined,
            id,
            SUPPLIER_NOTICES,
          )}
          commands={
            result.kind === 'OK'
              ? supplierCommandsFor(
                  session,
                  result.data,
                  unresolved.kind !== 'NONE',
                  supplierActor(session.accessToken),
                )
              : NO_COMMANDS
          }
        />
      </div>
    </AppShell>
  );
}
