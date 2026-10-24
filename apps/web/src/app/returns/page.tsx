import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isReturnListSide, isReturnStatus } from '@/lib/return-fields';
import { currentSession } from '@/server/current-session';
import {
  fetchReturns,
  returnCallerOf,
  returnCommandsFor,
  type ReturnListQuery,
} from '@/server/returns';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ReturnsScreen } from './ReturnsScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/returns` route — درخواست‌های بازگشت کالا (EXP-003, RUN-005).
 *
 * **No role check on the read.** marketplace-service decides who may list
 * (`@Roles` of `GET /v1/returns`) and lists only the caller's own side
 * (`role`), and a refusal is rendered as an outcome. The "action needed" cue
 * is `returnCommandsFor` — a copy of the service's own checks, from the access
 * token's roles, as the request's own page uses it, so an authorized request
 * is never cued for a withdrawal the portal does not offer. The actions
 * themselves are on each request's page.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/returns');

  const params = await searchParams;
  const role = one(params.role);
  const status = one(params.status);
  // Anything the service would not accept falls back to its own default (or
  // to no filter), rather than being forwarded to earn a 400.
  const query: ReturnListQuery = {
    side: isReturnListSide(role) ? role : 'BUYER',
    ...(isReturnStatus(status) ? { status } : {}),
    ...(one(params.cursor) ? { cursor: one(params.cursor) } : {}),
  };

  const result = await fetchReturns(session, query);
  const caller = returnCallerOf(session.accessToken);
  const actionable = new Set(
    result.kind === 'OK'
      ? result.data.items
          .filter((request) => returnCommandsFor(caller, request).length > 0)
          .map((request) => request.id)
      : [],
  );

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
      sidebar={<PortalSidebar session={session} currentHref="/returns" />}
    >
      <PageHeader
        title="بازگشت کالا"
        description="درخواست‌های بازگشت کالا که این سازمان داده یا به آن داده شده، و وضعیت هر کدام. بازپرداخت از این صفحه انجام نمی‌شود."
      />
      <div className="mt-4">
        <ReturnsScreen result={result} query={query} actionable={actionable} />
      </div>
    </AppShell>
  );
}
