import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, type KeyObject } from 'node:crypto';
import { RastaError } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { Bid } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import type { BidAccessPurpose } from '../events/events';
import { ProjectAccess } from '../access/access';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import {
  bidOpeningConflictChecksTotal,
  bidOpeningRefusalsTotal,
  tenderTransitionsTotal,
  versionConflictsTotal,
} from '../observability/metrics';
import { decisionInstant, transactionNow } from '../shared/clock';
import { ENV, MEMBERSHIP_SOURCE, TENDER_EVIDENCE_SOURCE, TENDER_KEY_PROVIDER } from '../tokens';
import { BidAccessAudit } from './bid-access-audit';
import { TenderClock } from './tender-clock';
import { TenderOpenRepository, type TenderForOpening } from './tender-open.repository';
import { compareChains } from './chain-agreement';
import type { MembershipSource } from './membership.client';
import { SealingError } from './sealing/errors';
import type { TenderKeyProvider } from './sealing/key-provider';
import {
  openBid,
  privateKeyFromDer,
  type SealedBid,
  type TrustedReceipts,
} from './sealing/sealing';
import {
  trustedReceiptsOf,
  type TenderChain,
  type TenderEvidenceSource,
} from './tender-evidence.client';
import { assertTenderTransition } from './tender.state-machine';
import { bidContentSchema, type BidContent } from './bid.dto';
import type {
  BidAccessLogEntry,
  BidOpeningProposalView,
  BidOpeningProposalWithdrawnView,
  BidsOpenedView,
  ListBidAccessLogQuery,
  OpenedBidView,
  TenderBidsView,
} from './bid-opening.dto';

/** The closed reasons an opening or an owner read is refused for; the metric's label and the 422's code. */
export const OPENING_REFUSALS = [
  'NOT_CLOSED',
  'NOT_OPENED',
  'EVIDENCE_UNAVAILABLE',
  'EVIDENCE_BEHIND',
  'INTEGRITY',
  'CONFLICT_OF_INTEREST',
  'KEY_UNAVAILABLE',
  'PROPOSAL_REQUIRED',
  'SECOND_PERSON_REQUIRED',
  'NO_PROPOSAL',
] as const;
export type OpeningRefusal = (typeof OPENING_REFUSALS)[number];

/** Bids that have been opened: everything past SUBMITTED, except the ones taken back. */
const NOT_OPENED_STATES: readonly string[] = ['SUBMITTED', 'WITHDRAWN'];
const isOpened = (bid: Bid): boolean => !NOT_OPENED_STATES.includes(bid.status);

/** Who proposed, where the proposer belongs now, and every organization the proposer and the approver belong to now. */
interface ApprovalPeople {
  proposedBy: string;
  proposerOrganizationIds: readonly string[];
  organizationIds: readonly string[];
}

/** What a committed opening leaves for the check after it: who, with whom, and the instant it committed. */
interface OpeningFacts {
  tenderId: string;
  owner: string;
  openedAt: Date;
  openedBy: string;
  proposedBy: string | null;
  bidderOrganizationIds: readonly string[];
  /** The database's clock as the last statement of the opening's transaction ran: the commit, to a few microseconds. */
  committedAt: Date;
}

interface Opened {
  view: BidsOpenedView;
  /** Absent when the bids had been opened before: there is nothing new to check. */
  opening?: OpeningFacts;
}

interface Principal {
  organizationId: string;
  actor: string;
  organizationIds: readonly string[];
}

/** The evidence, read and checked: the chain as audit-service holds it, and the receipts made from it. */
interface Evidence {
  chain: TenderChain;
  receipts: TrustedReceipts;
}

