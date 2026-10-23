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
  awardOffers,
  awardStepToRead,
  canAward,
  canEvaluate,
  evaluationOffers,
  fetchAward,
  fetchAwardApproval,
  fetchEvaluation,
  isBidSideOnly,
  readsEvaluation,
} from '@/server/tender-evaluation';
import {
  INBOX_CURSOR_PARAM,
  authorityOffers,
  fetchAuthoritySteps,
  inboxCursor,
  type AuthorityNote,
  type AuthorityStep,
} from '@/server/tender-authority';
import {
  canOpenBids,
  decidableStep,
  fetchApproval,
  fetchAwardRequest,
  fetchOwnerBids,
  fetchPublicationRequest,
  openingOnlyOffers,
  ownerCallerOf,
  ownerOffers,
  readsOwnerBids,
  type OwnerOffer,
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
import {
  AuthorityInboxSection,
  AuthorityScreen,
  type AuthorityStepView,
  type InboxWalk,
} from './AuthoritySections';
import { AwardSection, EvaluationSection } from './EvaluationSections';
import { ownerCommandOffers, type OwnerForms } from './owner-offers';
import { OwnerCommands, type OfferedOwnerCommand } from './OwnerCommands';
import {
  OpeningOnlyScreen,
  OpeningSection,
  OwnerBidsSection,
  OwnerFlash,
  PublicationSection,
} from './OwnerSections';
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
  } else if (isBidSideOnly(ownerCallerOf(session.accessToken), webServerEnv())) {
    // An opener or evaluator refused the tender read is given the bid side without it (PR 345 r1, finding 4).
    body = await bidSideOnlyBody(session, id, query);
  } else {
    const result = await fetchTender(session, id);
    const criteria = result.kind === 'OK' ? await fetchTenderCriteria(session, id) : null;
    const owner =
      result.kind === 'OK' ? await ownerSections(session, id, result.data, query, criteria) : null;
    // Refused the tender, which is the owner's own: an authority of another organization may
    // still have a step of it to decide (PR 346 r1, finding 3). Otherwise the same absence.
    const authority =
      result.kind === 'NOT_FOUND' || result.kind === 'FORBIDDEN'
        ? await authorityBody(session, id, query)
        : null;
    body =
      authority ??
      (result.kind === 'OK' ? (
        <OwnTenderDetailScreen result={result} criteria={criteria} owner={owner} />
      ) : (
        <>
          <OwnTenderDetailScreen result={result} criteria={criteria} />
          {sessionRecovery(session, id)}
        </>
      ));
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

/** One inbox step of this tender, with the decisions this person is offered on it. */
interface AuthorityView {
  readonly step: AuthorityStep;
  readonly notes: readonly AuthorityNote[];
  readonly decisions: OfferedOwnerCommand[];
}

interface AuthorityLoad {
  readonly views: readonly AuthorityView[];
  readonly walk: InboxWalk;
  /** A walk from the top whose every page was read, with nothing of this tender in it. */
  readonly nothing: boolean;
}

/**
 * This tender's steps in the caller's approval inbox (`server/tender-authority.ts`),
 * each with its decision forms, and where the walk stands — or null when the
 * inbox is not this person's. A page that could not be read is a `failure`
 * retried from its own cursor, never an absence (PR 346 review 3, finding 2).
 */
async function loadAuthority(
  session: WebSession,
  id: string,
  query: Record<string, string | string[] | undefined>,
): Promise<AuthorityLoad | null> {
  const from = inboxCursor(query[INBOX_CURSOR_PARAM]);
  const steps = await fetchAuthoritySteps(session, id, from);
  if (steps.kind !== 'OK') return null;
  const caller = ownerCallerOf(session.accessToken);
  // One step's forms each, so a step's decisions are drawn under that step alone.
  const views = steps.data.items.map((item) => {
    const { offers, notes } = authorityOffers(caller, item);
    const forms = ownerCommandOffers(session, id, offers);
    return {
      step: item.detail.kind === 'OK' ? item.detail.data : item.summary,
      notes,
      decisions: [...forms.publication, ...forms.award],
    };
  });
  const pageHref = tenderDetailPath(id, 'own');
  const at = (cursor: string | null) =>
    cursor === null
      ? pageHref
      : `${pageHref}&${new URLSearchParams({ [INBOX_CURSOR_PARAM]: cursor })}`;
  const { truncated, resumeFrom, failure } = steps.data;
  return {
    views,
    walk: {
      truncated,
      continueHref: resumeFrom === null ? null : at(resumeFrom),
      restartHref: from === null ? null : pageHref,
      failure:
        failure === null
          ? null
          : { correlationId: failure.correlationId, retryHref: at(failure.at) },
    },
    nothing: views.length === 0 && !truncated && failure === null && from === null,
  };
}

const authoritySubmissionIds = (load: AuthorityLoad | null): string[] =>
  (load?.views ?? []).flatMap(({ decisions }) => decisions.map(({ submission }) => submission.id));

/** The steps as the screens draw them, each with its own group of forms. */
function authorityStepViews(
  session: WebSession,
  id: string,
  views: readonly AuthorityView[],
  pageSubmissionIds: readonly string[],
  firstShowsRestored: boolean,
): AuthorityStepView[] {
  const ownerTag = submissionBinding(session).owner;
  return views.map(({ step, notes, decisions }, index) => ({
    step,
    notes,
    commands: (
      <OwnerCommands
        tenderId={id}
        offered={decisions}
        csrfToken={session.csrfToken}
        owner={ownerTag}
        pageHref={tenderDetailPath(id, 'own')}
        showsRestored={firstShowsRestored && index === 0}
        pageSubmissionIds={pageSubmissionIds}
      />
    ),
  }));
}

/**
 * The page of an authority who may not read the tender: its steps of this
 * tender in its inbox, each read on its own, with the decision forms — or null
 * when the inbox is not this person's, or a completed walk found none, and the
 * page is the absence the tender read showed.
 */
async function authorityBody(
  session: WebSession,
  id: string,
  query: Record<string, string | string[] | undefined>,
): Promise<ReactNode | null> {
  const load = await loadAuthority(session, id, query);
  if (load === null) return null;
  const flash = query[FLASH_PARAM];
  const done = readFlash(session, typeof flash === 'string' ? flash : undefined, id, OWNER_DONE);
  // A decision just made leaves no pending step in the inbox; its confirmation, minted for this
  // session and this tender after the service accepted it, is still shown. An inbox longer than
  // the walk, or one a page of which could not be read, is never an absence: it may hold this
  // tender's step further on (PR 346 reviews 2 and 3). None of it says anything of the tender —
  // the walk is the caller's own inbox.
  if (load.nothing && done === undefined) return null;
  const pageSubmissionIds = authoritySubmissionIds(load);
  return (
    <AuthorityScreen
      tenderId={id}
      {...load.walk}
      flash={
        <>
          <OwnerFlash done={done} />
          {/* No step drawn: a record restored after a reload is still shown, here. */}
          {load.views.length === 0 ? sessionRecovery(session, id) : null}
        </>
      }
      steps={authorityStepViews(session, id, load.views, pageSubmissionIds, true)}
    />
  );
}

/**
 * A bid-side read refused: the tender is not this organization's, or not one the
 * caller's roles reach — and an approval authority of another organization whose
 * role is also an opener's or evaluator's lands here too (PR 346 review 2,
 * finding 2). Its steps of the tender come from its inbox; otherwise the
 * absence the read showed, or its failure as it was.
 */
async function absentOrAuthority(
  session: WebSession,
  id: string,
  query: Record<string, string | string[] | undefined>,
  result: Exclude<ReadResult<TenderDetail>, { readonly kind: 'OK' }>,
): Promise<ReactNode> {
  const authority =
    result.kind === 'NOT_FOUND' || result.kind === 'FORBIDDEN'
      ? await authorityBody(session, id, query)
      : null;
  return (
    authority ?? (
      <>
        <OwnTenderDetailScreen result={result} criteria={null} />
        {sessionRecovery(session, id)}
      </>
    )
  );
}

/**
 * A command of this session on this tender whose answer was lost, restored after
 * a reload where no form of it is drawn (PR 346 review 4): an authority's grant
 * or rejection of its last pending step leaves its inbox empty, and the page is
 * the absence — the record and its set-aside are kept beside it. It is this
 * browser's own record, bound to this session (`submissionBinding`), drawn on
 * the client only once storage is read: the server's page is the same for a
 * tender that exists and one that does not, and says nothing of either.
 */
function sessionRecovery(session: WebSession, tenderId: string): ReactNode {
  return (
    <div className="mt-6">
      <OwnerCommands
        tenderId={tenderId}
        offered={[]}
        csrfToken={session.csrfToken}
        owner={submissionBinding(session).owner}
        pageHref={tenderDetailPath(tenderId, 'own')}
        showsRestored
        pageSubmissionIds={[]}
      />
    </div>
  );
}

/** Every owner form's submission id on the page, all groups'. */
const submissionIdsOf = (forms: OwnerForms): string[] =>
  [...forms.publication, ...forms.opening, ...forms.evaluation, ...forms.award].map(
    ({ submission }) => submission.id,
  );

/**
 * The page of an opener or an evaluator who may not read the tender
 * (`isBidSideOnly`): only what those roles read — `GET …/bids` for an opener,
 * the matrix for an evaluator once the bids are opened, each `404` for another
 * organization's tender or a missing one, exactly as the tender read would —
 * the opening's forms while the bids are not opened, and the evaluators'.
 */
async function bidSideOnlyBody(
  session: WebSession,
  id: string,
  query: Record<string, string | string[] | undefined>,
): Promise<ReactNode> {
  const settings = webServerEnv();
  const caller = ownerCallerOf(session.accessToken);
  const opens = canOpenBids(caller, settings);
  const bids = opens ? await fetchOwnerBids(session, id) : null;
  if (bids !== null && bids.kind !== 'OK') return absentOrAuthority(session, id, query, bids);
  const opened = bids === null || bids.data.opened;
  const matrix =
    canEvaluate(caller, settings) && opened ? await fetchEvaluation(session, id) : null;
  if (
    bids === null &&
    matrix !== null &&
    (matrix.kind === 'NOT_FOUND' || matrix.kind === 'FORBIDDEN')
  ) {
    return absentOrAuthority(session, id, query, matrix);
  }
  const evaluation = evaluationOffers(caller, matrix, settings);
  const forms = ownerCommandOffers(
    session,
    id,
    [...(bids ? openingOnlyOffers(caller, bids, settings) : []), ...evaluation.offers],
    Date.now(),
    { matrix: matrix?.kind === 'OK' ? matrix.data : null, actorId: caller.actorId },
  );
  // Its approval decisions too, whatever its bid-side roles read (PR 346 review 3, finding 1): an
  // opener or evaluator the owner's policy names decides its step here. Reading the matrix makes
  // nobody a participant in the evaluation; if this person took part, the service refuses them
  // the step (`assertMayReadAward`) and the step says so.
  const authority = await loadAuthority(session, id, query);
  const pageSubmissionIds = [...submissionIdsOf(forms), ...authoritySubmissionIds(authority)];
  const flash = query[FLASH_PARAM];
  const done = readFlash(session, typeof flash === 'string' ? flash : undefined, id, OWNER_DONE);
  const group = (offered: OwnerForms['opening'], showsRestored: boolean) => (
    <OwnerCommands
      tenderId={id}
      offered={offered}
      csrfToken={session.csrfToken}
      owner={submissionBinding(session).owner}
      pageHref={tenderDetailPath(id, 'own')}
      showsRestored={showsRestored}
      pageSubmissionIds={pageSubmissionIds}
    />
  );
  return (
    <OpeningOnlyScreen tenderId={id} opens={opens} evaluates={matrix !== null}>
      <OwnerFlash done={done} />
      {bids ? (
        <OpeningSection
          status={null}
          opened={bids.data.opened}
          notes={[]}
          commands={group(forms.opening, matrix === null)}
        />
      ) : null}
      {bids ? <OwnerBidsSection bids={bids} criteria={new Map()} /> : null}
      {matrix ? (
        <EvaluationSection
          matrix={matrix}
          notes={evaluation.notes}
          commands={group(forms.evaluation, true)}
        />
      ) : null}
      {authority ? (
        <AuthorityInboxSection
          {...authority.walk}
          steps={authorityStepViews(
            session,
            id,
            authority.views,
            pageSubmissionIds,
            bids === null && matrix === null,
          )}
        />
      ) : null}
    </OpeningOnlyScreen>
  );
}

/**
 * The owner's sections, read only once the tender itself answered: the
 * publication's newest request while it is a draft, the step this person may
 * decide, the bids for an opener once there can be any, the matrix for an
 * evaluator once they are opened, and — evaluated — the award's newest
 * request, the award step this person decides or executes, and the award once
 * made. Which forms is `ownerOffers`, `evaluationOffers` and `awardOffers`,
 * copies of construction-service's checks.
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
  const awarding = tender.status === 'EVALUATED' || tender.status === 'AWARDED';
  const [publication, bids, matrix, awardRequest] = await Promise.all([
    draft ? fetchPublicationRequest(session, id) : null,
    readsOwnerBids(caller, tender.status, settings) ? fetchOwnerBids(session, id) : null,
    readsEvaluation(caller, tender.status, settings) ? fetchEvaluation(session, id) : null,
    awarding ? fetchAwardRequest(session, id) : null,
  ]);
  const decidable =
    publication?.kind === 'OK' ? decidableStep(caller, publication.data, tender.version) : null;
  const awardStepId =
    awardRequest?.kind === 'OK'
      ? awardStepToRead(caller, tender, awardRequest.data, settings)
      : null;
  const [step, awardStep, award] = await Promise.all([
    decidable ? fetchApproval(session, decidable.approvalId) : null,
    awardStepId ? fetchAwardApproval(session, awardStepId) : null,
    tender.status === 'AWARDED' && canAward(caller, settings) ? fetchAward(session, id) : null,
  ]);
  const { offers, notes } = ownerOffers(
    caller,
    { tender, publication, step, bids },
    settings,
    Date.now(),
  );
  const evaluation = evaluationOffers(caller, matrix, settings);
  const awardSide = awardOffers(
    caller,
    {
      tender,
      completedByCaller: tender.status === 'EVALUATED' && tender.statusChangedByCaller,
      matrix,
      bids,
      request: awardRequest,
      step: awardStep,
    },
    settings,
  );
  const all: OwnerOffer[] = [...offers, ...evaluation.offers, ...awardSide.offers];
  const forms = ownerCommandOffers(session, id, all, Date.now(), {
    matrix: matrix?.kind === 'OK' ? matrix.data : null,
    bids: bids?.kind === 'OK' ? bids.data : null,
    actorId: caller.actorId,
  });
  const flash = query[FLASH_PARAM];
  const done = readFlash(session, typeof flash === 'string' ? flash : undefined, id, OWNER_DONE);

  const pageHref = tenderDetailPath(id, 'own');
  const ownerTag = submissionBinding(session).owner;
  const pageSubmissionIds = submissionIdsOf(forms);
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
  // A record restored after a reload is drawn once: in the furthest section on the page.
  const restoredIn = awarding
    ? 'award'
    : matrix
      ? 'evaluation'
      : openingShown
        ? 'opening'
        : 'publication';
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
          commands={group(forms.publication, restoredIn === 'publication')}
        />
      ) : null}
      {openingShown ? (
        <OpeningSection
          status={tender.status}
          notes={notes.filter((note) => note === 'AWAITING_CLOSE')}
          commands={group(forms.opening, restoredIn === 'opening')}
        />
      ) : null}
      {bids ? <OwnerBidsSection bids={bids} criteria={labels} /> : null}
      {matrix ? (
        <EvaluationSection
          matrix={matrix}
          notes={evaluation.notes}
          commands={group(forms.evaluation, restoredIn === 'evaluation')}
        />
      ) : null}
      {awarding ? (
        <AwardSection
          status={tender.status}
          request={awardRequest}
          step={awardStep}
          award={award}
          notes={awardSide.notes}
          commands={group(forms.award, restoredIn === 'award')}
        />
      ) : null}
    </>
  );
}
