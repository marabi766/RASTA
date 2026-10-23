import { z } from 'zod';

import { isProjectWorkflow } from '@/lib/project-commands';
import type { ProjectStatus } from '@/lib/project-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

export type { ReadResult };

/**
 * Reading civil-works projects through the gateway (EXP-004 slice 1).
 *
 * Read-only: no command is issued from this module, so there is no
 * Idempotency-Key here. Reads follow `orders.ts`.
 *
 * ## What is kept
 *
 * Only what a screen renders. The operating-area polygon is never read — the
 * list view omits it and the detail view's `hasArea` flag says whether one
 * exists — and the actor ids (`createdBy`, `statusChangedBy`, …) are dropped:
 * a React tree is serialized into the page, and an id nobody reads should not
 * travel with it.
 *
 * ## Money
 *
 * `estimatedCostMinor` stays a string end to end (ADR-022) and is only ever
 * formatted, never converted to `number`.
 */

const minorUnits = z.string().regex(/^-?\d+$/, 'amount must be whole minor units');

/**
 * What the list renders and nothing more. Every timestamp is a valid UTC
 * instant (`instant.ts`): a malformed one is a `MALFORMED` outcome, not a
 * render-time exception.
 */
const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  operationType: z.string(),
  locationDescription: z.string(),
  estimatedCostMinor: minorUnits.nullable().default(null),
  status: z.string(),
  statusChangedAt: utcInstant,
});

export type ProjectSummary = z.infer<typeof projectSchema>;

const projectDetailSchema = projectSchema.extend({
  /**
   * Sent back as `expectedVersion` with the next change. Optional on purpose,
   * as an asset's is: a response without it still renders, and offers no
   * command, because nothing could be sent that the service would accept.
   */
  version: z.number().int().min(1).optional(),
  hasArea: z.boolean().default(false),
  statusReason: z.string().nullable().default(null),
  createdAt: utcInstant,
  scopeOfWork: z.string().default(''),
  needsSummary: z
    .object({
      draft: z.number().int(),
      submitted: z.number().int(),
      withdrawn: z.number().int(),
    })
    .nullable()
    .default(null),
});

export type ProjectDetail = z.infer<typeof projectDetailSchema>;

const projectPageSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type ProjectPage = z.infer<typeof projectPageSchema>;

export const PROJECTS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * One step of an approval round (`approvalViewSchema`), as much as a screen
 * renders and an authority's decision needs. The actor ids are dropped, as
 * above.
 */
const approvalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowKey: z.string(),
  round: z.number().int(),
  stepOrder: z.number().int(),
  approvalType: z.string(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  authorityLabel: z.string(),
  status: z.string(),
  requestedAt: utcInstant.nullable().default(null),
  decidedAt: utcInstant.nullable().default(null),
  decisionNumber: z.string().nullable().default(null),
  conditions: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  version: z.number().int().min(1),
  project: z
    .object({
      title: z.string(),
      estimatedCostMinor: minorUnits.nullable().default(null),
    })
    .optional(),
});

export type ProjectApproval = z.infer<typeof approvalSchema>;

/** `GET /v1/projects/{id}/approvals` answers a plain array, in round and step order. */
const approvalsSchema = z.array(approvalSchema);

