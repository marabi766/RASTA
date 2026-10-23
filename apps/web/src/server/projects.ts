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
 * The steps addressed to the organization the person acts for and to one of
 * their roles there, still undecided (`GET /v1/approvals`, PENDING by
 * default). Only the project workflows are kept: a tender's step is decided on
 * its tender's screen.
 */
export async function fetchApprovalInbox(session: WebSession): Promise<ReadResult<ApprovalInbox>> {
  const result = await read(
    session,
    `/v1/approvals?status=PENDING&limit=${INBOX_LIMIT}`,
    inboxSchema,
  );
  if (result.kind !== 'OK') return result;
  return {
    kind: 'OK',
    data: {
      ...result.data,
      items: result.data.items.filter((step) => isProjectWorkflow(step.workflowKey)),
    },
  };
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
