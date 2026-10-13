import { z } from 'zod';

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
