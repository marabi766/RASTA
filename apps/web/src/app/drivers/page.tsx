import { redirect } from 'next/navigation';
import { AppShell, Button, EmptyState, PageHeader, Section, TopBar } from '@/ui';
import type { DriverPicker } from '@/lib/driver-fields';
import { currentSession } from '@/server/current-session';
import { canManageDrivers, fetchDrivers, type DriverListQuery } from '@/server/drivers';
import { loadDriverRoster, type DriverRoster } from '@/server/driver-roster';
import { tokenWriteRoles } from '@/server/realm-roles';
import { mintSubmissionId } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';
import { DriversScreen } from './DriversScreen';
import { NewDriverForm } from './NewDriverForm';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

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
  // What the forms are offered on: the access token's own roles (`tokenWriteRoles`),
  // the set the service decides on — not `/v1/users/me`, which runs ahead of the
  // token until it is refreshed.
  const roles = tokenWriteRoles(session.accessToken);

  const params = await pageParams(session, searchParams);
  const query: DriverListQuery = {
    status: one(params.status),
    q: one(params.q),
    cursor: one(params.cursor),
  };

  // A token whose roles cannot be read shows no registration form rather than one that
  // might not work — the same fail-closed default `canManageDrivers` documents.
  const manage = roles !== null && canManageDrivers(roles);

  // Who the form may offer, and the names the list may show (task 095): read
  // only for somebody who may list the members, and only whole.
  const [result, roster] = await Promise.all([
    fetchDrivers(session, query),
    manage ? loadDriverRoster(session, roles) : Promise.resolve<DriverRoster | null>(null),
  ]);
  const picker: DriverPicker | null =
    roster === null
      ? null
      : roster.kind === 'LISTED'
        ? { kind: 'PICK', candidates: roster.candidates }
        : { kind: 'ID', reason: roster.reason };

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
      sidebar={<PortalSidebar session={session} currentHref="/drivers" />}
    >
      <PageHeader
        title="راننده و تخصیص"
        description="رانندگان این سازمان، شمارهٔ گواهینامه و اعتبار آن، و ثبت راننده تازه."
      />

      {picker ? (
        <Section headingId="new-driver" title="ثبت راننده" className="mt-4">
          {picker.kind === 'PICK' && picker.candidates.length === 0 ? (
            // The whole member list was read: nobody is left to register.
            <EmptyState
              title="عضوی که هنوز راننده نباشد در این سازمان نیست"
              description="هر عضو این سازمان پیش‌تر راننده ثبت شده است. برای ثبت راننده تازه، نخست او را در «سازمان و اعضا» عضو کنید."
            />
          ) : (
            <NewDriverForm
              csrfToken={session.csrfToken}
              submissionId={mintSubmissionId(session)}
              picker={picker}
            />
          )}
        </Section>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        <DriversScreen
          result={result}
          query={{ ...query, context: pageContext(session) }}
          names={roster?.names ?? null}
        />
      </div>
    </AppShell>
  );
}
