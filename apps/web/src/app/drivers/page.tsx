import { redirect } from 'next/navigation';
import { AppShell, Button, PageHeader, Section, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDrivers, type DriverListQuery } from '@/server/drivers';
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
 * **No role check here**, for the same reason `/usage` has none: hiding a
 * control is not a security control (`docs/16 § ۱۶٫۱۱`). fleet-service
 * decides who may register a driver; a refusal from it is rendered as an
 * outcome, not guarded against a second time here.
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

  const result = await fetchDrivers(session, query);

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

      <Section headingId="new-driver" title="ثبت راننده" className="mt-4">
        <NewDriverForm csrfToken={session.csrfToken} submissionId={newSubmissionId()} />
      </Section>

      <div className="mt-4 flex flex-col gap-4">
        <DriversScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
