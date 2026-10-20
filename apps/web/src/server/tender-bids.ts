import { z } from 'zod';

import {
  BID_CODE_TEXT,
  BID_REFUSAL_FALLBACK,
  BID_REFUSAL_TEXT,
  NOTE_FIELD,
  PRICE_FIELD,
  answerField,
  type BidCommand,
} from '@/lib/bid-fields';
import type { BidContent } from '@/lib/bid-input';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import { tokenAuthority } from './realm-roles';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import type { OpenTenderDetail } from './tenders';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * A contractor's own bid on a tender, read and commanded through the gateway
 * (EXP-004; construction-service CON-002 PRs 6–7, ADR-065, ADR-066).
 *
 * ## What is read, and what never is
 *
 * `GET /v1/tenders/{id}/bids/mine` — the caller's organization's receipt,
 * revision and status, **no content**: before the opening nobody reads a
 * bid, the bidder included (ADR-066 § 4). The service audits every call, a
 * refused one too, in the same transaction (`bid_access_log`, BID_ACCESSED),
 * so the page asks only for a caller the service would admit as a bidder.
 * Nothing here reads another bid, a bidder, a count, or the content after
 * the submit: the receipt the service answers is all the portal knows.
 *
 * ## What is sent
 *
 * The content — a price in whole rials as a decimal string (never a number),
 * an answer per criterion, an optional note — is sent once, to be **sealed by
 * the service** to the tender's key; the portal seals nothing and keeps no
 * copy past the request (`lib/unresolved-bid.ts` keeps none at all).
 *
 * ## Who may command — a copy of construction-service, never a rule of our own
 *
 * No bidder view carries the caller's available actions, so the helpers below
 * mirror `ProjectAccess.assertCanBid` and `BidService.decide` from the token
 * the service decides on, and `tender-bids.contract.spec.ts` pins them to the
 * source. They choose what to draw; the service decides again on every
 * request. What the views cannot tell is left to the service and said in
 * fixed words when it refuses: whether supplier-service holds the
 * organization qualified for CONTRACTING right now (`BIDDER_NOT_ELIGIBLE` —
 * asked by the service at that moment, never judged here), the deadline on
 * the database clock (`BID_WINDOW_*`), and the configured limits
 * (`BID_REVISION_LIMIT`, `TENDER_RECEIPT_LIMIT`, `TENDER_BID_LIMIT`). Who is
 * invited is the service's too: the bidder's door (`/v1/open-tenders/{id}`)
 * answers only a tender this organization may bid on.
 */

/** `bidReceiptViewSchema`, all of it: the receipt is the bidder's own proof. */
export const BID_RECEIPT_SCHEMA = z.object({
  bidId: z.string(),
  tenderId: z.string(),
  status: z.string(),
  revision: z.number().int().min(1),
  receivedAt: utcInstant,
  contentCommitment: z.string(),
  receipt: z.string(),
  withdrawnAt: utcInstant.nullable(),
});

export type BidReceipt = z.infer<typeof BID_RECEIPT_SCHEMA>;

const tenderBidsPath = (tenderId: string): string =>
  `/v1/tenders/${encodeURIComponent(tenderId)}/bids`;

/**
 * The caller's own bid on `tenderId`. `NOT_FOUND` is "no bid of this
 * organization" — and, alike, a tender that does not exist.
 */
export async function fetchOwnBid(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<BidReceipt>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: `${tenderBidsPath(tenderId)}/mine`,
      accessToken: session.accessToken,
    });
    const parsed = BID_RECEIPT_SCHEMA.safeParse(response.data);
    if (!parsed.success || parsed.data.tenderId !== tenderId) {
      return { kind: 'MALFORMED', correlationId: response.correlationId };
    }
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

// -- who may bid -------------------------------------------------------------------------

/** construction-service `access.ts`: `CONTRACTOR_ROLE`, `SUPER_ROLE`, `OVERSIGHT_ROLE`. */
export const CONTRACTOR_ROLE = 'CONTRACTOR';
export const PLATFORM_ADMINISTRATOR = 'SYSTEM_ADMIN';
export const OVERSIGHT_ROLE = 'AUDITOR';

