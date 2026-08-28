import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import { toJsonSchema, type JsonSchema } from './zod-schema';
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

const ERRORS: Record<string, readonly number[]> = {
  'GET /v1/maintenance-schedules': COMMON,
  'GET /v1/maintenance-schedules/due': COMMON,
  'GET /v1/maintenance-schedules/{id}': READ_ONE,
  'POST /v1/maintenance-schedules': WRITE,
  'PATCH /v1/maintenance-schedules/{id}': WRITE,
  'POST /v1/maintenance-schedules/{id}/status': WRITE,
  'GET /v1/maintenance-requests': COMMON,
  'GET /v1/maintenance-requests/{id}': READ_ONE,
  'POST /v1/maintenance-requests': WRITE,
  'POST /v1/maintenance-requests/{id}/assign': WRITE,
  'POST /v1/maintenance-requests/{id}/approve': WRITE,
  'POST /v1/maintenance-requests/{id}/cancel': WRITE,
  'GET /v1/repair-orders': COMMON,
  'GET /v1/repair-orders/{id}': READ_ONE,
  'POST /v1/repair-orders/{id}/start': WRITE,
  'POST /v1/repair-orders/{id}/complete': WRITE,
  'POST /v1/repair-orders/{id}/cancel': WRITE,
  'POST /v1/repair-orders/{id}/parts': WRITE,
  'POST /v1/repair-orders/{id}/labour': WRITE,
  'POST /v1/repair-orders/{id}/costs': WRITE,
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed or failed schema validation (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: the state transition is illegal, or another request changed it first',
  422: 'The request is well-formed but a business rule refuses it (see `code` and the `rule` it names)',
  500: 'Unexpected server error',
};

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

      for (const status of ERRORS[key] ?? []) {
        operation.responses[String(status)] = {
          description: STATUS_TEXT[status] ?? 'Error',
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

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
