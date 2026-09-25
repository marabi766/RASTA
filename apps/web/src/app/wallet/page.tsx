import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import {
  fetchHolds,
  fetchPaymentProvider,
  fetchTransactions,
  fetchWallet,
  type HoldsPage,
  type ReadResult,
  type TransactionListQuery,
} from '@/server/wallet';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { WalletScreen } from './WalletScreen';

/**
 * The `/wallet` route — کیف پول و تراکنش (docs/16 § ۱۶٫۶, role
 * `ORGANIZATION_ADMIN`).
 *
 * **No role check here**, matching every other write-carrying screen in this
 * portal: hiding a control is not a security control (`docs/16 § ۱۶٫۱۱`).
 * economic-service decides who may see this wallet and who may top it up; a
 * refusal from it is rendered as an outcome, not guarded against a second
 * time here.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/wallet');

  const params = await searchParams;
  const query: TransactionListQuery = {
    status: one(params.status),
    transactionType: one(params.transactionType),
    cursor: one(params.cursor),
  };

  const wallet = await fetchWallet(session);
  // A wallet read that did not come back `OK` has nothing to fetch holds
  // for; its own refusal, absence or outage is the honest answer for holds
  // too, so it is reused rather than invented as an empty success.
  const holdsRead: Promise<ReadResult<HoldsPage>> =
    wallet.kind === 'OK' ? fetchHolds(session, wallet.data.id) : Promise.resolve(wallet);

  const [holds, transactions, provider] = await Promise.all([
    holdsRead,
    fetchTransactions(session, query),
    fetchPaymentProvider(session),
  ]);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/wallet" />}
    >
      <WalletScreen
        wallet={wallet}
        holds={holds}
        transactions={transactions}
        provider={provider}
        query={query}
        csrfToken={session.csrfToken}
        submissionId={newSubmissionId()}
      />
    </AppShell>
  );
}