/**
 * Opening a tender's bids and the owner's reads of them (ADR-065 § 1, ADR-066 § 2-5).
 *
 * ## When, and on whose word
 *
 * `open-bids` moves a **CLOSED** tender to EVALUATING, and only then. The tender row is
 * locked `FOR UPDATE` (bids share it `FOR SHARE`, the close sweeper takes it `FOR
 * UPDATE`), the decision instant is read from the tender clock **after** the lock, and a
 * tender that is still PUBLISHED — even past its deadline, with the sweeper not yet
 * come — is refused rather than closed here: closing is `TenderCloseService`'s. Once
 * CLOSED no bid can be written (`bid_guard`), so the chain cannot move under the opening.
 *
 * ## The head is not ours to say
 *
 * Whoever can rewrite a bid can rewrite `bid_receipt` with it. So the chain and its head
 * are read from **audit-service** (`TenderEvidenceSource`, a tenant-signed request for
 * the owner's organization and the tender), checked to be a sound chain
 * (`trustedReceiptsOf`), compared link by link with this service's own copy
 * (`compareChains`) and handed to `openBid`, which checks every stored bid against **those**
 * receipts, digest and commitment in constant time. Any failure refuses the whole opening
 * and writes nothing: unreachable (503/504), behind (the newest receipts have not reached
 * audit-service yet — retry), differing, forged. There is no fallback to the local head.
 * The read happens **outside** the transaction and before it takes the lock: it must not
 * hold the tender row while it waits on a network, and CLOSED is stable.
 *
 * ## The key
 *
 * The tender's private key is unwrapped only inside the call that needs it, held as a
 * `KeyObject` for that call, and its DER bytes are zeroised in a `finally`. It is never
 * logged, never in an error, never kept. A read after the opening unwraps it again
 * (ADR-066 § 2): the content is not stored in the clear anywhere.
 *
 * ## Every read is audited
 *
 * Opening writes one granted row (purpose `OPEN_BIDS`) and one `BID_ACCESSED` per bid,
 * in the opening's own transaction; so does every list and every single read. A **refused**
 * request — another tenant's tender, not closed, evidence down, forged — commits a REFUSED
 * row in a transaction of its own before the error is answered. A failed write of a log
 * row fails the read.
 *
 * ## Idempotent
 *
 * Opening a tender whose bids are already open answers the same view with
 * `alreadyOpened`, reads nothing, writes nothing and publishes nothing: two callers, or
 * one retrying, end with one opening and one `BIDS_OPENED`.
 *
 * ## Who
 *
 * The configured roles (`CONSTRUCTION_TENDER_OPEN_ROLES`, by default the owner's own
 * role set); never `SYSTEM_ADMIN`, `AUDITOR` or `CONTRACTOR`, each refused whenever
 * present. A member of **any bidder's** organization is refused on **every** owner route
 * and before any answer that says anything about the bids — the opened view, the counts,
 * the access log (ADR-067 § 4): it limits and grants nothing. "Member" is judged on the
 * token **and** on identity-service as of now (`livePrincipal`, fail closed — a reader who
 * joined a bidding organization after the token was issued is refused), on every route
 * and on a repeat opening too.
 *
 * ## Four eyes (Q-91, provisional)
 *
 * With `CONSTRUCTION_TENDER_OPEN_FOUR_EYES` (default on) opening needs a **proposal** by one
 * authorised user (`proposeOpening`) and the **approval** of a second, who is the caller of
 * `open` and whom the opening is recorded under; neither is a member of a bidding
 * organization. Committee size and roles are the product owner's to confirm.
 *
 * The conflict is judged at the **approval**, on both people as they are *now*: their
 * organizations are read from identity-service (`MembershipSource`, fail closed), not taken
 * from the proposal or only from the approver's token — a proposer who has since joined a
 * bidding organization no longer stands. The proposal itself leaves an access row and
 * `BID_ACCESSED` (`PROPOSE_OPENING`, ids only) in its transaction. A conflicted user is
 * refused **before** anything is said of the tender's state (not closed, not opened). A proposer
 * found conflicted at the approval is refused **and the proposal cleared** (audited, with
 * `BID_OPENING_PROPOSAL_WITHDRAWN`), and a proposer may withdraw their own, so a stuck proposal
 * never blocks the tender: another eligible user proposes afresh.
 *
 * ## The residual, and the detective control
 *
 * No lock spans identity-service and this one: a membership created after the identity read
 * at the approval and before the opening commits is not stopped (ADR-066 § 4). After each
 * commit identity-service is asked who the proposer and the approver were at that instant
 * (`checkOpeningForConflicts`); a bidding organization among them raises an alert and
 * `BID_OPENING_CONFLICT_DETECTED`. The opening stands; a person decides.
 *
 * ## The event is bounded
 *
 * `BIDS_OPENED` carries a count and a digest of the bid ids, never the ids: a tender may
 * have any number of bids and the event must not grow with them. The ids are read through
 * `listBids`.
 */
@Injectable()
export class TenderOpenService {
  private readonly logger = new Logger(TenderOpenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly opens: TenderOpenRepository,
    private readonly audit: BidAccessAudit,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly clock: TenderClock,
    @Inject(TENDER_EVIDENCE_SOURCE) private readonly evidence: TenderEvidenceSource,
    @Inject(TENDER_KEY_PROVIDER) private readonly keys: TenderKeyProvider,
    @Inject(MEMBERSHIP_SOURCE) private readonly memberships: MembershipSource,
  ) {}

  // -- open ---------------------------------------------------------------------

