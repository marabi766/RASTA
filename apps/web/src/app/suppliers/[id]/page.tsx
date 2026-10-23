import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { FLASH_PARAM } from '@/lib/form-fields';
import { SUPPLIER_NOTICES } from '@/lib/supplier-commands';
import { readFlash } from '@/server/flash';
import { fetchSupplier } from '@/server/suppliers';
import { supplierActor } from '@/server/supplier-commands';
import { supplierWriteScope } from '@/server/supplier-unresolved';
import { readUnresolved } from '@/server/unresolved-request';
import { PortalSidebar } from '@/app/PortalSidebar';

import { UnresolvedSupplierNotice } from '../UnresolvedSupplierNotice';
import { SupplierDetailScreen } from './SupplierDetailScreen';
import { NO_COMMANDS, supplierCommandsFor } from './SupplierCommands';

/**
 * The `/suppliers/[id]` route — پروندهٔ تأمین‌کننده (docs/16 § ۱۶٫۶).
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
      <PageHeader title="پروندهٔ تأمین‌کننده" description="صلاحیت‌ها، وضعیت و تاریخچهٔ تعلیق." />
      <div className="mt-2">
        <ButtonLink href="/suppliers" tone="quiet">
          بازگشت به فهرست تأمین‌کنندگان
        </ButtonLink>
      </div>
      {unresolved ? (
        <div className="mt-4">
          <UnresolvedSupplierNotice
            request={unresolved}
            supplierId={id}
            csrfToken={session.csrfToken}
          />
        </div>
      ) : null}
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
                  supplierActor(session.accessToken),
                  unresolved !== null,
                )
              : NO_COMMANDS
          }
        />
      </div>
    </AppShell>
  );
}
