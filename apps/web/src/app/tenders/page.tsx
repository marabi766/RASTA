import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isTenderStatus } from '@/lib/tender-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { fetchCurrentUser } from '@/server/identity';
import { tenderDoorsFor } from '@/server/portal-nav';
import { fetchOpenTenders, fetchTenders } from '@/server/tenders';
import { PortalSidebar } from '@/app/PortalSidebar';

import { TendersScreen, type TendersQuery, type TendersView } from './TendersScreen';

/**
 * The `/tenders` route — مناقصه‌ها (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No access decision here**, as on every portal route: the roles only choose
 * which gateway door to ask (the owner's list, the bidder's list, or both), and
 * construction-service decides what each answers; a refusal is rendered as an
 * outcome (`docs/16` § ۱۶٫۱۱). When the roles themselves cannot be read nothing
 * is asked, and the person is told so.
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

  const current = await fetchCurrentUser(session);

  let view: TendersView;
  if (current.kind === 'USER') {
    const doors = tenderDoorsFor(current.user.effectiveRoles, webServerEnv());
    const [own, open] = await Promise.all([
      doors.own ? fetchTenders(session, query) : null,
      doors.open ? fetchOpenTenders(session, { cursor: query.openCursor }) : null,
    ]);
    view = { kind: 'SIDES', own, open };
  } else {
    view = { kind: 'IDENTITY_UNAVAILABLE', correlationId: current.correlationId };
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
      sidebar={<PortalSidebar session={session} currentHref="/tenders" current={current} />}
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
