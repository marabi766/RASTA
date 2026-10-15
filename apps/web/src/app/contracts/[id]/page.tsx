import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchAmendments, fetchContract, fetchMilestones } from '@/server/contracts';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ContractDetailScreen } from './ContractDetailScreen';

/**
 * The `/contracts/[id]` route — جزئیات قرارداد (docs/16 § ۱۶٫۶, ADR-068). Read-only.
 *
 * **No role check here**, as on every portal route: contract-service decides
 * who may read — the employer's organization (configured roles) and the
 * winning contractor's organization (the fixed `CONTRACTOR` role) — and
 * refuses everyone else with `404`, never `403`, so existence is never
 * disclosed. A refusal is rendered as an outcome, not chased with a redirect.
 *
 * Amendments and milestones are read only once the contract itself answers
 * `OK`: asking for a sub-resource of a contract the caller may not see would
 * be a second chance to learn something the first read already refused.
 */
export const dynamic = 'force-dynamic';

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/contracts/${id}`)}`);

  const result = await fetchContract(session, id);
  const [amendments, milestones] =
    result.kind === 'OK'
      ? await Promise.all([fetchAmendments(session, id), fetchMilestones(session, id)])
      : [null, null];

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
      sidebar={<PortalSidebar session={session} currentHref="/contracts" />}
    >
      <PageHeader
        title="جزئیات قرارداد"
        description="وضعیت، طرفین، مبلغ، امضاها، الحاقیه‌ها و Milestoneها."
      />
      <div className="mt-2">
        <ButtonLink href="/contracts" tone="quiet">
          بازگشت به فهرست قراردادها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ContractDetailScreen result={result} amendments={amendments} milestones={milestones} />
      </div>
    </AppShell>
  );
}
