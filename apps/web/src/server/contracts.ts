import { z } from 'zod';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { renderableDate, utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

export type { ReadResult };

/**
 * Reading contracts, amendments and milestones through the gateway (EXP-004
 * slice 4, ADR-068).
 *
 * Read-only: no command is issued from this module, so there is no
 * Idempotency-Key. Signing, cancelling, proposing and signing an amendment and
 * planning and changing a milestone are `contract-commands.ts`, which confirms
 * each answer against the schemas exported here. Reads follow `projects.ts`
 * and `tenders.ts`.
 *
 * ## Access (ADR-068 § 7)
 *
 * `GET /v1/contracts` already returns a caller's contracts on whichever side
 * it is a party to — the employer's organization or the winning contractor's
 * — so, unlike tenders, there is only one list and one detail route: no
 * `?view=` is needed here. Another organization's contract, or one that does
 * not exist, both answer `404`, never `403` (S-03); that is rendered as
 * `NOT_FOUND`, the same outcome for both, so an id cannot be used to learn
 * what another organization holds.
 *
 * ## Money
 *
 * `amountMinor`, `amendmentsTotalMinor`, `currentAmountMinor` and
 * `deltaMinor` stay decimal strings end to end (CLAUDE.md, ADR-022) and are
 * only ever formatted, never converted to `number`.
 *
 * ## Statements
 *
 * Not read here: `contract-statements.ts` reads and commands them. The
 * milestone field `referenced` — whether a statement already refers to it —
 * is shown as given.
 */

const minorUnits = z.string().regex(/^-?\d+$/, 'amount must be whole minor units');

function pageSchema<S extends z.ZodTypeAny>(item: S) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}

/** What the contract list renders. Timestamps are valid UTC instants (`instant.ts`). */
const contractSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  contractorOrganizationId: z.string(),
  tenderId: z.string(),
  projectId: z.string(),
  status: z.string(),
  amountMinor: minorUnits,
  currentAmountMinor: minorUnits,
  awardedAt: utcInstant,
  statusChangedAt: utcInstant,
});

export type ContractSummary = z.infer<typeof contractSummarySchema>;

/** Every signature fact lives on the contract itself; there is no separate signature route. */
export const CONTRACT_DETAIL_SCHEMA = contractSummarySchema.extend({
  winningBidId: z.string(),
  amendmentsTotalMinor: minorUnits,
  employerSignedAt: utcInstant.nullable(),
  contractorSignedAt: utcInstant.nullable(),
  authorityReviewRequired: z.boolean(),
  authorityReviewReason: z.literal('AUTHORITY_CHANGED_DURING_SIGNING').nullable(),
  cancelReasonCode: z.string().nullable(),
  cancelNote: z.string().nullable(),
  createdAt: utcInstant,
  updatedAt: utcInstant,
  version: z.number().int(),
});

export type ContractDetail = z.infer<typeof CONTRACT_DETAIL_SCHEMA>;

const contractPageSchema = pageSchema(contractSummarySchema);
export type ContractPage = z.infer<typeof contractPageSchema>;

/** An amendment's signature facts, like the contract's own. */
export const AMENDMENT_SCHEMA = z.object({
  id: z.string(),
  contractId: z.string(),
  organizationId: z.string(),
  amendmentNumber: z.number().int(),
  deltaMinor: minorUnits,
  reasonCode: z.string(),
  reasonText: z.string(),
  status: z.string(),
  employerSignedAt: utcInstant.nullable(),
  contractorSignedAt: utcInstant.nullable(),
  authorityReviewRequired: z.boolean(),
  proposedAt: utcInstant,
  effectiveAt: utcInstant.nullable(),
  updatedAt: utcInstant,
  version: z.number().int(),
});

export type Amendment = z.infer<typeof AMENDMENT_SCHEMA>;

const amendmentPageSchema = pageSchema(AMENDMENT_SCHEMA);
export type AmendmentPage = z.infer<typeof amendmentPageSchema>;

/**
 * A planned milestone. `plannedDate` is a calendar day (`YYYY-MM-DD`), never
 * an instant (`milestone/dto.ts`'s own words) — read with `renderableDate`,
 * not `utcInstant`, and displayed with the same Jalali formatter as any other
 * date; Tehran is always ahead of UTC, so a date-only midnight never renders
 * as the previous day.
 */
export const MILESTONE_SCHEMA = z.object({
  id: z.string(),
  contractId: z.string(),
  organizationId: z.string(),
  title: z.string(),
  plannedDate: renderableDate,
  plannedShareBp: z.number().int().nullable(),
  referenced: z.boolean(),
  createdAt: utcInstant,
  updatedAt: utcInstant,
  version: z.number().int(),
});

export type Milestone = z.infer<typeof MILESTONE_SCHEMA>;

const milestonePageSchema = pageSchema(MILESTONE_SCHEMA);
export type MilestonePage = z.infer<typeof milestonePageSchema>;

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      // contract-service answers 404, never 403, for another organization's
      // contract, so its existence is not disclosed. It is rendered as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export const CONTRACTS_PER_PAGE = 20;
export const AMENDMENTS_PER_PAGE = 20;

export interface ContractListQuery {
  readonly status?: string;
  readonly cursor?: string;
}

export function fetchContracts(
  session: WebSession,
  query: ContractListQuery = {},
): Promise<ReadResult<ContractPage>> {
  const search = new URLSearchParams({ limit: String(CONTRACTS_PER_PAGE) });
  if (query.status) search.set('status', query.status);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/contracts?${search.toString()}`, contractPageSchema);
}

export function fetchContract(
  session: WebSession,
  contractId: string,
): Promise<ReadResult<ContractDetail>> {
  return read(session, `/v1/contracts/${encodeURIComponent(contractId)}`, CONTRACT_DETAIL_SCHEMA);
}

/** A contract's amendments, oldest first (amendment-service orders by `amendmentNumber`). */
export function fetchAmendments(
  session: WebSession,
  contractId: string,
  cursor?: string,
): Promise<ReadResult<AmendmentPage>> {
  const search = new URLSearchParams({ limit: String(AMENDMENTS_PER_PAGE) });
  if (cursor) search.set('cursor', cursor);
  return read(
    session,
    `/v1/contracts/${encodeURIComponent(contractId)}/amendments?${search.toString()}`,
    amendmentPageSchema,
  );
}

/**
 * A contract's planned milestones, by planned day. The route takes no cursor
 * (`milestone.controller.ts` — `list(id)` alone): the service caps a
 * contract's milestones at `CONTRACT_MILESTONE_LIMIT` (default 100) and
 * returns all of them in one answer, so there is nothing here to page.
 */
export function fetchMilestones(
  session: WebSession,
  contractId: string,
): Promise<ReadResult<MilestonePage>> {
  return read(
    session,
    `/v1/contracts/${encodeURIComponent(contractId)}/milestones`,
    milestonePageSchema,
  );
}