const inboxSchema = z.object({
  items: z.array(approvalSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type ApprovalInbox = z.infer<typeof inboxSchema>;

/** How many steps of the authority's inbox one page of `/projects` reads. */
export const INBOX_LIMIT = 50;

/**
 * Whether an approval path exists for executing this organization's projects
 * (docs/24 Q-02, Q-70): the platform never approves by default, so with no
 * ACTIVE `project.execution` policy a request for approval is refused. Read from
 * the policies that govern the organization, so the screen can say the system
 * is closed before anyone presses a button.
 */
export type ExecutionPolicy =
  | {
      readonly kind: 'OPEN';
      readonly label: string;
      readonly isSample: boolean;
      readonly steps: readonly { readonly approvalType: string; readonly authorityLabel: string }[];
    }
  | { readonly kind: 'CLOSED' }
  /** The list was cut short before any of this organization's policies appeared. */
  | { readonly kind: 'UNKNOWN' };

const policyPageSchema = z.object({
  items: z.array(
    z.object({
      organizationId: z.string(),
      workflowKey: z.string(),
      status: z.string(),
      label: z.string(),
      isSample: z.boolean().default(false),
      steps: z.array(
        z.object({
          stepOrder: z.number().int(),
          approvalType: z.string(),
          authorityLabel: z.string(),
        }),
      ),
    }),
  ),
  hasMore: z.boolean().default(false),
});

export interface ProjectListQuery {
  readonly status?: ProjectStatus;
  readonly cursor?: string;
}

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
      // construction-service answers 404, never 403, for another organization's
      // project, so its existence is not disclosed. It is rendered as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchProjects(
  session: WebSession,
  query: ProjectListQuery = {},
): Promise<ReadResult<ProjectPage>> {
  const search = new URLSearchParams({ limit: String(PROJECTS_PER_PAGE) });
  if (query.status) search.set('status', query.status);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/projects?${search.toString()}`, projectPageSchema);
}

export function fetchProject(
  session: WebSession,
  projectId: string,
): Promise<ReadResult<ProjectDetail>> {
  return read(session, `/v1/projects/${encodeURIComponent(projectId)}`, projectDetailSchema);
}

export function fetchProjectApprovals(
  session: WebSession,
  projectId: string,
): Promise<ReadResult<ProjectApproval[]>> {
  return read(session, `/v1/projects/${encodeURIComponent(projectId)}/approvals`, approvalsSchema);
}

/**
 * The most pages of the inbox one render follows looking for project steps.
 * The inbox mixes every workflow (a tender's steps are decided on its tender's
 * screen), and the service has no workflow filter on it (`inboxQuerySchema` is
 * strict), so a page of nothing but tender steps says nothing about the next.
 */
export const INBOX_MAX_PAGES = 5;

/**
 * The steps addressed to the organization the person acts for and to one of
 * their roles there, still undecided (`GET /v1/approvals`, PENDING by
 * default). Only the project workflows are kept: a tender's step is decided on
 * its tender's screen.
 *
 * The filter runs here, after the read, so a page may come back with no project
 * step while the service still has more: the next pages are followed
 * (`nextCursor`) until a project step is found, the steps run out, or
 * `INBOX_MAX_PAGES` pages were read. Running out of pages is `hasMore: true`,
 * never an empty inbox: "more may exist" is the honest answer.
 */
export async function fetchApprovalInbox(session: WebSession): Promise<ReadResult<ApprovalInbox>> {
  const items: ApprovalInbox['items'] = [];
  let cursor: string | null = null;
  for (let page = 1; ; page += 1) {
    const search = new URLSearchParams({ status: 'PENDING', limit: String(INBOX_LIMIT) });
    if (cursor) search.set('cursor', cursor);
    const result = await read(session, `/v1/approvals?${search.toString()}`, inboxSchema);
    if (result.kind !== 'OK') {
      // A later page failing after project steps were found still shows them.
      if (items.length > 0)
        return { kind: 'OK', data: { items, nextCursor: cursor, hasMore: true } };
      return result;
    }
    items.push(...result.data.items.filter((step) => isProjectWorkflow(step.workflowKey)));
    if (!result.data.hasMore)
      return { kind: 'OK', data: { items, nextCursor: null, hasMore: false } };
    cursor = result.data.nextCursor;
    // More exists; with no cursor it cannot be followed, which is still "more may exist".
    if (cursor === null || items.length > 0 || page >= INBOX_MAX_PAGES) {
      return { kind: 'OK', data: { items, nextCursor: cursor, hasMore: true } };
    }
  }
}

/**
 * `OPEN` when an ACTIVE `project.execution` policy governs the organization,
 * `CLOSED` when the policies were read and there is none. A refusal or an
 * outage is returned as itself, never as `CLOSED`: not being able to read the
 * policy is not the same as there being none. The list also holds policies an
 * administrator wrote for other organizations, so only this one's are kept; a
 * page that was cut short with none of them found is unknown too.
 */
export async function fetchExecutionPolicy(
  session: WebSession,
): Promise<ReadResult<ExecutionPolicy>> {
  const organizationId = session.organizationId;
  if (!organizationId) return { kind: 'NOT_FOUND' };

  const result = await read(
    session,
    '/v1/approval-policies?workflowKey=project.execution&status=ACTIVE&limit=100',
    policyPageSchema,
  );
  if (result.kind !== 'OK') return result;

  const mine = result.data.items.find(
    (policy) =>
      policy.organizationId === organizationId &&
      policy.workflowKey === 'project.execution' &&
      policy.status === 'ACTIVE',
  );
  if (mine) {
    return {
      kind: 'OK',
      data: {
        kind: 'OPEN',
        label: mine.label,
        isSample: mine.isSample,
        steps: [...mine.steps]
          .sort((a, b) => a.stepOrder - b.stepOrder)
          .map(({ approvalType, authorityLabel }) => ({ approvalType, authorityLabel })),
      },
    };
  }
  if (result.data.hasMore) return { kind: 'OK', data: { kind: 'UNKNOWN' } };
  return { kind: 'OK', data: { kind: 'CLOSED' } };
}
