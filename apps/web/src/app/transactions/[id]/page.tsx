import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { isDisputeCommand } from '@/lib/transaction-dispute-fields';
import { currentSession } from '@/server/current-session';
import { fetchCurrentUser } from '@/server/identity';
import { requestRoles } from '@/server/realm-roles';
import { mintSubmissionId } from '@/server/submission';
import { disputeCommandsFor, fetchTransaction } from '@/server/transactions';
import { PortalSidebar } from '@/app/PortalSidebar';

import { TransactionDetailScreen } from './TransactionDetailScreen';

/**
 * The `/transactions/[id]` route — one transaction and its dispute (EXP-003).
 *
 * **No role check on the read.** economic-service answers 404 for a
 * transaction the caller is not party to, exactly as for a missing one, and the
 * screen renders both the same way. Which dispute forms are drawn is
 * `disputeCommandsFor`'s mirror of what the service would refuse, from the
 * roles identity-service reports plus the realm's global ones (`requestRoles`,
 * the set the service acts on) — UX only; the service decides again.
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
  const done =
    typeof query.done === 'string' && isDisputeCommand(query.done) ? query.done : undefined;

  const [result, currentUser] = await Promise.all([
    fetchTransaction(session, id),
    fetchCurrentUser(session),
  ]);

  // An identity answer that is missing or unreadable offers no form: a form
  // that leads to a refusal is the worse mistake, and the record still shows.
  const roles =
    currentUser.kind === 'USER'
      ? requestRoles(currentUser.user.effectiveRoles, session.accessToken)
      : null;
  const commands =
    result.kind === 'OK'
      ? disputeCommandsFor(result.data, { roles, organizationId: session.organizationId })
      : [];

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
          mintSubmissionId={() => mintSubmissionId(session)}
          done={done}
        />
      </div>
    </AppShell>
  );
}
