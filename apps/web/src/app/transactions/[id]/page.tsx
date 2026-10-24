import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { DISPUTE_COMMANDS } from '@/lib/transaction-dispute-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { tokenAuthority } from '@/server/realm-roles';
import { mintDisputeSubmission } from '@/server/dispute-replay';
import { submissionBinding } from '@/server/submission';
import { disputeCommandsFor, fetchTransaction } from '@/server/transactions';
import { PortalSidebar } from '@/app/PortalSidebar';

import { TransactionDetailScreen } from './TransactionDetailScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/transactions/[id]` route — one transaction and its dispute (EXP-003).
 *
 * **No role check on the read.** economic-service answers 404 for a
 * transaction the caller is not party to, exactly as for a missing one, and the
 * screen renders both the same way. Which dispute forms are drawn is
 * `disputeCommandsFor`'s mirror of what the service would refuse, from the
 * roles **the access token itself** carries for the organization it resolves to
 * (`tokenAuthority`) — the set economic-service decides on, which the
 * membership rows `/v1/users/me` reports can differ from until the token is
 * refreshed (PR 319 review 1, finding 1). UX only; the service decides again.
 *
 * The confirmation after a command is a flash token this session earned for
 * this transaction (`server/flash.ts`), never a query flag.
 */
export const dynamic = 'force-dynamic';

export default async function TransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/transactions/${id}`)}`);

  const query = await searchParams;
  const flash = query[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    id,
    DISPUTE_COMMANDS,
  );

  const result = await fetchTransaction(session, id);

  // A token that cannot be read offers no form: a form that leads to a refusal
  // is the worse mistake, and the record still shows.
  const authority = tokenAuthority(session.accessToken);
  const commands =
    result.kind === 'OK'
      ? disputeCommandsFor(result.data, {
          roles: authority?.roles ?? null,
          organizationId: authority?.organizationId ?? null,
        })
      : [];

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
      sidebar={<PortalSidebar session={session} currentHref="/wallet" />}
    >
      <PageHeader
        title="جزئیات تراکنش"
        description="وضعیت این تراکنش و اعتراض آن، همان‌طور که سامانهٔ مالی ثبت کرده است."
      />
      <div className="mt-2">
        <ButtonLink href="/wallet" tone="quiet">
          بازگشت به کیف پول و تراکنش‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <TransactionDetailScreen
          result={result}
          commands={commands}
          csrfToken={session.csrfToken}
          mintSubmission={(target) => mintDisputeSubmission(session, target)}
          binding={submissionBinding(session)}
          sessionMaxAgeSeconds={webServerEnv().WEB_SESSION_MAX_AGE_SECONDS}
          notice={notice}
        />
      </div>
    </AppShell>
  );
}
