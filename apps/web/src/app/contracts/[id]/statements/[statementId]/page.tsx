import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { STATEMENT_COMMANDS } from '@/lib/statement-fields';
import {
  canSubmitStatement,
  decidableStepFor,
  fetchStatement,
  statementCallerOf,
} from '@/server/contract-statements';
import { fetchContract } from '@/server/contracts';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { mintStatementSubmission } from '@/server/statement-replay';
import { submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import type { OfferedStatementCommand } from '../../StatementCommands';
import { StatementDetailScreen } from './StatementDetailScreen';

/**
 * The `/contracts/[id]/statements/[statementId]` route — one statement, its
 * lines, its deductions and both approval chains (EXP-004, ADR-068 § 5).
 *
 * **No role check on the read.** contract-service lets the contract's two
 * parties read it, and an organization a step of its chains names (with that
 * step's role) read **this statement only**; everyone else gets `404`, exactly
 * like a statement that does not exist, and the screen says the same for both.
 * The statement is read first and on its own: an approver who is not a party
 * cannot read the contract, and still sees the statement. The contract is
 * read after, only to show where the statement belongs and to know it is
 * `SIGNED` — its own refusal hides nothing about the statement.
 *
 * Which forms are drawn is `canSubmitStatement` / `decidableStepFor`: copies of
 * the service's own checks, from the roles **the access token** carries. A
 * submit's and a decision's body is signed into the form's stamp here — the
 * statement's version and the step, as this page showed them
 * (`server/statement-replay.ts`). UX only; the service decides again,
 * separation of duties included.
 */
export const dynamic = 'force-dynamic';

export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; statementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, statementId } = await params;
  const href = `/contracts/${encodeURIComponent(id)}/statements/${encodeURIComponent(statementId)}`;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(href)}`);

  const flash = (await searchParams)[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    statementId,
    STATEMENT_COMMANDS,
  );

  const result = await fetchStatement(session, id, statementId);
  const contract = result.kind === 'OK' ? await fetchContract(session, id) : null;

  const offered: OfferedStatementCommand[] = [];
  if (result.kind === 'OK') {
    const statement = result.data;
    const caller = statementCallerOf(session.accessToken);
    const facts = contract?.kind === 'OK' ? contract.data : null;
    const target = { contractId: id, statementId, expectedVersion: statement.version };
    if (facts && canSubmitStatement(caller, facts, statement)) {
      offered.push({
        command: 'SUBMIT',
        submission: mintStatementSubmission(session, {
          ...target,
          command: 'SUBMIT',
          chain: null,
          stepOrder: null,
        }),
      });
    }
    const step = decidableStepFor(caller, statement, facts);
    if (step) {
      for (const command of ['APPROVE', 'REJECT'] as const) {
        offered.push({
          command,
          submission: mintStatementSubmission(session, {
            ...target,
            command,
            chain: step.chain,
            stepOrder: step.stepOrder,
          }),
        });
      }
    }
  }

  const demoMode = await fetchDemoMode(session);

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
        title="جزئیات صورت‌وضعیت"
        description="ردیف‌ها، کسورات، مبلغ خالص و دو زنجیرهٔ تأیید (فنی، سپس مالی)."
      />
      <div className="mt-2">
        {contract?.kind === 'OK' ? (
          <ButtonLink href={`/contracts/${encodeURIComponent(id)}`} tone="quiet">
            بازگشت به قرارداد
          </ButtonLink>
        ) : (
          <ButtonLink href="/contracts" tone="quiet">
            بازگشت به فهرست قراردادها
          </ButtonLink>
        )}
      </div>
      <div className="mt-4">
        <StatementDetailScreen
          result={result}
          contractUnavailable={
            contract !== null && (contract.kind === 'UNAVAILABLE' || contract.kind === 'MALFORMED')
          }
          offered={offered}
          csrfToken={session.csrfToken}
          binding={submissionBinding(session)}
          sessionMaxAgeSeconds={webServerEnv().WEB_SESSION_MAX_AGE_SECONDS}
          notice={notice}
          pageHref={href}
          demoMode={demoMode}
        />
      </div>
    </AppShell>
  );
}
