import { redirect } from 'next/navigation';

import { Alert, AppShell, Button, PageHeader, TopBar } from '@/ui';
import { PENDING_UNCHECKED_MESSAGE, isDemandStatus } from '@/lib/demand-commands';
import { currentSession } from '@/server/current-session';
import { canUseDemands } from '@/server/demand-commands';
import { DEMAND_SUBMIT_UNRESOLVED, mintDemandSubmission } from '@/server/demand-replay';
import { fetchDemands, type DemandListQuery } from '@/server/demands';
import { webServerEnv } from '@/server/env';
import { pageContext, pageParams } from '@/server/page-context';
import {
  actingOrganizationLabel,
  actingScope,
  sessionWriteRoles,
} from '@/server/session-organization';
import { readReleaseFeedback } from '@/server/release-feedback';
import { readUnresolved, releaseToken } from '@/server/unresolved-request';
import { PortalSidebar } from '@/app/PortalSidebar';
import { ReleaseFeedback } from '@/app/ReleaseFeedback';

import { DemandForm } from './DemandForm';
import { DemandsScreen, demandsHref } from './DemandsScreen';
import { UnresolvedDemandNotice } from './UnresolvedDemandNotice';

/**
 * The `/procurement/demands` route — نیازهای تدارکات (EXP-004, COM-007): this
 * organization's demands, and the form that registers one.
 *
 * **No access decision for the list here**, as on every portal route:
 * procurement-service decides, and a refusal is rendered as an outcome. The form
 * is drawn only for a role the service would admit (`canUseDemands`); the
 * service refuses again on the send.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function DemandsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/procurement/demands');

  // Parameters drawn for another organization are dropped (`page-context.ts`):
  // a switch of organization starts from the first page, unfiltered.
  const params = await pageParams(session, searchParams);
  const status = one(params.status);
  const query: DemandListQuery = {
    // A status the service would not accept is dropped, not forwarded to earn a 400.
    status: isDemandStatus(status) ? status : undefined,
    cursor: one(params.cursor),
  };
  const context = pageContext(session);
  const mayCreate = canUseDemands(sessionWriteRoles(session), webServerEnv());

  const [result, pending] = await Promise.all([
    fetchDemands(session, query),
    mayCreate ? readUnresolved(session, DEMAND_SUBMIT_UNRESOLVED) : null,
  ]);

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
      sidebar={<PortalSidebar session={session} currentHref="/procurement/demands" />}
    >
      <PageHeader
        title="نیازهای تدارکات"
        description="نیازهایی که این سازمان ثبت کرده و پنجره تجمیعی که هر کدام به آن پیوسته است."
      />
      <div className="mt-4">
        <DemandsScreen
          result={result}
          query={{ ...query, context }}
          create={
            pending === null ? null : (
              <div className="flex flex-col gap-4">
                <ReleaseFeedback
                  surface="demand-submission"
                  outcome={readReleaseFeedback(
                    session,
                    { surface: 'demand-submission' },
                    one(params.release),
                    pending.kind === 'NONE',
                  )}
                />
                {pending.kind === 'UNAVAILABLE' ? (
                  // Not "nothing held": the store could not say, so no form is
                  // drawn (and no fresh key minted); the action refuses too.
                  <Alert tone="warning">{PENDING_UNCHECKED_MESSAGE}</Alert>
                ) : pending.kind === 'PENDING' ? (
                  <>
                    <UnresolvedDemandNotice
                      request={pending.request}
                      csrfToken={session.csrfToken}
                      releaseToken={releaseToken(
                        session,
                        DEMAND_SUBMIT_UNRESOLVED,
                        pending.request,
                      )}
                      now={pending.now}
                      listHref={demandsHref({ context })}
                    />
                    {pending.request.ref ? (
                      // The held request keeps its key and its signed stamp,
                      // rebuilt from the server's record, never from a response.
                      <DemandForm
                        csrfToken={session.csrfToken}
                        submission={{ id: pending.request.key, replay: pending.request.ref }}
                      />
                    ) : null}
                  </>
                ) : (
                  <DemandForm
                    csrfToken={session.csrfToken}
                    submission={mintDemandSubmission(session)}
                  />
                )}
              </div>
            )
          }
        />
      </div>
    </AppShell>
  );
}
