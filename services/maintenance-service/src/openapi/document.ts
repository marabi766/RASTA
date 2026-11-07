import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import {
  applyOperationSecurity,
  routeAccessByOperation,
  toJsonSchema,
  type JsonSchema,
  type ServiceRouteUsers,
} from '@rasta/nest-common';
import {
  approveRequestSchema,
  assignWorkshopSchema,
  cancelRepairSchema,
  cancelRequestSchema,
  changeScheduleStatusSchema,
  completeRepairSchema,
  createRequestSchema,
  createScheduleSchema,
  dueSchedulesQuerySchema,
  listRepairOrdersQuerySchema,
  listRequestsQuerySchema,
  listSchedulesQuerySchema,
  recordCostSchema,
  recordLabourSchema,
  recordPartSchema,
  startRepairSchema,
  updateScheduleSchema,
} from '../maintenance/dto';
import { transferClearanceSchema } from '../maintenance/transfer-clearance';

/**
 * Completes the OpenAPI document Nest builds from the decorators.
 *
 * Nest derives paths, methods, summaries and security from what the
 * controllers declare, but it cannot see a Zod schema — so every write
 * endpoint would arrive with no request body and every read with no query
 * parameters. This fills both in from the very schemas the service validates
 * with, which is what keeps the document from drifting: there is no second
 * description of a payload to forget to update.
 *
 * Errors are attached uniformly rather than per-endpoint. Every service on the
 * platform returns the same error envelope (`packages/contracts`), and the
 * status codes below are the ones the shared exception filter can actually
 * produce for these routes.
 */

/** Request bodies, keyed by `METHOD /path` as Nest emits them. */
const REQUEST_BODIES: Record<string, JsonSchema> = {
  'POST /v1/maintenance-schedules': toJsonSchema(createScheduleSchema),
  'PATCH /v1/maintenance-schedules/{id}': toJsonSchema(updateScheduleSchema),
  'POST /v1/maintenance-schedules/{id}/status': toJsonSchema(changeScheduleStatusSchema),
  'POST /v1/maintenance-requests': toJsonSchema(createRequestSchema),
  'POST /v1/maintenance-requests/{id}/assign': toJsonSchema(assignWorkshopSchema),
  'POST /v1/maintenance-requests/{id}/approve': toJsonSchema(approveRequestSchema),
  'POST /v1/maintenance-requests/{id}/cancel': toJsonSchema(cancelRequestSchema),
  'POST /v1/repair-orders/{id}/start': toJsonSchema(startRepairSchema),
  'POST /v1/repair-orders/{id}/complete': toJsonSchema(completeRepairSchema),
  'POST /v1/repair-orders/{id}/cancel': toJsonSchema(cancelRepairSchema),
  'POST /v1/repair-orders/{id}/parts': toJsonSchema(recordPartSchema),
  'POST /v1/repair-orders/{id}/labour': toJsonSchema(recordLabourSchema),
  'POST /v1/repair-orders/{id}/costs': toJsonSchema(recordCostSchema),
  'POST /v1/internal/assets/{assetId}/transfer-clearance': toJsonSchema(transferClearanceSchema),
};

/** Query schemas, so filtering and pagination are described, not implied. */
const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /v1/maintenance-schedules': toJsonSchema(listSchedulesQuerySchema),
  'GET /v1/maintenance-schedules/due': toJsonSchema(dueSchedulesQuerySchema),
  'GET /v1/maintenance-requests': toJsonSchema(listRequestsQuerySchema),
  'GET /v1/repair-orders': toJsonSchema(listRepairOrdersQuerySchema),
};

/**
 * Which failures each route can actually produce.
 *
 * Listed rather than blanket-applied: publishing `409` on a read tells a
 * client to handle a case that cannot occur, and a document that over-promises
 * failures is only marginally better than one that hides them.
 */
