import { z } from 'zod';

import type { ReadResult } from './assets';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import { mayDecideAward } from './tender-evaluation';
import {
  AWARD_WORKFLOW,
  OVERSIGHT_ROLE,
  PUBLICATION_WORKFLOW,
  readOwnerView,
  type OwnerCaller,
  type OwnerOffer,
} from './tender-owner';

/**
 * A tender approval decided by an authority of **another organization** (PR 346
 * review 1, finding 3): a publication or award policy may name any
 * organization's role, and that authority cannot read the owner's tender —
 * `GET /v1/tenders/{id}` is the owner's own, a `404` to everyone else, and stays
 * so. Its steps reach it the way construction-service gives them to an
 * authority, on their own path:
 *
 * - `GET /v1/approvals?status=PENDING` — the authority's inbox: the steps
 *   addressed to the organization the caller acts for and to one of its roles
 *   there (`inboxScope`, never `AUDITOR`), newest first. The page keeps those of
 *   this tender.
 * - `GET /v1/approvals/{id}` — each step for its version and, for an award, the
 *   bid and justification its request names, read under the rules of deciding
 *   it (`assertMayReadAward`): its refusal is the service's own answer to "may
 *   this person decide it".
 *
 * The decision is `POST /v1/approvals/{id}/decision`, the owner's decision form
 * and action unchanged. Nothing of the tender is read, and an approval is shown
 * only as the service shows it to its authority: the project's title, the
 * step, the request, and — for an award — the bid it names.
 */

/** The page's query parameter that resumes the walk through the inbox. */
export const INBOX_CURSOR_PARAM = 'inbox';

/** How many pages of the inbox are looked through for one tender's steps. */
export const INBOX_PAGES = 5;
/** `MAX_PAGE_SIZE`. */
export const INBOX_PAGE_SIZE = 200;

const TENDER_WORKFLOWS: readonly string[] = [PUBLICATION_WORKFLOW, AWARD_WORKFLOW];

