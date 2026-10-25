import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import { RETRY_AFTER_MAX_SECONDS, RETRY_AFTER_MIN_SECONDS } from '@rasta/nest-common';
import { toJsonSchema, type JsonSchema } from './zod-schema';
import {
  cancelOrderSchema,
  confirmReceiptSchema,
  createOrderSchema,
  fulfillOrderSchema,
  listOrdersQuerySchema,
  raiseDisputeSchema,
  resolveDisputeSchema,
  submitReviewSchema,
} from '../order/dto';
import {
  createOfferSchema,
  createProductSchema,
  searchProductsQuerySchema,
  updateOfferSchema,
} from '../offer/dto';
import {
  cancelReturnSchema,
  createReturnSchema,
  decideReturnSchema,
  listReturnsQuerySchema,
} from '../returns/dto';

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
  'POST /v1/orders': toJsonSchema(createOrderSchema),
  'POST /v1/orders/{id}/fulfill': toJsonSchema(fulfillOrderSchema),
  'POST /v1/orders/{id}/confirm-receipt': toJsonSchema(confirmReceiptSchema),
  'POST /v1/orders/{id}/disputes': toJsonSchema(raiseDisputeSchema),
  'POST /v1/orders/{id}/disputes/resolve': toJsonSchema(resolveDisputeSchema),
  'POST /v1/orders/{id}/cancel': toJsonSchema(cancelOrderSchema),
  'POST /v1/orders/{id}/reviews': toJsonSchema(submitReviewSchema),
  'POST /v1/products': toJsonSchema(createProductSchema),
  'POST /v1/offers': toJsonSchema(createOfferSchema),
  'PATCH /v1/offers/{id}': toJsonSchema(updateOfferSchema),
  // RUN-005: the order path parameter is `orderId` there, as the controller names it.
  'POST /v1/orders/{orderId}/returns': toJsonSchema(createReturnSchema),
  'POST /v1/returns/{id}/decisions': toJsonSchema(decideReturnSchema),
  // Codex r1 on #339: a cancellation is conditional on the status the caller saw.
  'POST /v1/returns/{id}/cancellation': toJsonSchema(cancelReturnSchema),
};

/** Query schemas, so filtering and pagination are described, not implied. */
const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /v1/orders': toJsonSchema(listOrdersQuerySchema),
  'GET /v1/products': toJsonSchema(searchProductsQuerySchema),
  'GET /v1/products/{id}/offers': toJsonSchema(searchProductsQuerySchema),
  'GET /v1/returns': toJsonSchema(listReturnsQuerySchema),
};

/**
 * Routes that will not accept a request without an `Idempotency-Key`.
 *
 * Every unsafe route on an order, because each either commits money or creates
 * an effect that cannot be taken back in `docs/06` § 6.8's sense — confirming
 * receipt is what lets settlement happen, and a dispute halts it indefinitely.
 *
 * And every unsafe catalogue route: docs/06 § 6.8 lists publishing an offer
 * among the operations that must be idempotent, and without a key a double
 * submit published two offers (or created two products).
 *
 * And every unsafe return-request route (RUN-005): a retried POST must not file
 * two requests or decide one twice.
 *
 * It is also what the gateway enforces: `requiresIdempotencyKey` applies to the
 * whole `orders`, `products`, `offers` and `returns` prefixes (unsafe methods only),
 * because teaching the routing layer which verb commits money would give it
 * domain knowledge ADR-009 keeps out of it. A service that accepted a key on
 * some of these and refused it on others would make the gateway's rule wrong
 * rather than coarse.
 */
