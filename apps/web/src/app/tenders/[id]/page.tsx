import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { BID_COMMANDS } from '@/lib/bid-fields';
import { OWNER_DONE } from '@/lib/tender-owner-fields';
import { FLASH_PARAM } from '@/lib/form-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { safeReturnTo } from '@/server/login-attempt';
import { tenderDoorsFor } from '@/server/portal-nav';
import { tokenRoles } from '@/server/realm-roles';
import { submissionBinding } from '@/server/submission';
import { bidderCallerOf, canBid, fetchOwnBid } from '@/server/tender-bids';
import {
  canOpenBids,
  decidableStep,
  fetchApproval,
  fetchOwnerBids,
  fetchPublicationRequest,
  ownerCallerOf,
  ownerOffers,
  readsOwnerBids,
} from '@/server/tender-owner';
import {
  fetchOpenTender,
  fetchTender,
  fetchTenderCriteria,
  type ReadResult,
  type TenderCriteria,
  type TenderDetail,
} from '@/server/tenders';
import type { WebSession } from '@/server/session';
import { tenderDetailPath } from '@/lib/tender-fields';
import { PortalSidebar } from '@/app/PortalSidebar';

import { BidCommands } from './BidCommands';
import { bidCommandOffers } from './bid-offers';
import { ownerCommandOffers } from './owner-offers';
import { OwnerCommands } from './OwnerCommands';
import { OpeningSection, OwnerBidsSection, OwnerFlash, PublicationSection } from './OwnerSections';
import { OpenTenderDetailScreen, OwnBidSection, OwnTenderDetailScreen } from './TenderDetailScreen';

/**
 * The `/tenders/[id]` route — جزئیات مناقصه (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No access decision here.** A tender has two doors — the owner's
 * (`/v1/tenders/{id}`) and the bidder's (`/v1/open-tenders/{id}`) — and the
 * address says which one a link meant (`?view=open` from the bidder's list). A
 * bare address takes the owner's door, or the bidder's for somebody who is only
 * a bidder — by the access token's own roles (`tokenRoles`); a token whose
 * roles cannot be read is no bidder, so takes the owner's door. Whether this caller may see the tender is construction-service's
 * answer, against the record: one it will not show is `404` and is rendered as
 * absent.
 *
 * On the bidder's door the organization's **own** bid is read too
 * (`…/bids/mine`: receipt and status, never content), but only for a caller
 * construction-service would admit as a bidder (`canBid`, a copy of
 * `assertCanBid`): the service audits every such read. The forms are the ones
 * `bidOffers` says the service would accept now; it decides again on every
 * request. No other bid is ever asked for.
 */
export const dynamic = 'force-dynamic';

export default async function TenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const requested = query.view;
  const session = await currentSession();
  if (!session) {
    redirect(
      `/login?returnTo=${encodeURIComponent(safeReturnTo(tenderDetailPath(id, requested)))}`,
    );
  }

  // From the token's own roles, the set construction-service decides on.
  const doors = tenderDoorsFor(tokenRoles(session.accessToken) ?? [], webServerEnv());
  const open = requested === 'open' || (requested !== 'own' && !doors.own);

  let body: ReactNode;
  if (open) {
    const caller = bidderCallerOf(session.accessToken);
    const bidder = canBid(caller);
    const [result, own] = await Promise.all([
      fetchOpenTender(session, id),
      bidder ? fetchOwnBid(session, id) : null,
    ]);
    const flash = query[FLASH_PARAM];
    const done = readFlash(
      session,
      typeof flash === 'string' ? flash : undefined,
      id,
      BID_COMMANDS,
    );
    const { offered, note } = bidCommandOffers(session, caller, id, result, own);
    const pageHref = tenderDetailPath(id, 'open');
    // A tender behind the bidder's door, or a bid of this organization on one
    // that no longer is: otherwise the absence says all there is.
    const ownBid =
      own !== null && (result.kind === 'OK' || own.kind === 'OK') ? (
        <OwnBidSection
          bid={own}
          note={note}
          done={done}
          commands={
            <BidCommands
              tenderId={id}
              offered={offered}
              criteria={
                result.kind === 'OK'
                  ? result.data.criteria.map(({ code, label }) => ({ code, label }))
                  : []
              }
              csrfToken={session.csrfToken}
              owner={submissionBinding(session).owner}
              pageHref={pageHref}
            />
          }
        />
      ) : null;
    body = <OpenTenderDetailScreen result={result} ownBid={ownBid} />;
  } else {
    const result = await fetchTender(session, id);
    const criteria = result.kind === 'OK' ? await fetchTenderCriteria(session, id) : null;
    const owner =
      result.kind === 'OK' ? await ownerSections(session, id, result.data, query, criteria) : null;
    body = <OwnTenderDetailScreen result={result} criteria={criteria} owner={owner} />;
  }

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
      sidebar={<PortalSidebar session={session} currentHref="/tenders" />}
    >
      <PageHeader
        title="جزئیات مناقصه"
        description="مشخصات مناقصه، بازهٔ پذیرش پیشنهاد و معیارها."
      />
      <div className="mt-2">
        <ButtonLink href="/tenders" tone="quiet">
          بازگشت به فهرست مناقصه‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">{body}</div>
    </AppShell>
  );
}