/** `approvalViewSchema`, as much as an authority's decision shows. */
export const AUTHORITY_STEP_SCHEMA = z.object({
  id: z.string(),
  tenderId: z.string().nullable(),
  workflowKey: z.string(),
  stepOrder: z.number().int(),
  status: z.string(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  authorityLabel: z.string(),
  requestedAt: utcInstant.nullable(),
  version: z.number().int().min(1),
  project: z.object({ title: z.string() }),
  request: z
    .object({
      requestId: z.string(),
      tenderVersion: z.number().int(),
      status: z.string(),
      procurementThresholdWarning: z.literal('PROCUREMENT_AMOUNT_OUTSIDE_RANGE').optional(),
      requestedBy: z.string(),
      bid: z
        .object({
          bidId: z.string(),
          bidderOrganizationId: z.string(),
          rank: z.number().int(),
          tied: z.boolean(),
          justification: z.string().nullable(),
          standingVerdict: z.string(),
          standingAsOf: utcInstant,
        })
        .nullable(),
    })
    .nullable(),
});

export type AuthorityStep = z.infer<typeof AUTHORITY_STEP_SCHEMA>;

const inboxPageSchema = z.object({
  items: z.array(AUTHORITY_STEP_SCHEMA),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

/** One step of this tender in the inbox, and its own read for the decision. */
export interface AuthorityItem {
  readonly summary: AuthorityStep;
  readonly detail: ReadResult<AuthorityStep>;
}

export interface AuthoritySteps {
  readonly items: readonly AuthorityItem[];
  /**
   * The inbox was longer than the pages looked through: a step of this tender may be further on,
   * from `resumeFrom` (PR 346 review 2, finding 3 — the inbox has no tender filter).
   */
  readonly truncated: boolean;
  /** Where the next walk starts, when `truncated`: the service's own cursor. */
  readonly resumeFrom: string | null;
  /**
   * A page of the inbox could not be read (PR 346 review 3, finding 2): the walk stopped there,
   * the steps found before it are kept, and it is retried from the cursor of the page that failed
   * (`at`, null for the top). The search is not complete, so it is never an absence.
   */
  readonly failure: AuthorityInboxFailure | null;
}

export interface AuthorityInboxFailure {
  /** The service's correlation id for the failed read, when it gave one. */
  readonly correlationId: string | null;
  /** The cursor of the page that failed: where a retry starts (null: the top). */
  readonly at: string | null;
}

/**
 * A cursor the page was given back to resume from (`INBOX_CURSOR_PARAM`): the
 * service's own opaque token, at most `cursorPaginationSchema`'s 512
 * characters, printable and without spaces; anything else starts from the top.
 */
export function inboxCursor(value: unknown): string | null {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null;
}

/**
 * This tender's pending publication and award steps in the caller's inbox,
 * each read on its own; `OK` with no items when the inbox holds none. At most
 * `INBOX_PAGES` pages from `from` (the top when null): a longer inbox is
 * `truncated`, and the walk resumes from `resumeFrom`. Only a refusal of the
 * first page — the inbox is not this person's (`AUDITOR`, no role) — is the
 * read's own outcome; any other page that cannot be read ends the walk with a
 * `failure`, keeping what was found before it.
 */
export async function fetchAuthoritySteps(
  session: WebSession,
  tenderId: string,
  from: string | null = null,
): Promise<ReadResult<AuthoritySteps>> {
  const found: AuthorityStep[] = [];
  let cursor: string | null = from;
  let resumeFrom: string | null = null;
  let failure: AuthorityInboxFailure | null = null;
  for (let page = 0; page < INBOX_PAGES; page += 1) {
    const search = new URLSearchParams({ status: 'PENDING', limit: String(INBOX_PAGE_SIZE) });
    if (cursor !== null) search.set('cursor', cursor);
    const read = await readOwnerView(session, `/v1/approvals?${search}`, inboxPageSchema);
    if (read.kind !== 'OK') {
      if (page === 0 && (read.kind === 'FORBIDDEN' || read.kind === 'NOT_FOUND')) return read;
      failure = {
        correlationId:
          read.kind === 'UNAVAILABLE' || read.kind === 'MALFORMED'
            ? read.correlationId || null
            : null,
        at: cursor,
      };
      break;
    }
    for (const step of read.data.items) {
      if (step.tenderId === tenderId && TENDER_WORKFLOWS.includes(step.workflowKey)) {
        found.push(step);
      }
    }
    if (!read.data.hasMore || read.data.nextCursor === null) break;
    cursor = read.data.nextCursor;
    if (page === INBOX_PAGES - 1) resumeFrom = cursor;
  }
  const truncated = resumeFrom !== null;
  const items: AuthorityItem[] = [];
  for (const summary of found) {
    const detail = await readOwnerView(
      session,
      `/v1/approvals/${encodeURIComponent(summary.id)}`,
      AUTHORITY_STEP_SCHEMA,
    );
    const same =
      detail.kind !== 'OK' ||
      (detail.data.id === summary.id &&
        detail.data.tenderId === tenderId &&
        detail.data.workflowKey === summary.workflowKey);
    items.push({ summary, detail: same ? detail : { kind: 'MALFORMED', correlationId: '' } });
  }
  return { kind: 'OK', data: { items, truncated, resumeFrom, failure } };
}

export type AuthorityNote =
  /** The service would not show this person the step: it would refuse the decision too. */
  | 'STEP_REFUSED'
  /** The step could not be read for its version. */
  | 'STEP_UNREAD'
  /** This person made the request: the grant is someone else's, the rejection theirs. */
  | 'OWN_REQUEST'
  /** No longer pending, or not this person's to decide as the step now reads. */
  | 'NOT_DECIDABLE';

/**
 * The decisions on one inbox step, the checks in the services' order as far as
 * the step shows them: still `PENDING`, its request still `PENDING`, the
 * caller acting for the step's organization with its exact role (no override;
 * `SYSTEM_ADMIN` only if the policy named it), not `AUDITOR`; for an award also
 * none of the bid side's excluded roles (`assertMayDecideAward`). Reject
 * always, grant only if they did not make the request (`assertDistinctActors`).
 * Whether the request still stands on the tender's version, the step does not
 * say: a decision on a request the tender has moved past ends it `STALE`, and
 * the service says so in fixed words.
 */
export function authorityOffers(
  caller: OwnerCaller,
  item: AuthorityItem,
): { readonly offers: readonly OwnerOffer[]; readonly notes: readonly AuthorityNote[] } {
  const { detail } = item;
  if (detail.kind === 'FORBIDDEN' || detail.kind === 'NOT_FOUND') {
    return { offers: [], notes: ['STEP_REFUSED'] };
  }
  if (detail.kind !== 'OK') return { offers: [], notes: ['STEP_UNREAD'] };
  const step = detail.data;
  const award = step.workflowKey === AWARD_WORKFLOW;
  const { roles, organizationId } = caller;
  const decidable =
    step.status === 'PENDING' &&
    step.request?.status === 'PENDING' &&
    roles !== null &&
    organizationId === step.authorityOrganizationId &&
    !roles.includes(OVERSIGHT_ROLE) &&
    roles.includes(step.authorityRole) &&
    (!award || mayDecideAward(caller));
  if (!decidable || step.request === null) return { offers: [], notes: ['NOT_DECIDABLE'] };
  const grants = caller.actorId !== null && step.request.requestedBy !== caller.actorId;
  const commands = award
    ? grants
      ? (['GRANT_AWARD', 'REJECT_AWARD'] as const)
      : (['REJECT_AWARD'] as const)
    : grants
      ? (['GRANT', 'REJECT'] as const)
      : (['REJECT'] as const);
  return {
    offers: commands.map((command) => ({
      command,
      approvalId: step.id,
      expectedVersion: step.version,
    })),
    notes: grants ? [] : ['OWN_REQUEST'],
  };
}