const IDEMPOTENT_ROUTES = new Set([
  'POST /v1/products',
  'POST /v1/offers',
  'PATCH /v1/offers/{id}',
  'POST /v1/orders',
  'POST /v1/orders/{id}/confirm',
  'POST /v1/orders/{id}/fulfill',
  'POST /v1/orders/{id}/confirm-receipt',
  'POST /v1/orders/{id}/disputes',
  'POST /v1/orders/{id}/disputes/resolve',
  'POST /v1/orders/{id}/cancel',
  'POST /v1/orders/{id}/reviews',
  'POST /v1/orders/{orderId}/returns',
  'POST /v1/returns/{id}/decisions',
  'POST /v1/returns/{id}/cancellation',
  'POST /v1/returns/{id}/dispatch-reconciliation',
]);

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
  'GET /v1/orders': COMMON,
  'GET /v1/orders/{id}': READ_ONE,
  'POST /v1/orders': WRITE,
  'POST /v1/orders/{id}/confirm': WRITE,
  'POST /v1/orders/{id}/fulfill': WRITE,
  'POST /v1/orders/{id}/confirm-receipt': WRITE,
  'POST /v1/orders/{id}/disputes': WRITE,
  'POST /v1/orders/{id}/disputes/resolve': WRITE,
  'POST /v1/orders/{id}/cancel': WRITE,
  'POST /v1/orders/{id}/reviews': WRITE,
  'GET /v1/products': COMMON,
  'GET /v1/products/{id}/offers': READ_ONE,
  'POST /v1/products': WRITE,
  'GET /v1/offers': COMMON,
  'POST /v1/offers': WRITE,
  'PATCH /v1/offers/{id}': WRITE,
  // A malformed filter is refused with 400 before anything is read.
  'GET /v1/returns': [...COMMON, 400],
  'GET /v1/returns/{id}': READ_ONE,
  'POST /v1/orders/{orderId}/returns': WRITE,
  'POST /v1/returns/{id}/decisions': WRITE,
  // Both ask inventory-service before writing (Q-133 (9)): 503/504 when it cannot be asked.
  'POST /v1/returns/{id}/cancellation': [...WRITE, 503, 504],
  'POST /v1/returns/{id}/dispatch-reconciliation': [...COMMON, 404, 409, 422, 503, 504],
  // The internal routes (ADR-061 § 4, Q-133 (5)): one named service, no user. The reservation is
  // 422 for a request that is not AUTHORIZED, 409 only if its row moved under a held lock.
  'GET /v1/internal/returns/{id}': READ_ONE,
  'POST /v1/internal/returns/{id}/dispatch-reservation': [...COMMON, 404, 409, 422],
};

/**
 * The internal routes' credential: a service's internal token in `X-Internal-Token` and nothing
 * else. `AuthGuard` judges a request that also carries `Authorization` on that bearer token, as a
 * user — so the internal routes cannot be described by the bearer scheme (contract-service's
 * document says the same).
 */
export const INTERNAL_TOKEN_SCHEME = 'internalToken';

/** The `X-Internal-Token` scheme `main.ts` declares beside the bearer one. */
export const INTERNAL_TOKEN_API_KEY = {
  type: 'apiKey' as const,
  in: 'header',
  name: 'X-Internal-Token',
  description:
    'A service’s internal token (ADR-061 § 4), signed for the organization it acts for. Sent alone: a request that also carries an `Authorization` bearer token is judged on that token, as a user.',
};

const isInternal = (path: string): boolean => path.startsWith('/v1/internal/');