const COMMON = [401, 403, 500] as const;
const READ_ONE = [...COMMON, 404] as const;
const WRITE = [...COMMON, 400, 404, 409, 422] as const;
// ADR-062 § 3b: a write that starts work on a machine whose transfer fence has
// expired asks asset-service first; no answer is a retryable 503/504.

const ERRORS: Record<string, readonly number[]> = {
  'GET /v1/maintenance-schedules': COMMON,
  'GET /v1/maintenance-schedules/due': COMMON,
  'GET /v1/maintenance-schedules/{id}': READ_ONE,
  'POST /v1/maintenance-schedules': WRITE,
  'PATCH /v1/maintenance-schedules/{id}': WRITE,
  'POST /v1/maintenance-schedules/{id}/status': WRITE,
  'GET /v1/maintenance-requests': COMMON,
  'GET /v1/maintenance-requests/{id}': READ_ONE,
  'POST /v1/maintenance-requests': [...WRITE, 503, 504],
  'POST /v1/maintenance-requests/{id}/assign': [...WRITE, 503, 504],
  'POST /v1/maintenance-requests/{id}/approve': WRITE,
  'POST /v1/maintenance-requests/{id}/cancel': WRITE,
  'GET /v1/repair-orders': COMMON,
  'GET /v1/repair-orders/{id}': READ_ONE,
  'POST /v1/repair-orders/{id}/start': [...WRITE, 503, 504],
  'POST /v1/repair-orders/{id}/complete': WRITE,
  'POST /v1/repair-orders/{id}/cancel': WRITE,
  'POST /v1/repair-orders/{id}/parts': WRITE,
  'POST /v1/repair-orders/{id}/labour': WRITE,
  'POST /v1/repair-orders/{id}/costs': WRITE,
  // A tenant claim the token does not carry is a 403; a record outside it, 404.
  'GET /v1/internal/maintenance-requests/{id}': READ_ONE,
  // ADR-062: 404 for a machine the replica places elsewhere, 409 while another
  // transfer holds the fence.
  'POST /v1/internal/assets/{assetId}/transfer-clearance': [...COMMON, 400, 404, 409, 503, 504],
  'DELETE /v1/internal/assets/{assetId}/transfer-clearance/{fenceId}': [...COMMON, 400],
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed or failed schema validation (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: the state transition is illegal, or another request changed it first',
  422: 'The request is well-formed but a business rule refuses it (see `code` and the `rule` it names)',
  500: 'Unexpected server error',
  503: 'A service this operation depends on gave no usable answer (UPSTREAM_UNAVAILABLE); retry',
  504: 'A service this operation depends on did not answer in time (UPSTREAM_TIMEOUT); retry',
};

/** The replay fence's header, as every keyed command reads it (FU-171, PM decision D-133). */
const REPLAY_DEADLINE_PARAMETER = {
  name: 'Idempotency-Replay-Deadline',
  in: 'header',
  required: false,
  description:
    'Optional. The last instant, in milliseconds since the epoch (one canonical integer: no sign, no leading zero, no space, sent once — otherwise 400 VALIDATION_FAILED), this request may be admitted under its Idempotency-Key or answered from its stored response. ' +
    'Past it the request is refused with 409 REPLAY_WINDOW_CLOSED and nothing is written — a replay of the stored response included: this attempt did nothing, an earlier one under the key may have, so check before sending again. ' +
    'The database clock has the last word, read after the insert of a claim and after every wait; a past deadline rolls the claim back. Equality is accepted. ' +
    'A value later than claim time + MAINTENANCE_IDEMPOTENCY_TTL_HOURS − B (B = 2 · MAINTENANCE_CLOCK_SKEW_SECONDS + a fixed margin) is refused before any claim with 400 VALIDATION_FAILED (path Idempotency-Replay-Deadline, code beyond_retention, a fixed message), never clamped; this service is bound to MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS (@rasta/contracts) and refuses to start when its settings break it. ' +
    'A completed response is kept at least B past the deadline, so a request carrying it is never executed again once it has been. Sending it needs an Idempotency-Key, or 400. Without the header nothing changes: an expired key is reusable.',
  schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
};

/** What the fence adds to the two refusals of a keyed command. */
const KEYED_STATUS_TEXT: Record<number, string> = {
  400: ' — also a missing or malformed Idempotency-Key, or an Idempotency-Replay-Deadline that is not one canonical integer, is later than the retention allows, or came with no key (the attempt did nothing)',
  409: ' — also an Idempotency-Key reused with a different request or user (IDEMPOTENCY_KEY_REUSED), the same key still in flight (CONFLICT, with Retry-After), or an Idempotency-Replay-Deadline that has passed (REPLAY_WINDOW_CLOSED — this attempt did nothing; an earlier one under the key may have)',
};

/**
 * Every `@AllowService` route (FU-075) and whether a user token is still
 * admitted there. Which token a route takes is read from the guard's own
 * metadata (`applyOperationSecurity`, @rasta/nest-common); this table states
 * only what no decorator does — `users-refused` is enforced in the service
 * (`source-fact.ts`, `asset-work-state.ts`, `transfer-clearance.ts`) — and must match the decorators exactly.
 */
export const SERVICE_ROUTES: Readonly<Record<string, ServiceRouteUsers>> = {
  'GET /v1/internal/maintenance-requests/{id}': 'users-refused',
  'GET /v1/internal/assets/{assetId}/maintenance-state': 'users-refused',
  'POST /v1/internal/assets/{assetId}/transfer-clearance': 'users-refused',
  'DELETE /v1/internal/assets/{assetId}/transfer-clearance/{fenceId}': 'users-refused',
};

/** The published `security` of every operation, from the guard's metadata on `app`. */
export function publishOperationSecurity(
  document: OpenAPIObject,
  app: INestApplication,
): OpenAPIObject {
  return applyOperationSecurity(document, routeAccessByOperation(app), SERVICE_ROUTES);
}

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  // The one error shape every Rasta service returns. Referenced rather than
  // inlined per response, so a client generates a single error type.
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      const body = REQUEST_BODIES[key];
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: body } },
        };
      }

      const query = QUERY_SCHEMAS[key];
      if (query) {
        operation.parameters = [...(operation.parameters ?? []), ...toQueryParameters(query)];
      }

      // A success body, unless the route genuinely returns none.
      const success = method.toUpperCase() === 'POST' && !body ? '200' : successStatus(method);
      operation.responses ??= {};
      operation.responses[success] = {
        description: 'Success',
        content: { 'application/json': { schema: {} } },
      };

      // FU-171: every keyed command reads it, through the one store — so publishing it
      // follows from the key rather than from a list a new command could miss.
      const keyed = operation.parameters?.some(isIdempotencyKeyHeader) ?? false;
      if (keyed) operation.parameters?.push(REPLAY_DEADLINE_PARAMETER);

      for (const status of ERRORS[key] ?? []) {
        operation.responses[String(status)] = {
          description: `${STATUS_TEXT[status] ?? 'Error'}${keyed ? (KEYED_STATUS_TEXT[status] ?? '') : ''}`,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
          },
        };
      }
    }
  }

  return document;
}

function successStatus(method: string): string {
  return method.toUpperCase() === 'POST' ? '201' : '200';
}

/**
 * Flattens a query object schema into individual OpenAPI parameters.
 *
 * OpenAPI describes query strings one parameter at a time, so a single object
 * schema has to be taken apart. Doing it here rather than hand-listing each
 * parameter means adding a filter to a DTO publishes it automatically.
 */
function toQueryParameters(schema: JsonSchema): Record<string, unknown>[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);

  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: value,
    ...(value.description ? { description: value.description } : {}),
  }));
}

interface MutableOperation {
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
}

function isIdempotencyKeyHeader(parameter: unknown): boolean {
  const { in: location, name } = parameter as { in?: unknown; name?: unknown };
  return location === 'header' && name === 'Idempotency-Key';
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
