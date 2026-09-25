import { redirect } from 'next/navigation';
import { AppShell, Button, PageHeader, Section, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { canManageDrivers, fetchDrivers, type DriverListQuery } from '@/server/drivers';
import { fetchCurrentUser } from '@/server/identity';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { DriversScreen } from './DriversScreen';
import { NewDriverForm } from './NewDriverForm';

/**
 * The `/drivers` route — راننده و تخصیص (docs/16 § ۱۶٫۶, role `FLEET_MANAGER`).
 *
 * List and registration on one page, the same reason `/usage` needed no
 * second route for its form: there is no `/drivers/new` in docs/16's page
 * map, and a route the document does not name is a promise the product does
 * not keep (`nav.ts`).
 *
 * The registration form is a Route Guard as UX, not as security (`docs/16 §
 * ۱۶٫۱۱`, which asks for both in the same breath: hide the control for
 * somebody who cannot use it, and never let that hiding stand in for the
 * server's own check). fleet-service still decides, independently, who may
 * register a driver — a role that lost write access between this render and
 * the submit still gets refused there, not waved through because the form
 * was visible a moment ago.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/drivers');

  const params = await searchParams;
  const query: DriverListQuery = {
    status: one(params.status),
    q: one(params.q),
    cursor: one(params.cursor),
  };

  const [result, currentUser] = await Promise.all([
    fetchDrivers(session, query),
    fetchCurrentUser(session),
  ]);

  // A failed identity read shows no registration form rather than one that
  // might not work — the same fail-closed default `canManageDrivers` documents.
  const manage = currentUser.kind === 'USER' && canManageDrivers(currentUser.user.effectiveRoles);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/drivers" />}
    >
      <PageHeader
        title="راننده و تخصیص"
        description="رانندگان این سازمان، شمارهٔ گواهینامه و اعتبار آن، و ثبت راننده تازه."
      />

      {manage ? (
        <Section headingId="new-driver" title="ثبت راننده" className="mt-4">
          <NewDriverForm csrfToken={session.csrfToken} submissionId={newSubmissionId()} />
        </Section>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        <DriversScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
