import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { CONTRACT_COMMANDS } from '@/lib/contract-command-fields';
import { FLASH_PARAM } from '@/lib/form-fields';
import { contractCallerOf } from '@/server/contract-commands';
import {
  canDraftStatement,
  fetchStatements,
  statementCallerOf,
} from '@/server/contract-statements';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { fetchAmendments, fetchContract, fetchMilestones } from '@/server/contracts';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { mintStatementSubmission } from '@/server/statement-replay';
import { submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import { ContractDetailScreen } from './ContractDetailScreen';
import { contractCommandOffers } from './contract-offers';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

/**
 * The `/contracts/[id]` route — جزئیات قرارداد (docs/16 § ۱۶٫۶, ADR-068).
 *
 * **No role check here**, as on every portal route: contract-service decides
 * who may read — the employer's organization (configured roles) and the
 * winning contractor's organization (the fixed `CONTRACTOR` role) — and
 * refuses everyone else with `404`, never `403`, so existence is never
 * disclosed. A refusal is rendered as an outcome, not chased with a redirect.
 *
 * Amendments, milestones and statements are read only once the contract
 * itself answers `OK`: asking for a sub-resource of a contract the caller may
 * not see would be a second chance to learn something the first read already
 * refused.
 *
 * The contractor's draft form is drawn when `canDraftStatement` — a copy of
 * contract-service's own checks, from the roles **the access token** carries —
 * says the service would accept it. The contract's own forms — signing,
 * cancelling a draft, proposing and signing an amendment, planning and
 * changing a milestone — are drawn the same way (`contract-offers.ts`). UX
 * only; the service decides again.
 *
 * A confirmed command comes back here with a signed confirmation for this
 * contract (`server/flash.ts`); a typed one shows nothing.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function ContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/contracts/${id}`)}`);

  const query = await pageParams(session, searchParams);
  const amendmentCursor = one(query.amendmentCursor);
  const statementCursor = one(query.statementCursor);

  const flash = query[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    id,
    CONTRACT_COMMANDS,
  );

  const result = await fetchContract(session, id);
  const [amendments, milestones, statements] =
    result.kind === 'OK'
      ? await Promise.all([
          fetchAmendments(session, id, amendmentCursor),
          fetchMilestones(session, id),
          fetchStatements(session, id, statementCursor),
        ])
      : [null, null, null];

  const commands =
    result.kind === 'OK'
      ? await contractCommandOffers(
          session,
          contractCallerOf(session.accessToken),
          result.data,
          amendments,
          milestones,
        )
      : null;

  const draft =
    result.kind === 'OK' && canDraftStatement(statementCallerOf(session.accessToken), result.data)
      ? {
          offered: [
            {
              command: 'DRAFT' as const,
              submission: mintStatementSubmission(session, { command: 'DRAFT', contractId: id }),
            },
          ],
          csrfToken: session.csrfToken,
          binding: submissionBinding(session),
          sessionMaxAgeSeconds: webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
          milestones:
            milestones?.kind === 'OK'
              ? milestones.data.items.map((milestone) => ({
                  id: milestone.id,
                  title: milestone.title,
                }))
              : [],
        }
      : null;

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
        title="جزئیات قرارداد"
        description="وضعیت، طرفین، مبلغ، امضاها، الحاقیه‌ها، Milestoneها و صورت‌وضعیت‌ها."
      />
      <div className="mt-2">
        <ButtonLink href="/contracts" tone="quiet">
          بازگشت به فهرست قراردادها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ContractDetailScreen
          context={pageContext(session)}
          result={result}
          amendments={amendments}
          milestones={milestones}
          statements={statements}
          draft={draft}
          commands={commands}
          notice={notice ?? null}
          demoMode={demoMode}
        />
      </div>
    </AppShell>
  );
}