/** What `assertCanBid` reads, as the token carries it. Null: not readable — nothing is offered. */
export interface BidderCaller {
  readonly organizationId: string | null;
  readonly roles: readonly string[] | null;
}

export function bidderCallerOf(accessToken: string): BidderCaller {
  const authority = tokenAuthority(accessToken);
  return {
    organizationId: authority?.organizationId ?? null,
    roles: authority?.roles ?? null,
  };
}

/**
 * `ProjectAccess.assertCanBid`, in its order: not the platform administrator
 * and not the oversight role — refused whenever present, alongside
 * `CONTRACTOR` too — then `CONTRACTOR`, and an organization acted for. Its
 * last check, an actor, holds for every signed-in person: the guard sets
 * `userId` from `rasta_uid`, else from the token's subject, and no bid route
 * demands a platform user id. A service caller is a token this portal never
 * holds.
 */
export function canBid(caller: BidderCaller): boolean {
  const { roles } = caller;
  if (roles === null) return false;
  if (roles.includes(PLATFORM_ADMINISTRATOR) || roles.includes(OVERSIGHT_ROLE)) return false;
  if (!roles.includes(CONTRACTOR_ROLE)) return false;
  return caller.organizationId !== null;
}

export type BidWindow = 'NOT_OPEN' | 'OPEN' | 'CLOSED';

/**
 * `BidService.decide`'s window, `[bidOpeningAt, bidClosingAt)`: a bid at the
 * closing instant is late. Judged here on this server's clock only to choose
 * what to draw — the service judges again on the database clock, after the
 * tender lock, and a form drawn near either edge is refused there in fixed
 * words.
 */
export function bidWindowAt(
  tender: Pick<OpenTenderDetail, 'bidOpeningAt' | 'bidClosingAt'>,
  now: number,
): BidWindow {
  if (now < Date.parse(tender.bidOpeningAt)) return 'NOT_OPEN';
  return now < Date.parse(tender.bidClosingAt) ? 'OPEN' : 'CLOSED';
}

/** A command the page may draw, with what its stamp binds. */
export type BidOffer =
  | { readonly command: 'SUBMIT' }
  | {
      readonly command: 'REVISE' | 'WITHDRAW';
      readonly bidId: string;
      readonly expectedRevision: number;
    };

/** Why no form is drawn, when the page has a reason to say. */
export type BidNote = 'NOT_OPEN' | 'CLOSED' | 'UNREAD' | 'REFUSED' | null;

/**
 * What this caller may do on this tender now: the checks the views can show,
 * in the service's order — a bidder at all; the tender visible through the
 * bidder's door (published, not its own, public or invited); the window;
 * then, for a new bid, no bid of this organization yet, and for a
 * replacement or a withdrawal, its bid `SUBMITTED` (`assertRevision`). A bid
 * that could not be read offers nothing: whether one exists is unknown.
 */
export function bidOffers(
  caller: BidderCaller,
  tender: ReadResult<OpenTenderDetail>,
  own: ReadResult<BidReceipt> | null,
  now: number,
): { readonly offers: readonly BidOffer[]; readonly note: BidNote } {
  if (!canBid(caller) || tender.kind !== 'OK' || own === null) return { offers: [], note: null };
  const window = bidWindowAt(tender.data, now);
  if (window !== 'OPEN') return { offers: [], note: window };
  if (own.kind === 'NOT_FOUND') return { offers: [{ command: 'SUBMIT' }], note: null };
  if (own.kind !== 'OK')
    return { offers: [], note: own.kind === 'FORBIDDEN' ? 'REFUSED' : 'UNREAD' };
  if (own.data.status !== 'SUBMITTED') return { offers: [], note: null };
  const bound = { bidId: own.data.bidId, expectedRevision: own.data.revision };
  return {
    offers: [
      { command: 'REVISE', ...bound },
      { command: 'WITHDRAW', ...bound },
    ],
    note: null,
  };
}

