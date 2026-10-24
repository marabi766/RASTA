import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isContractStatus } from '@/lib/contract-fields';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { fetchContracts, type ContractListQuery } from '@/server/contracts';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ContractsScreen } from './ContractsScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/contracts` route — قراردادها (docs/16 § ۱۶٫۶, ADR-068).
 *
 * **No role check here**, as on every portal route: contract-service decides
 * who may read (configured roles on the employer's side, the fixed
 * `CONTRACTOR` role on its own side; the oversight role and a service token
 * are always refused) and a refusal is rendered as an outcome
 * (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/contracts');

  const params = await searchParams;
  const status = one(params.status);
  // A status the service would not accept is dropped, not forwarded to earn a
  // 400 the person cannot act on.
  const query: ContractListQuery = {
    status: isContractStatus(status) ? status : undefined,
    cursor: one(params.cursor),
  };

  const result = await fetchContracts(session, query);

  const demoMode = await fetchDemoMode(session);

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
      sidebar={<PortalSidebar session={session} currentHref="/contracts" />}
    >
      <PageHeader
        title="قراردادها"
        description="قراردادهایی که این سازمان طرف آن‌هاست — به‌عنوان کارفرما یا پیمانکار."
      />
      <div className="mt-4">
        <ContractsScreen result={result} query={query} demoMode={demoMode} />
      </div>
    </AppShell>
  );
}