/**
 * The owner's sections, read only once the tender itself answered: the
 * publication's newest request while it is a draft, the step this person may
 * decide, and the bids for an opener once there can be any. Which forms is
 * `ownerOffers`, a copy of construction-service's checks.
 */
async function ownerSections(
  session: WebSession,
  id: string,
  tender: TenderDetail,
  query: Record<string, string | string[] | undefined>,
  criteria: ReadResult<TenderCriteria> | null,
): Promise<ReactNode> {
  const settings = webServerEnv();
  const caller = ownerCallerOf(session.accessToken);
  const draft = tender.status === 'DRAFT';
  const [publication, bids] = await Promise.all([
    draft ? fetchPublicationRequest(session, id) : null,
    readsOwnerBids(caller, tender.status, settings) ? fetchOwnerBids(session, id) : null,
  ]);
  const decidable = publication?.kind === 'OK' ? decidableStep(caller, publication.data) : null;
  const step = decidable ? await fetchApproval(session, decidable.approvalId) : null;
  const { offers, notes } = ownerOffers(
    caller,
    { tender, publication, step },
    settings,
    Date.now(),
  );
  const forms = ownerCommandOffers(session, id, offers);
  const flash = query[FLASH_PARAM];
  const done = readFlash(session, typeof flash === 'string' ? flash : undefined, id, OWNER_DONE);

  const pageHref = tenderDetailPath(id, 'own');
  const ownerTag = submissionBinding(session).owner;
  const pageSubmissionIds = [...forms.publication, ...forms.opening].map(
    ({ submission }) => submission.id,
  );
  const group = (offered: typeof forms.publication, showsRestored: boolean) => (
    <OwnerCommands
      tenderId={id}
      offered={offered}
      csrfToken={session.csrfToken}
      owner={ownerTag}
      pageHref={pageHref}
      showsRestored={showsRestored}
      pageSubmissionIds={pageSubmissionIds}
    />
  );
  const openingShown = !draft && tender.status !== 'CANCELLED' && canOpenBids(caller, settings);
  const labels = new Map(
    criteria?.kind === 'OK' ? criteria.data.items.map((item) => [item.code, item.label]) : [],
  );

  return (
    <>
      <OwnerFlash done={done} />
      {draft ? (
        <PublicationSection
          request={publication}
          notes={notes.filter((note) => note !== 'AWAITING_CLOSE')}
          commands={group(forms.publication, true)}
        />
      ) : null}
      {openingShown ? (
        <OpeningSection
          status={tender.status}
          notes={notes.filter((note) => note === 'AWAITING_CLOSE')}
          commands={group(forms.opening, true)}
        />
      ) : null}
      {bids ? <OwnerBidsSection bids={bids} criteria={labels} /> : null}
    </>
  );
}