  async open(tenderId: string): Promise<BidsOpenedView> {
    const caller = this.access.assertCanOpenBids();
    const { view, opening } = await this.guarded(caller, tenderId, 'OPEN_BIDS', async (found) => {
      // The caller as they are now (identity-service, fail closed), on a repeat open too.
      const principal = await this.livePrincipal(caller);
      // First: a conflicted user is told nothing of the tender's state, not even that it is not closed.
      await this.assertNotConflicted(principal, tenderId);
      // Outside any transaction and before any lock (see the class header). A tender
      // already open needs no evidence; one that is not closed has none to ask for.
      let evidence: Evidence | undefined;
      let people: ApprovalPeople | undefined;
      if (found.status === 'CLOSED') {
        people = await this.readApprovalPeople(principal, found.openingProposedBy);
        // A proposer who now belongs to a bidder neither stands nor blocks: the proposal is cleared.
        if (people) await this.clearProposalOfConflictedProposer(principal, tenderId, people);
        evidence = await this.readEvidence(principal.organizationId, tenderId);
      } else if (found.openedAt === null) {
        throw this.refused('NOT_CLOSED');
      }
      return withFinancialSpan(
        'construction.bid.open',
        () =>
          this.prisma.transaction((tx) => this.openIn(tx, principal, tenderId, evidence, people)),
        { 'rasta.tender.command': 'open-bids' },
      );
    });
    if (!view.alreadyOpened) {
      tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'open-bids' });
    }
    // After the commit and never in the way of the answer: the detective control (ADR-066 § 4).
    if (opening) await this.checkOpeningForConflicts(opening);
    return view;
  }

  private async openIn(
    tx: ExtendedPrismaClient,
    principal: Principal,
    tenderId: string,
    evidence: Evidence | undefined,
    people: ApprovalPeople | undefined,
  ): Promise<Opened> {
    const locked = await this.opens.lockForOpening(tx, principal.organizationId, tenderId);
    if (!locked) throw RastaError.notFound('Tender', tenderId);

    const bids = await this.opens.listBids(tx, tenderId);
    // Before any answer, the already-opened one included: it says how many bids there were.
    this.assertNoConflict(
      principal.organizationIds,
      bids.map((bid) => bid.bidderOrganizationId),
    );
    if (locked.openedAt !== null && locked.openedBy !== null) {
      return {
        view: openedView(
          locked,
          { at: locked.openedAt, by: locked.openedBy },
          bids.filter(isOpened).length,
          true,
        ),
      };
    }
    if (locked.status !== 'CLOSED') throw this.refused('NOT_CLOSED');
    assertTenderTransition(tenderId, locked.status, 'EVALUATING');

    // After the lock: a long wait for it cannot leave the decision before the close.
    const at = await this.clock.decisionInstant(tx);
    if (!locked.closedAt || !locked.bidClosingAt || at.getTime() < locked.bidClosingAt.getTime()) {
      throw this.refused('NOT_CLOSED');
    }
    // Four eyes (Q-91): this caller approves what another proposed.
    if (this.env.CONSTRUCTION_TENDER_OPEN_FOUR_EYES) {
      if (locked.openingProposedBy === null) throw this.refused('PROPOSAL_REQUIRED');
      if (locked.openingProposedBy === principal.actor)
        throw this.refused('SECOND_PERSON_REQUIRED');
      // Both people as they are NOW, not as they were at the proposal: someone who has since
      // joined a bidding organization neither proposes nor approves. Read before the lock
      // (the proposal never changes once made); no read, or one of another proposer, fails closed.
      if (!people || people.proposedBy !== locked.openingProposedBy) {
        throw RastaError.optimisticLockFailed('Tender', tenderId);
      }
      this.assertNoConflict(
        people.organizationIds,
        bids.map((bid) => bid.bidderOrganizationId),
      );
    }
    // It was PUBLISHED when the evidence was to be read, and has been closed since: ask again.
    if (!evidence) throw RastaError.optimisticLockFailed('Tender', tenderId);

    await this.assertAgrees(tx, tenderId, evidence.chain, bids);

    const standing = bids.filter((bid) => bid.status === 'SUBMITTED');
    // The point of the whole exercise: every standing bid is opened against the evidence
    // and what it says is checked against its commitment. Nothing is kept of the content.
    await this.withPrivateKey(tx, tenderId, standing.length > 0, (privateKey, keyId) => {
      for (const bid of standing) this.openOne(privateKey, keyId, tenderId, bid, evidence.receipts);
    });

    const opened = await this.opens.markBidsOpened(tx, { tenderId, actor: principal.actor, at });
    if (opened !== standing.length) {
      versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Bid' });
      throw RastaError.optimisticLockFailed('Tender', tenderId);
    }
    const matched = await this.opens.openTender(tx, {
      tenderId,
      expectedVersion: locked.version,
      actor: principal.actor,
      at,
    });
    if (matched === 0) {
      versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Tender' });
      throw RastaError.optimisticLockFailed('Tender', tenderId);
    }

    await this.events.enqueue(tx, {
      eventName: 'BIDS_OPENED',
      aggregateId: tenderId,
      organizationId: principal.organizationId,
      payload: {
        tenderId,
        projectId: locked.projectId,
        organizationId: principal.organizationId,
        bidCount: standing.length,
        bidIdsDigest: digestOfIds(standing.map((bid) => bid.id)),
        receiptHead: evidence.chain.head,
        openedAt: at.toISOString(),
        openedBy: principal.actor,
        proposedBy: locked.openingProposedBy,
      },
      occurredAt: at,
    });
    // One row per bid opened; an opening with none still leaves the tender-level row.
    for (const bidId of standing.length > 0 ? standing.map((bid) => bid.id) : [null]) {
      await this.audit.record(tx, {
        owner: principal.organizationId,
        tenderId,
        bidId,
        accessorOrganizationId: principal.organizationId,
        accessorUserId: principal.actor,
        purpose: 'OPEN_BIDS',
        outcome: 'GRANTED',
        at,
      });
    }
    return {
      view: openedView(
        { id: tenderId, status: 'EVALUATING' },
        { at, by: principal.actor },
        standing.length,
        false,
      ),
      opening: {
        tenderId,
        owner: principal.organizationId,
        openedAt: at,
        openedBy: principal.actor,
        proposedBy: locked.openingProposedBy,
        bidderOrganizationIds: [...new Set(bids.map((bid) => bid.bidderOrganizationId))],
        // The last statement of the transaction: the nearest the application can come to its commit.
        committedAt: await decisionInstant(tx),
      },
    };
  }

  /**
   * The first of the two people (four-eyes, Q-91): records that the caller proposes opening
   * a CLOSED tender's bids. The first proposal stands; a second caller is answered with it
   * and may then approve it by calling `open`. Reads and opens nothing.
   */
  async proposeOpening(tenderId: string): Promise<BidOpeningProposalView> {
    const caller = this.access.assertCanOpenBids();
    return this.guarded(caller, tenderId, 'PROPOSE_OPENING', async (found) => {
      const principal = await this.livePrincipal(caller);
      await this.assertNotConflicted(principal, tenderId);
      if (found.status !== 'CLOSED') throw this.refused('NOT_CLOSED');
      return this.prisma.transaction(async (tx) => {
        const locked = await this.opens.lockForOpening(tx, principal.organizationId, tenderId);
        if (!locked) throw RastaError.notFound('Tender', tenderId);
        const bidders = await this.opens.listBidderOrganizationIds(tx, tenderId);
        this.assertNoConflict(principal.organizationIds, bidders);
        const at = await this.clock.decisionInstant(tx);
        if (
          locked.status !== 'CLOSED' ||
          !locked.closedAt ||
          !locked.bidClosingAt ||
          at.getTime() < locked.bidClosingAt.getTime()
        ) {
          throw this.refused('NOT_CLOSED');
        }
        if (locked.openingProposedBy !== null) {
          await this.recordProposal(tx, principal, tenderId, at);
          return { tenderId, proposedBy: locked.openingProposedBy, alreadyProposed: true };
        }
        const matched = await this.opens.proposeOpening(tx, {
          tenderId,
          actor: principal.actor,
          at,
        });
        if (matched === 0) throw RastaError.optimisticLockFailed('Tender', tenderId);
        // The evidence of the proposal, in the transaction that makes it: who proposed what, and when.
        await this.recordProposal(tx, principal, tenderId, at);
        return { tenderId, proposedBy: principal.actor, alreadyProposed: false };
      });
    });
  }

  /**
   * The proposer takes their proposal back (four-eyes, Q-91), so that the opening is not left
   * waiting on a person who cannot or will not follow it: nobody else may withdraw it, and
   * anyone eligible may then propose afresh. Audited like the proposal itself, with its event.
   */
  async withdrawProposal(tenderId: string): Promise<BidOpeningProposalWithdrawnView> {
    const caller = this.access.assertCanOpenBids();
    return this.guarded(caller, tenderId, 'WITHDRAW_PROPOSAL', async () => {
      const principal = await this.livePrincipal(caller);
      await this.assertNotConflicted(principal, tenderId);
      return this.prisma.transaction(async (tx) => {
        const locked = await this.opens.lockForOpening(tx, principal.organizationId, tenderId);
        if (!locked) throw RastaError.notFound('Tender', tenderId);
        if (locked.status !== 'CLOSED' || locked.openedAt !== null)
          throw this.refused('NOT_CLOSED');
        if (locked.openingProposedBy === null) throw this.refused('NO_PROPOSAL');
        if (locked.openingProposedBy !== principal.actor) {
          throw RastaError.forbidden(
            'Only the proposer may withdraw the proposal to open these bids',
          );
        }
        await this.clearProposal(tx, principal, locked, principal.actor, 'WITHDRAWN_BY_PROPOSER');
        return { tenderId, withdrawnProposal: principal.actor };
      });
    });
  }

  // -- the owner's reads ----------------------------------------------------------

  /**
   * The tender's bids as the owner may see them. **Before** the opening: how many and
   * when each was received — not who, not what (ADR-066 § 4), and the key is not
   * touched. **After**: every opened bid with its content, each read audited.
   */
  async listBids(tenderId: string): Promise<TenderBidsView> {
    const caller = this.access.assertCanOpenBids();
    return this.guarded(caller, tenderId, 'LIST_BIDS', async (found) => {
      // Before anything is read or asked of audit-service: who the reader belongs to NOW.
      const principal = await this.livePrincipal(caller);
      await this.assertNotConflicted(principal, tenderId);
      const evidence =
        found.openedAt !== null
          ? await this.readEvidence(principal.organizationId, tenderId)
          : undefined;
      return this.prisma.transaction((tx) =>
        this.readIn(tx, principal, tenderId, evidence, { purpose: 'LIST_BIDS' }).then(
          (result) => result.view,
        ),
      );
    });
  }

  /** One opened bid, with its content. Before the opening there is nothing to read: 422. */
  async getBid(tenderId: string, bidId: string): Promise<OpenedBidView> {
    const caller = this.access.assertCanOpenBids();
    return this.guarded(caller, tenderId, 'READ_BID', async (found) => {
      const principal = await this.livePrincipal(caller);
      await this.assertNotConflicted(principal, tenderId);
      if (found.openedAt === null) throw this.refused('NOT_OPENED');
      const evidence = await this.readEvidence(principal.organizationId, tenderId);
      return this.prisma.transaction(async (tx) => {
        const { view } = await this.readIn(tx, principal, tenderId, evidence, {
          purpose: 'READ_BID',
          bidId,
        });
        const bid = view.bids[0];
        if (!bid) throw RastaError.notFound('Bid', bidId);
        return bid;
      });
    });
  }

  /** The tender's access log, newest first. Reading the log is not a read of a bid and is not itself logged. */
  async listAccessLog(
    tenderId: string,
    query: ListBidAccessLogQuery,
  ): Promise<CursorPage<BidAccessLogEntry>> {
    const caller = this.access.assertCanOpenBids();
    // Another organization's tender is a 404 before anyone is asked who the caller is.
    await this.prisma.transaction(async (tx) => {
      if (!(await this.opens.ownsTender(tx, tenderId)))
        throw RastaError.notFound('Tender', tenderId);
    });
    // Who the caller belongs to NOW (identity-service, fail closed), as on every owner read.
    const principal = await this.livePrincipal(caller);
    const rows = await this.prisma.transaction(async (tx) => {
      if (!(await this.opens.ownsTender(tx, tenderId)))
        throw RastaError.notFound('Tender', tenderId);
      // The log names who read which bid and when: not for a member of a bidder's organization.
      this.assertNoConflict(
        principal.organizationIds,
        await this.opens.listBidderOrganizationIds(tx, tenderId),
      );
      return this.opens.listAccessLog(tx, tenderId, query);
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map((row) => ({
        id: row.id,
        tenderId: row.tenderId,
        bidId: row.bidId,
        accessorOrganizationId: row.accessorOrganizationId,
        accessorUserId: row.accessorUserId,
        purpose: row.purpose as BidAccessLogEntry['purpose'],
        outcome: row.outcome as BidAccessLogEntry['outcome'],
        accessedAt: row.accessedAt.toISOString(),
      })),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  private async readIn(
    tx: ExtendedPrismaClient,
    principal: Principal,
    tenderId: string,
    evidence: Evidence | undefined,
    read: { purpose: 'LIST_BIDS' | 'READ_BID'; bidId?: string },
  ): Promise<{ view: TenderBidsView }> {
    const locked = await this.opens.lockSharedForRead(tx, principal.organizationId, tenderId);
    if (!locked) throw RastaError.notFound('Tender', tenderId);
    const at = await transactionNow(tx);
    const bids = await this.opens.listBids(tx, tenderId);
    const standing = bids.filter((bid) => bid.status === 'SUBMITTED');
    // Before any answer: the counts and receipt times of a bidder's own competitors are not for it.
    this.assertNoConflict(
      principal.organizationIds,
      bids.map((bid) => bid.bidderOrganizationId),
    );

    if (locked.openedAt === null) {
      // Before the opening: a count and the times of receipt. No identity, no content, no key.
      if (read.purpose === 'READ_BID') throw this.refused('NOT_OPENED');
      await this.audit.record(tx, {
        owner: principal.organizationId,
        tenderId,
        bidId: null,
        accessorOrganizationId: principal.organizationId,
        accessorUserId: principal.actor,
        purpose: 'COUNT_BIDS',
        outcome: 'GRANTED',
        at,
      });
      return {
        view: {
          tenderId,
          opened: false,
          bidCount: standing.length,
          receivedAt: standing.map((bid) => bid.receivedAt.toISOString()).sort(),
          bids: [],
        },
      };
    }
    // Opened between the evidence being asked for (none was, the tender was not open) and now.
    if (!evidence) throw RastaError.optimisticLockFailed('Tender', tenderId);

    await this.assertAgrees(tx, tenderId, evidence.chain, bids);

    const readable = bids
      .filter(isOpened)
      .filter((bid) => read.bidId === undefined || bid.id === read.bidId);
    const contents = new Map<string, BidContent>();
    await this.withPrivateKey(tx, tenderId, readable.length > 0, (privateKey, keyId) => {
      for (const bid of readable) {
        contents.set(bid.id, this.openOne(privateKey, keyId, tenderId, bid, evidence.receipts));
      }
    });
    // One row per bid read; a read that finds none still leaves the tender-level row.
    for (const bidId of readable.length > 0 ? readable.map((bid) => bid.id) : [null]) {
      await this.audit.record(tx, {
        owner: principal.organizationId,
        tenderId,
        bidId,
        accessorOrganizationId: principal.organizationId,
        accessorUserId: principal.actor,
        purpose: read.purpose,
        outcome: 'GRANTED',
        at,
      });
    }
    return {
      view: {
        tenderId,
        opened: true,
        bidCount: readable.length,
        receivedAt: [],
        bids: readable.map((bid) => ({
          bidId: bid.id,
          tenderId,
          bidderOrganizationId: bid.bidderOrganizationId,
          status: bid.status,
          revision: bid.revision,
          receivedAt: bid.receivedAt.toISOString(),
          contentCommitment: bid.contentCommitment,
          content: contentOf(contents, bid.id),
        })),
      },
    };
  }

  // -- the audited envelope -----------------------------------------------------------

  /**
   * Finds the tender, tells another organization's from a missing one without telling the
   * caller, runs `work`, and — when it refuses — commits a REFUSED row for the attempt
   * before the error is answered (ADR-066 § 5).
   */
  private async guarded<T>(
    principal: Principal,
    tenderId: string,
    purpose: BidAccessPurpose,
    work: (found: {
      status: string;
      openedAt: Date | null;
      openingProposedBy: string | null;
    }) => Promise<T>,
  ): Promise<T> {
    const found = await this.opens.findOwnership(tenderId);
    if (!found) throw RastaError.notFound('Tender', tenderId);
    if (found.organizationId !== principal.organizationId) {
      // Not theirs: they are told what a missing tender is told, and the owner is told who asked.
      await this.recordRefusal(found.organizationId, tenderId, null, principal, purpose);
      throw RastaError.notFound('Tender', tenderId);
    }
    try {
      return await work(found);
    } catch (error) {
      // No bid id: what the caller named is not stored unless it is a bid (it is not looked up here).
      if (error instanceof RastaError) {
        await this.recordRefusal(found.organizationId, tenderId, null, principal, purpose);
      }
      throw error;
    }
  }

  /** The refusal, in a transaction of its own (the one that refused has rolled back). Best effort: it never replaces the answer. */
  private async recordRefusal(
    owner: string,
    tenderId: string,
    bidId: string | null,
    principal: Principal,
    purpose: BidAccessPurpose,
  ): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        await this.audit.record(tx, {
          owner,
          tenderId,
          bidId,
          accessorOrganizationId: principal.organizationId,
          accessorUserId: principal.actor,
          purpose,
          outcome: 'REFUSED',
          at: await transactionNow(tx),
        });
      });
    } catch (cause) {
      // The log of a refusal is evidence, not the answer: the caller is refused either way.
      this.logger.error(
        `could not record a refused bid read: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }

  // -- the evidence ------------------------------------------------------------------

  /** The chain and head from audit-service, checked to be sound. Fails closed, always. */
  private async readEvidence(ownerOrganizationId: string, tenderId: string): Promise<Evidence> {
    let chain: TenderChain;
    try {
      chain = await this.evidence.fetchChain(ownerOrganizationId, tenderId);
    } catch (error) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'evidence_unavailable' });
      if (error instanceof RastaError) throw error;
      throw RastaError.upstreamUnavailable('audit-service', error);
    }
    try {
      return { chain, receipts: trustedReceiptsOf(chain) };
    } catch (error) {
      throw this.refusalOf(error);
    }
  }

  /** This service's own copy must be the evidence, or nothing is opened. */
  private async assertAgrees(
    tx: ExtendedPrismaClient,
    tenderId: string,
    chain: TenderChain,
    bids: readonly Bid[],
  ): Promise<void> {
    const local = await this.opens.listReceipts(tx, tenderId);
    const verdict = compareChains(
      local,
      chain,
      bids.map((bid) => bid.id),
    );
    if (verdict === 'AGREES') return;
    if (verdict === 'EVIDENCE_BEHIND') {
      // audit-service has not yet heard of the newest receipts: not a forgery, and not ready.
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'evidence_behind' });
      throw RastaError.upstreamUnavailable('audit-service');
    }
    bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'integrity' });
    this.logger.error(
      'the stored receipts of a tender differ from the evidence; nothing was opened',
    );
    throw this.refused('INTEGRITY');
  }

  /** The conflict check before anything is said about the tender's state: the bidders are read on their own. */
  private async assertNotConflicted(principal: Principal, tenderId: string): Promise<void> {
    const bidders = await this.prisma.transaction((tx) =>
      this.opens.listBidderOrganizationIds(tx, tenderId),
    );
    this.assertNoConflict(principal.organizationIds, bidders);
  }

  /**
   * The proposer's and the approver's organizations as identity-service holds them now,
   * read once, outside the transaction. Only when four-eyes applies and a proposal stands.
   * Fails closed: unreachable or malformed refuses the opening (502/504).
   */
  private async readApprovalPeople(
    principal: Principal,
    proposedBy: string | null,
  ): Promise<ApprovalPeople | undefined> {
    if (!this.env.CONSTRUCTION_TENDER_OPEN_FOUR_EYES || proposedBy === null) return undefined;
    // The approver is already read: `principal` is live (identity-service and the token together).
    const proposer = await this.fetchMemberships(proposedBy);
    return {
      proposedBy,
      proposerOrganizationIds: proposer,
      organizationIds: [...new Set([...proposer, ...principal.organizationIds])],
    };
  }

  /** Identity-service's word on whom a user belongs to now; anything less is a refusal, counted (a warning alert). */
  private async fetchMemberships(userId: string): Promise<readonly string[]> {
    try {
      return await this.memberships.fetchOrganizationIds(userId);
    } catch (error) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'identity_unavailable' });
      throw error instanceof RastaError
        ? error
        : RastaError.upstreamUnavailable('identity-service', error);
    }
  }

  /**
   * The caller with the organizations they belong to **now**, as identity-service says, added
   * to what the token says (the stricter of the two): a reader who joined a bidding
   * organization after the token was issued is a member of it here. Every owner-side read of
   * a bid's content or metadata, and every opening, repeat ones included, goes through this.
   */
  private async livePrincipal(principal: Principal): Promise<Principal> {
    const live = await this.fetchMemberships(principal.actor);
    return {
      ...principal,
      organizationIds: [...new Set([...live, ...principal.organizationIds])],
    };
  }

  /**
   * The proposer is a member of a bidding organization now: the approval is refused AND the
   * proposal cleared (audited, with its event), so that another eligible user can propose
   * afresh instead of every approver meeting the same refusal. The clearing commits in its
   * own transaction, before the refusal is answered.
   */
  private async clearProposalOfConflictedProposer(
    principal: Principal,
    tenderId: string,
    people: ApprovalPeople,
  ): Promise<void> {
    const bidders = new Set(
      await this.prisma.transaction((tx) => this.opens.listBidderOrganizationIds(tx, tenderId)),
    );
    if (!people.proposerOrganizationIds.some((organization) => bidders.has(organization))) return;
    await this.prisma.transaction(async (tx) => {
      const locked = await this.opens.lockForOpening(tx, principal.organizationId, tenderId);
      // Another call may have cleared or replaced it already: only this proposer's is cleared.
      if (!locked || locked.openingProposedBy !== people.proposedBy) return;
      await this.clearProposal(tx, principal, locked, people.proposedBy, 'PROPOSER_CONFLICTED');
    });
    bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'conflict_of_interest' });
    throw RastaError.forbidden(
      'The proposal to open these bids was cleared: its proposer is a member of an organization that bid. Another user may propose.',
    );
  }

  /** Clears the proposal in the caller's transaction and leaves its evidence: an access row, BID_ACCESSED and the event. */
  private async clearProposal(
    tx: ExtendedPrismaClient,
    principal: Principal,
    locked: TenderForOpening,
    proposedBy: string,
    reason: 'WITHDRAWN_BY_PROPOSER' | 'PROPOSER_CONFLICTED',
  ): Promise<void> {
    const cleared = await this.opens.clearProposal(tx, { tenderId: locked.id, proposedBy });
    if (cleared === 0) throw RastaError.optimisticLockFailed('Tender', locked.id);
    const at = await transactionNow(tx);
    await this.audit.record(tx, {
      owner: principal.organizationId,
      tenderId: locked.id,
      bidId: null,
      accessorOrganizationId: principal.organizationId,
      accessorUserId: principal.actor,
      purpose: 'WITHDRAW_PROPOSAL',
      outcome: 'GRANTED',
      at,
    });
    await this.events.enqueue(tx, {
      eventName: 'BID_OPENING_PROPOSAL_WITHDRAWN',
      aggregateId: locked.id,
      organizationId: principal.organizationId,
      payload: {
        tenderId: locked.id,
        organizationId: principal.organizationId,
        proposedBy,
        withdrawnBy: principal.actor,
        reason,
        withdrawnAt: at.toISOString(),
      },
      occurredAt: at,
    });
  }

  /**
   * The detective control (ADR-066 § 4, the residual of the conflict check). The decision
   * point of the check is the identity read at the approval; a membership created between that
   * read and the commit of the opening is not stopped. So, after the commit, identity-service
   * is asked whether the proposer or the approver was a member of any bidding organization at
   * the instant it committed; if so, an alert (a counter that pages) and
   * `BID_OPENING_CONFLICT_DETECTED` (ids only) say it. Never in the way of the answer: the
   * opening stands, and a check that could not be made is counted and logged, not retried.
   */
  private async checkOpeningForConflicts(opening: OpeningFacts): Promise<void> {
    const people: { userId: string; role: 'PROPOSER' | 'APPROVER' }[] = [
      { userId: opening.openedBy, role: 'APPROVER' },
      ...(opening.proposedBy !== null && opening.proposedBy !== opening.openedBy
        ? [{ userId: opening.proposedBy, role: 'PROPOSER' as const }]
        : []),
    ];
    const bidders = new Set(opening.bidderOrganizationIds);
    const conflicts: {
      userId: string;
      role: 'PROPOSER' | 'APPROVER';
      organizationIds: string[];
      organizationCount: number;
    }[] = [];
    try {
      for (const person of people) {
        const belonged = await this.memberships.fetchOrganizationIdsAt(
          person.userId,
          opening.committedAt,
        );
        const shared = [...new Set(belonged.filter((organization) => bidders.has(organization)))];
        if (shared.length > 0) {
          conflicts.push({
            userId: person.userId,
            role: person.role,
            organizationIds: [...shared].sort().slice(0, 100),
            organizationCount: shared.length,
          });
        }
      }
    } catch (cause) {
      bidOpeningConflictChecksTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
      this.logger.error(
        `the conflict check after an opening could not be made: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
      return;
    }
    if (conflicts.length === 0) {
      bidOpeningConflictChecksTotal.inc({ service: SERVICE_NAME, outcome: 'clear' });
      return;
    }
    // The alert first: it must fire whatever happens to the event below.
    bidOpeningConflictChecksTotal.inc({ service: SERVICE_NAME, outcome: 'conflict' });
    this.logger.error(
      'a bid opening was made by a member of a bidding organization (detected after the commit)',
    );
    try {
      await this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        await this.events.enqueue(tx, {
          eventName: 'BID_OPENING_CONFLICT_DETECTED',
          aggregateId: opening.tenderId,
          organizationId: opening.owner,
          payload: {
            tenderId: opening.tenderId,
            organizationId: opening.owner,
            openedAt: opening.openedAt.toISOString(),
            openedBy: opening.openedBy,
            proposedBy: opening.proposedBy,
            checkedAt: opening.committedAt.toISOString(),
            conflicts,
          },
          occurredAt: at,
        });
      });
    } catch (cause) {
      this.logger.error(
        `could not record BID_OPENING_CONFLICT_DETECTED: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }

  /** The proposal's evidence: an append-only access row and its event, in the caller's transaction. */
  private async recordProposal(
    tx: ExtendedPrismaClient,
    principal: Principal,
    tenderId: string,
    at: Date,
  ): Promise<void> {
    await this.audit.record(tx, {
      owner: principal.organizationId,
      tenderId,
      bidId: null,
      accessorOrganizationId: principal.organizationId,
      accessorUserId: principal.actor,
      purpose: 'PROPOSE_OPENING',
      outcome: 'GRANTED',
      at,
    });
  }

  /** Refuses a member of any organization that bid (withdrawn bids included) on the tender. */
  private assertNoConflict(
    memberOf: readonly string[],
    bidderOrganizationIds: readonly string[],
  ): void {
    const bidders = new Set(bidderOrganizationIds);
    if (memberOf.some((organization) => bidders.has(organization))) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'conflict_of_interest' });
      throw RastaError.forbidden(
        'A member of an organization that bid on this tender does not open or read its bids',
      );
    }
  }

  // -- the key -----------------------------------------------------------------------

  /**
   * Unwraps the tender's private key for the duration of `use` and no longer: the DER
   * bytes are zeroised in the `finally`, whatever `use` did. `needed` false (no bid to
   * open) never touches the key.
   */
  private async withPrivateKey(
    tx: ExtendedPrismaClient,
    tenderId: string,
    needed: boolean,
    use: (privateKey: KeyObject, keyId: string) => void,
  ): Promise<void> {
    if (!needed) return;
    const key = await this.opens.findKey(tx, tenderId);
    if (!key) throw RastaError.internal('A published tender has no key; its bids cannot be opened');

    let der: Buffer | undefined;
    try {
      der = this.keys.unwrap(
        {
          kekId: key.kekId,
          nonce: Buffer.from(key.wrapNonce),
          ciphertext: Buffer.from(key.wrappedPrivateKey),
          tag: Buffer.from(key.wrapTag),
        },
        { tenderId, keyId: key.keyId },
      );
      use(privateKeyFromDer(der), key.keyId);
    } catch (error) {
      throw this.refusalOf(error);
    } finally {
      der?.fill(0);
    }
  }

  /** One bid, opened against the evidence's receipts and read as the content the bidder sealed. */
  private openOne(
    privateKey: KeyObject,
    keyId: string,
    tenderId: string,
    bid: Bid,
    receipts: TrustedReceipts,
  ): BidContent {
    const sealed: SealedBid = {
      version: bid.sealVersion,
      keyId: bid.keyId,
      nonce: Buffer.from(bid.nonce),
      ciphertext: Buffer.from(bid.ciphertext),
      tag: Buffer.from(bid.tag),
      wrappedContentKey: Buffer.from(bid.wrappedContentKey),
      contentCommitment: bid.contentCommitment,
      ciphertextSha256: bid.ciphertextSha256,
    };
    const opened = openBid({
      privateKey,
      binding: {
        tenderId,
        bidId: bid.id,
        bidderOrganizationId: bid.bidderOrganizationId,
        revision: bid.revision,
        keyId,
      },
      sealed,
      receipts,
    });
    const content = bidContentSchema.safeParse(opened);
    // The commitment held, so this is what was sealed; a shape this service no longer reads is not a bid it can show.
    if (!content.success) throw new SealingError('TAMPERED');
    return content.data;
  }

  // -- errors -------------------------------------------------------------------------

  /** A sealing failure is an integrity refusal (or a missing key); nothing about which part failed is said. */
  private refusalOf(error: unknown): unknown {
    if (!(error instanceof SealingError)) return error;
    if (error.code === 'KEY_UNAVAILABLE') {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'key_unavailable' });
      return RastaError.upstreamUnavailable('tender-key-provider');
    }
    bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'integrity' });
    this.logger.error(`a bid did not verify against its receipt: ${error.code}`);
    return this.refused('INTEGRITY');
  }

  private refused(reason: OpeningRefusal): RastaError {
    if (
      reason === 'NOT_CLOSED' ||
      reason === 'NOT_OPENED' ||
      reason === 'PROPOSAL_REQUIRED' ||
      reason === 'SECOND_PERSON_REQUIRED' ||
      reason === 'NO_PROPOSAL'
    ) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: reason.toLowerCase() });
    }
    return RastaError.businessRule(`Bids are not opened: ${reason}`, { refusals: [reason] });
  }
}

/**
 * The bounded stand-in for a list of ids on `BIDS_OPENED`: SHA-256, hex, of the ids sorted
 * ascending and joined with a newline.
 */
function digestOfIds(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

/** What `openOne` read for a bid; every readable bid was opened before its view is made. */
function contentOf(contents: ReadonlyMap<string, BidContent>, bidId: string): BidContent {
  const content = contents.get(bidId);
  if (!content) throw RastaError.internal('A bid was listed that was not opened');
  return content;
}

function openedView(
  tender: Pick<TenderForOpening, 'id' | 'status'>,
  opening: { at: Date; by: string },
  bidCount: number,
  alreadyOpened: boolean,
): BidsOpenedView {
  return {
    tenderId: tender.id,
    status: tender.status,
    openedAt: opening.at.toISOString(),
    openedBy: opening.by,
    bidCount,
    alreadyOpened,
  };
}