/** What 403 and 404 mean on an internal route, which answers one named service and no user. */
const INTERNAL_STATUS_TEXT: Record<number, string> = {
  403: 'Authenticated, but not the service this route answers: any user token (whatever its roles), another service’s internal token, or an internal token signed for no organization.',
  404: 'Not found — also returned for a return request of any supplier but the one the internal token is signed for (its buyer included), so its existence is never disclosed.',
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed or failed schema validation (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: the resource already exists, the state transition is illegal, or another request changed it first',
  422: 'The request is well-formed but a business rule refuses it (see `code` and the `rule` it names)',
  500: 'Unexpected server error',
  503: 'A service this answer depends on could not be asked or gave no valid answer (UPSTREAM_UNAVAILABLE); nothing was written',
  504: 'A service this answer depends on did not answer in time (UPSTREAM_TIMEOUT); nothing was written',
};

/**
 * `Retry-After` on an idempotent route's 409 (docs/06 § 6.8). Optional: only
 * the in-flight `CONFLICT` carries it, never `IDEMPOTENCY_KEY_REUSED` or a
 * state conflict. The bounds are the exception filter's own.
 */
const RETRY_AFTER_HEADER = {
  required: false,
  description:
    'Sent only when this Idempotency-Key is still being processed (CONFLICT): the ' +
    'seconds to wait before retrying with the same key. Absent on every other 409.',
  schema: { type: 'integer', minimum: RETRY_AFTER_MIN_SECONDS, maximum: RETRY_AFTER_MAX_SECONDS },
};

export interface OpenApiOptions {
  /**
   * How long a recorded idempotency key is replayed for, from the running
   * configuration.
   *
   * Required rather than defaulted. `MARKETPLACE_IDEMPOTENCY_TTL_HOURS` accepts
   * anything from 1 to 168, and a default here would be a second source of
   * truth that silently disagrees with the deployment the reader is looking at
   * — which is the bug this parameter exists to prevent, not a convenience it
   * can afford. A published contract that names a retention window the service
   * does not honour sends a client to build a retry policy around it.
   */
  idempotencyTtlHours: number;
}

export function enrichOpenApiDocument(
  document: OpenAPIObject,
  options: OpenApiOptions,
): OpenAPIObject {
  const ttl = options.idempotencyTtlHours;
  const retention = `${ttl} ${ttl === 1 ? 'hour' : 'hours'}`;

  document.components ??= {};
  document.components.schemas ??= {};
  // The one error shape every Rasta service returns. Referenced rather than
  // inlined per response, so a client generates a single error type.
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      // An internal route answers a service's internal token only, which is not a bearer token.
      if (isInternal(path)) operation.security = [{ [INTERNAL_TOKEN_SCHEME]: [] }];

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

      if (IDEMPOTENT_ROUTES.has(key)) {
        operation.parameters = [
          ...(operation.parameters ?? []),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 8, maxLength: 128 },
            description:
              'Required. A retry by the same user with the same key returns the first ' +
              'response without executing again — once the caller has passed the current ' +
              'read and owner check of what it names; otherwise the caller gets the refusal ' +
              'the route itself would give. The same key with ' +
              'a different body, or from another user, is refused with 409 ' +
              'IDEMPOTENCY_KEY_REUSED, and while the first request is still in flight with ' +
              'CONFLICT and a Retry-After header, in seconds. ' +
              `Keys are honoured for ${retention}, which is ` +
              'this deployment’s configured retention window and not a platform constant.',
          },
        ];
      }

      // The success status the route declares (`@HttpCode`, which Nest has already published as
      // the operation's one 2xx), so the document never adds a second one beside it — a decision
      // that answers 200 is not also a 201. Only an operation Nest gave none is guessed at.
      operation.responses ??= {};
      const declared = Object.keys(operation.responses).filter((status) => /^2\d\d$/.test(status));
      const success =
        declared.length === 1 && declared[0]
          ? declared[0]
          : method.toUpperCase() === 'POST' && !body
            ? '200'
            : successStatus(method);
      operation.responses[success] = {
        description: 'Success',
        content: { 'application/json': { schema: {} } },
      };

      for (const status of ERRORS[key] ?? []) {
        operation.responses[String(status)] = {
          description:
            (isInternal(path) ? INTERNAL_STATUS_TEXT[status] : undefined) ??
            STATUS_TEXT[status] ??
            'Error',
          ...(status === 409 && IDEMPOTENT_ROUTES.has(key)
            ? { headers: { 'Retry-After': RETRY_AFTER_HEADER } }
            : {}),
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
  security?: Record<string, string[]>[];
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
