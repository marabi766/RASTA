import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isTenderStatus } from '@/lib/tender-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { tenderDoorsFor } from '@/server/portal-nav';
import { tokenRoles } from '@/server/realm-roles';
import { fetchOpenTenders, fetchTenders } from '@/server/tenders';
import { PortalSidebar } from '@/app/PortalSidebar';

import { TendersScreen, type TendersQuery, type TendersView } from './TendersScreen';

/**
 * The `/tenders` route — مناقصه‌ها (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No access decision here**, as on every portal route: the roles only choose
 * which gateway door to ask (the owner's list, the bidder's list, or both), and
 * construction-service decides what each answers; a refusal is rendered as an
 * outcome (`docs/16` § ۱۶٫۱۱). The roles are the access token's
 * (`tokenRoles`); when they cannot be read the owner's door is asked, and its
 * answer — a refusal, then — is what is shown.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function TendersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/tenders');

  const params = await searchParams;
  const status = one(params.status);
  // A status the service would not accept is dropped, not forwarded to earn a
  // 400 the person cannot act on.
  const query: TendersQuery = {
    status: isTenderStatus(status) ? status : undefined,
    cursor: one(params.cursor),
    openCursor: one(params.openCursor),
  };

  // The doors come from the token's own roles, the set construction-service
  // decides on — not `/v1/users/me`, which runs ahead of the token until it is
  // refreshed. A token that cannot be read is no bidder: the owner's door is
  // asked and its own answer shown.
  const doors = tenderDoorsFor(tokenRoles(session.accessToken) ?? [], webServerEnv());
  const [own, open] = await Promise.all([
    doors.own ? fetchTenders(session, query) : null,
    doors.open ? fetchOpenTenders(session, { cursor: query.openCursor }) : null,
  ]);
  const view: TendersView = { kind: 'SIDES', own, open };

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
        title="مناقصه‌ها"
        description="مناقصه‌هایی که این سازمان برگزار کرده و مناقصه‌هایی که می‌تواند برایشان پیشنهاد بدهد."
      />
      <div className="mt-4">
        <TendersScreen view={view} query={query} />
      </div>
    </AppShell>
  );
}
