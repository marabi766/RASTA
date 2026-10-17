import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { safeReturnTo } from '@/server/login-attempt';
import { tenderDoorsFor } from '@/server/portal-nav';
import { tokenRoles } from '@/server/realm-roles';
import { fetchOpenTender, fetchTender, fetchTenderCriteria } from '@/server/tenders';
import { tenderDetailPath } from '@/lib/tender-fields';
import { PortalSidebar } from '@/app/PortalSidebar';

import { OpenTenderDetailScreen, OwnTenderDetailScreen } from './TenderDetailScreen';

/**
 * The `/tenders/[id]` route — جزئیات مناقصه (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No access decision here.** A tender has two doors — the owner's
 * (`/v1/tenders/{id}`) and the bidder's (`/v1/open-tenders/{id}`) — and the
 * address says which one a link meant (`?view=open` from the bidder's list). A
 * bare address takes the owner's door, or the bidder's for somebody who is only
 * a bidder — by the access token's own roles (`tokenRoles`); a token whose
 * roles cannot be read is no bidder, so takes the owner's door. Whether this caller may see the tender is construction-service's
 * answer, against the record: one it will not show is `404` and is rendered as
 * absent. Bids are never asked for.
 */
export const dynamic = 'force-dynamic';

export default async function TenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { view: requested } = await searchParams;
  const session = await currentSession();
  if (!session) {
    redirect(
      `/login?returnTo=${encodeURIComponent(safeReturnTo(tenderDetailPath(id, requested)))}`,
    );
  }

  // From the token's own roles, the set construction-service decides on.
  const doors = tenderDoorsFor(tokenRoles(session.accessToken) ?? [], webServerEnv());
  const open = requested === 'open' || (requested !== 'own' && !doors.own);

  let body: ReactNode;
  if (open) {
    body = <OpenTenderDetailScreen result={await fetchOpenTender(session, id)} />;
  } else {
    const result = await fetchTender(session, id);
    const criteria = result.kind === 'OK' ? await fetchTenderCriteria(session, id) : null;
    body = <OwnTenderDetailScreen result={result} criteria={criteria} />;
  }

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
      sidebar={<PortalSidebar session={session} currentHref="/tenders" />}
    >
      <PageHeader
        title="جزئیات مناقصه"
        description="مشخصات مناقصه، بازهٔ پذیرش پیشنهاد و معیارها."
      />
      <div className="mt-2">
        <ButtonLink href="/tenders" tone="quiet">
          بازگشت به فهرست مناقصه‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">{body}</div>
    </AppShell>
  );
}
