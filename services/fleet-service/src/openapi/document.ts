import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import { toJsonSchema, type JsonSchema } from './zod-schema';
import {
  availabilityQuerySchema,
  changeDriverStatusSchema,
  createAssignmentSchema,
  createDriverSchema,
  declareAvailabilitySchema,
  endAssignmentSchema,
  listAssignmentsQuerySchema,
  listDriversQuerySchema,
  listUsageQuerySchema,
  recordUsageSchema,
  updateDriverSchema,
  utilizationQuerySchema,
} from '../fleet/dto';

/**
 * Completes the OpenAPI document Nest builds from the decorators.
 *
 * Nest derives paths, methods, summaries and security from what the
 * controllers declare, but it cannot see a Zod schema — so every write
 * endpoint arrived with no request body and every read with no response
 * shape. This fills both in from the very schemas the service validates
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
  'POST /v1/drivers': toJsonSchema(createDriverSchema),
  'PATCH /v1/drivers/{id}': toJsonSchema(updateDriverSchema),
  'POST /v1/drivers/{id}/status': toJsonSchema(changeDriverStatusSchema),
  'POST /v1/assignments': toJsonSchema(createAssignmentSchema),
  'POST /v1/assignments/{id}/end': toJsonSchema(endAssignmentSchema),
  'POST /v1/usage-records': toJsonSchema(recordUsageSchema),
  'POST /v1/fleet/availability': toJsonSchema(declareAvailabilitySchema),
};

/** Query schemas, so filtering and pagination are described, not implied. */
const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /v1/drivers': toJsonSchema(listDriversQuerySchema),
  'GET /v1/drivers/{id}/assignments': toJsonSchema(listAssignmentsQuerySchema),
  'GET /v1/assignments': toJsonSchema(listAssignmentsQuerySchema),
  'GET /v1/usage-records': toJsonSchema(listUsageQuerySchema),
  'GET /v1/fleet/availability': toJsonSchema(availabilityQuerySchema),
  'GET /v1/fleet/utilization': toJsonSchema(utilizationQuerySchema),
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
  'GET /v1/drivers': COMMON,
  'GET /v1/drivers/me': COMMON,
  'GET /v1/drivers/{id}': READ_ONE,
  'GET /v1/drivers/{id}/assignments': READ_ONE,
  'POST /v1/drivers': WRITE,
  'PATCH /v1/drivers/{id}': WRITE,
  'POST /v1/drivers/{id}/status': WRITE,
  'GET /v1/assignments': COMMON,
  'GET /v1/assignments/{id}': READ_ONE,
  'POST /v1/assignments': WRITE,
  'POST /v1/assignments/{id}/end': WRITE,
  'DELETE /v1/assignments/{id}': WRITE,
  'GET /v1/usage-records': COMMON,
  'GET /v1/usage-records/{id}': READ_ONE,
  'POST /v1/usage-records': WRITE,
  'GET /v1/fleet/availability': COMMON,
  'POST /v1/fleet/availability': WRITE,
  'POST /v1/fleet/availability/{id}/revoke': WRITE,
  'GET /v1/fleet/utilization': COMMON,
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed or failed schema validation (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: the resource already exists, the state transition is illegal, or another request changed it first',
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