// -- the requests ------------------------------------------------------------------------

/** What a command acts on, from the verified stamp — never from the posted form. */
export interface BidBinding {
  readonly command: BidCommand;
  readonly bidId: string | null;
  readonly expectedRevision: number | null;
}

export interface BidRequest {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly body: unknown;
}

/** The request of a command, or null when the binding and the content cannot make one. */
export function bidRequest(
  tenderId: string,
  binding: BidBinding,
  content: BidContent | null,
): BidRequest | null {
  const base = tenderBidsPath(tenderId);
  if (binding.command === 'SUBMIT') {
    if (binding.bidId !== null || binding.expectedRevision !== null || content === null) {
      return null;
    }
    return { method: 'POST', path: base, body: { content } };
  }
  if (binding.bidId === null || binding.expectedRevision === null) return null;
  const bid = `${base}/${encodeURIComponent(binding.bidId)}`;
  if (binding.command === 'REVISE') {
    if (content === null) return null;
    return {
      method: 'PUT',
      path: bid,
      body: { expectedRevision: binding.expectedRevision, content },
    };
  }
  if (content !== null) return null;
  return {
    method: 'POST',
    path: `${bid}/withdraw`,
    body: { expectedRevision: binding.expectedRevision },
  };
}

/**
 * How a refusal is said: by its closed reason, then its platform code, then
 * one fixed sentence. `rows[i]` is the form row of the i-th answer sent, so
 * the service's `content.answers.i.response` lands on that row's field.
 */
export function bidFieldMapping(rows: readonly number[] = []): FieldMapping<string> {
  const paths: Record<string, string> = {
    'content.priceMinor': PRICE_FIELD,
    'content.note': NOTE_FIELD,
  };
  rows.forEach((row, index) => {
    paths[`content.answers.${index}.response`] = answerField(row);
    paths[`content.answers.${index}.criterionCode`] = answerField(row);
  });
  return {
    paths,
    byDetailCode: BID_REFUSAL_TEXT,
    byCode: BID_CODE_TEXT,
    fallback: BID_REFUSAL_FALLBACK,
  };
}

/** The answer a command must show to be confirmed; anything else is unconfirmed. */
function answerSchema(tenderId: string, binding: BidBinding) {
  return BID_RECEIPT_SCHEMA.refine((answer) => {
    if (answer.tenderId !== tenderId) return false;
    if (binding.command === 'SUBMIT') {
      return answer.status === 'SUBMITTED' && answer.revision === 1 && answer.withdrawnAt === null;
    }
    if (answer.bidId !== binding.bidId || binding.expectedRevision === null) return false;
    if (binding.command === 'REVISE') {
      return (
        answer.status === 'SUBMITTED' &&
        answer.revision === binding.expectedRevision + 1 &&
        answer.withdrawnAt === null
      );
    }
    return (
      answer.status === 'WITHDRAWN' &&
      answer.revision === binding.expectedRevision &&
      answer.withdrawnAt !== null
    );
  });
}

export type BidCommandResult = Exclude<WriteResult<BidReceipt, string>, { kind: 'UNAVAILABLE' }>;

/**
 * Sends one command. The `Idempotency-Key` goes on every one — the gateway
 * requires it on every unsafe method under `/v1/tenders`, and a submission is
 * replayed by it (`requiredIdempotencyKey`); a replacement and a withdrawal
 * are guarded by `expectedRevision` instead, so a second send of either is a
 * `409`, never a second effect. Every `UNAVAILABLE` is unconfirmed.
 */
export async function issueBidCommand(
  session: WebSession,
  tenderId: string,
  binding: BidBinding,
  request: BidRequest,
  rows: readonly number[],
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<BidCommandResult> {
  const result = await writeThroughGateway(session, {
    path: request.path,
    method: request.method,
    body: request.body,
    submissionId,
    schema: answerSchema(tenderId, binding),
    mapping: bidFieldMapping(rows),
    fetchImpl,
  });
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}
