import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import type { z } from 'zod';
import {
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  toJsonSchema as sharedToJsonSchema,
  type JsonSchema,
} from '@rasta/nest-common';
import { TRANSACTION_RESPONSES, TRANSACTION_VIEW_SCHEMAS } from './transaction-view';
import {
  listEntriesQuerySchema,
  reverseJournalSchema,
  trialBalanceQuerySchema,
} from '../ledger/dto';
import { listHoldsQuerySchema, walletQuerySchema } from '../wallet/dto';
import { listSettlementsQuerySchema } from '../settlement/dto';
import {
  listPaymentsQuerySchema,
  operatorDecisionSchema,
  proposeResolutionSchema,
  refundPaymentSchema,
  topUpSchema,
} from '../payment/dto';
import {
  cancelTransactionSchema,
  createTransactionSchema,
  disputeTransactionSchema,
  listTransactionsQuerySchema,
  refundTransactionSchema,
  resolveDisputeSchema,
  settleTransactionSchema,
} from '../transaction/dto';
import {
  createCommissionRuleSchema,
  listCommissionRulesQuerySchema,
  listCommissionsQuerySchema,
  updateCommissionRuleSchema,
} from '../commission/dto';
import {
  createParticipationRuleSchema,
  createRecognitionRuleSchema,
  createRewardRuleSchema,
  listRewardRulesQuerySchema,
  myParticipationQuerySchema,
  myRecognitionQuerySchema,
  myRewardsQuerySchema,
  updateRewardRuleSchema,
} from '../reward/dto';

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
 * One addition specific to this service: every endpoint that moves money is
 * documented as requiring an `Idempotency-Key` header. A client that omits it
 * gets a 400, and the reason it must not be optional — a retried POST charging
 * twice — is the whole point of docs/06 § 6.8.
 */

/**
 * The shared converter, minus array bounds. This service's own copy of the
 * converter never published `minItems`/`maxItems`, and replacing that copy with
 * the shared one keeps every generated document byte-identical. Publishing the
 * three bounds it hides (recognition-rule `levels` ≤ 50 and `badges` ≤ 100,
 * participation-rule `contributions` 1–2) is a contract change of its own:
 * delete this wrapper then.
 */
function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return withoutArrayBounds(sharedToJsonSchema(schema)) as JsonSchema;
}

function withoutArrayBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutArrayBounds);
  if (typeof node !== 'object' || node === null) return node;
  const isArray = (node as { type?: unknown }).type === 'array';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (isArray && (key === 'minItems' || key === 'maxItems')) continue;
    out[key] = withoutArrayBounds(value);
  }
  return out;
}

/** Request bodies, keyed by `METHOD /path` as Nest emits them. */
const REQUEST_BODIES: Record<string, JsonSchema> = {
  'POST /v1/wallets/{id}/top-up': toJsonSchema(topUpSchema.omit({ idempotencyKey: true })),
  'POST /v1/transactions': toJsonSchema(createTransactionSchema),
  'POST /v1/transactions/{id}/dispute': toJsonSchema(disputeTransactionSchema),
  'POST /v1/transactions/{id}/resolve-dispute': toJsonSchema(resolveDisputeSchema),
  'POST /v1/transactions/{id}/refund': toJsonSchema(refundTransactionSchema),
  'POST /v1/transactions/{id}/cancel': toJsonSchema(cancelTransactionSchema),
  'POST /v1/settlements': toJsonSchema(settleTransactionSchema),
  'POST /v1/ledger/journals/{id}/reverse': toJsonSchema(reverseJournalSchema),
  'POST /v1/commissions/rules': toJsonSchema(createCommissionRuleSchema),
  'PATCH /v1/commissions/rules/{id}': toJsonSchema(updateCommissionRuleSchema),
  'POST /v1/rewards/rules': toJsonSchema(createRewardRuleSchema),
  'PATCH /v1/rewards/rules/{id}': toJsonSchema(updateRewardRuleSchema),
  'POST /v1/rewards/participation-rules': toJsonSchema(createParticipationRuleSchema),
  'POST /v1/rewards/recognition-rules': toJsonSchema(createRecognitionRuleSchema),
  'POST /v1/payment-intents/{id}/refund': toJsonSchema(refundPaymentSchema),
  'POST /v1/payment-intents/{id}/reconciliation/requeue': toJsonSchema(operatorDecisionSchema),
  'POST /v1/payment-intents/{id}/reconciliation/resolutions': toJsonSchema(proposeResolutionSchema),
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/approve':
    toJsonSchema(operatorDecisionSchema),
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/reject':
    toJsonSchema(operatorDecisionSchema),
};

/** Query schemas, so filtering and pagination are described, not implied. */
const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /v1/wallets/me': toJsonSchema(walletQuerySchema),
  'GET /v1/wallets/{id}/holds': toJsonSchema(listHoldsQuerySchema),
  'GET /v1/transactions': toJsonSchema(listTransactionsQuerySchema),
  'GET /v1/settlements': toJsonSchema(listSettlementsQuerySchema),
  'GET /v1/ledger/accounts/{id}/entries': toJsonSchema(listEntriesQuerySchema),
  'GET /v1/ledger/trial-balance': toJsonSchema(trialBalanceQuerySchema),
  'GET /v1/commissions': toJsonSchema(listCommissionsQuerySchema),
  'GET /v1/commissions/rules': toJsonSchema(listCommissionRulesQuerySchema),
  'GET /v1/rewards/me': toJsonSchema(myRewardsQuerySchema),
  'GET /v1/rewards/rules': toJsonSchema(listRewardRulesQuerySchema),
  'GET /v1/rewards/me/participation': toJsonSchema(myParticipationQuerySchema),
  'GET /v1/rewards/me/recognition': toJsonSchema(myRecognitionQuerySchema),
  'GET /v1/payment-intents': toJsonSchema(listPaymentsQuerySchema),
};

/**
 * Routes that will not accept a request without an `Idempotency-Key`.
 *
 * Every unsafe route in this service, because every one of them either moves
 * money or creates an irreversible effect in docs/06 § 6.8's sense —
 * authorising settlement is what lets money move afterwards, and a dispute
 * halts it indefinitely.
 *
 * It is also what the gateway enforces: `requiresIdempotencyKey` applies to a
 * whole prefix, since teaching the routing layer which verb under
 * `transactions` moves money would give it domain knowledge ADR-009 keeps out
 * of it. A service that accepted a key on some of these and refused it on
 * others would make the gateway's rule wrong rather than coarse.
 */
const IDEMPOTENT_ROUTES = new Set([
  'POST /v1/wallets/{id}/top-up',
  'POST /v1/transactions',
  'POST /v1/transactions/{id}/authorise-settlement',
  'POST /v1/transactions/{id}/dispute',
  'POST /v1/transactions/{id}/resolve-dispute',
  'POST /v1/transactions/{id}/refund',
  'POST /v1/transactions/{id}/cancel',
  'POST /v1/settlements',
  'POST /v1/payment-intents/{id}/refund',
  'POST /v1/payment-intents/{id}/reconciliation/requeue',
  'POST /v1/payment-intents/{id}/reconciliation/resolutions',
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/approve',
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/reject',
  // Moves no money, but a retried version would replace the one in force for
  // every organization (review of #328, r1). Required by the service; the
  // gateway's `rewards` prefix carries no requirement, so it forwards the key.
  'POST /v1/rewards/participation-rules',
  // The same for levels and badges: one version in force for everyone.
  'POST /v1/rewards/recognition-rules',
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
/**
 * A cursor-paginated list: a query that fails its schema, or a `cursor` that
 * is not a row of the list asked for, is a 400 (shared/cursor.ts). Never a
 * 404 — that would say something about the row the cursor names.
 */
const LIST = [...COMMON, 400] as const;

const ERRORS: Record<string, readonly number[]> = {
  'GET /v1/wallets/provider': COMMON,
  'GET /v1/wallets/provider/disclosure': COMMON,
  'GET /v1/wallets/me': COMMON,
  'GET /v1/wallets/{id}': READ_ONE,
  'GET /v1/wallets/{id}/holds': READ_ONE,
  'POST /v1/wallets/{id}/top-up': WRITE,
  'GET /v1/transactions': LIST,
  'GET /v1/transactions/{id}': READ_ONE,
  'POST /v1/transactions': WRITE,
  'POST /v1/transactions/{id}/authorise-settlement': WRITE,
  'POST /v1/transactions/{id}/dispute': WRITE,
  'POST /v1/transactions/{id}/resolve-dispute': WRITE,
  'POST /v1/transactions/{id}/refund': WRITE,
  'POST /v1/transactions/{id}/cancel': WRITE,
  'POST /v1/settlements': WRITE,
  'GET /v1/settlements': LIST,
  'GET /v1/settlements/{id}': READ_ONE,
  'GET /v1/ledger/accounts': COMMON,
  'GET /v1/ledger/accounts/{id}/entries': [...LIST, 404],
  'GET /v1/ledger/journals/{id}': READ_ONE,
  'POST /v1/ledger/journals/{id}/reverse': WRITE,
  'GET /v1/ledger/trial-balance': COMMON,
  'GET /v1/commissions': LIST,
  'GET /v1/commissions/rules': COMMON,
  'POST /v1/commissions/rules': WRITE,
  'PATCH /v1/commissions/rules/{id}': WRITE,
  'GET /v1/rewards/me': COMMON,
  'GET /v1/rewards/rules': COMMON,
  'POST /v1/rewards/rules': WRITE,
  'PATCH /v1/rewards/rules/{id}': WRITE,
  // A query that fails its schema — a `userId` included — is a 400.
  'GET /v1/rewards/me/participation': [...COMMON, 400],
  'GET /v1/rewards/participation-rules': COMMON,
  // No 404: nothing is named. 409: a stale `expectedCurrentVersion`, or the key.
  'POST /v1/rewards/participation-rules': [...COMMON, 400, 409],
  // Any query parameter at all — a `userId` — is a 400.
  'GET /v1/rewards/me/recognition': [...COMMON, 400],
  'GET /v1/rewards/recognition-rules': COMMON,
  // As the participation rule.
  'POST /v1/rewards/recognition-rules': [...COMMON, 400, 409],
  'GET /v1/payment-intents': LIST,
  'GET /v1/payment-intents/{id}': READ_ONE,
  'POST /v1/payment-intents/{id}/refund': WRITE,
  'GET /v1/payment-intents/{id}/reconciliation': READ_ONE,
  'POST /v1/payment-intents/{id}/reconciliation/requeue': WRITE,
  'POST /v1/payment-intents/{id}/reconciliation/resolutions': WRITE,
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/approve': WRITE,
  'POST /v1/payment-intents/{id}/reconciliation/resolutions/{resolutionId}/reject': WRITE,
  'GET /v1/internal/obligations/by-source/STATEMENT/{statementId}': READ_ONE,
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed, failed schema validation, omitted a required Idempotency-Key, or named a cursor that is not a row of the list asked for (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted. The oversight role (AUDITOR) is refused every endpoint in this service',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: an illegal state transition, a stale expected version (OPTIMISTIC_LOCK_FAILED), an idempotency key reused with a different body, or a request already in flight',
  422: 'The request is well-formed but a business rule refuses it — INSUFFICIENT_BALANCE, LEDGER_UNBALANCED, or a domain rule',
  500: 'Unexpected server error',
};

/**
 * A status said more precisely for one route, where it has a refusal of its
 * own that a client branches on.
 */
const ROUTE_STATUS_TEXT: Record<string, Partial<Record<number, string>>> = {
  'POST /v1/transactions': {
    422:
      'A business rule refuses the obligation, and nothing was recorded: INSUFFICIENT_BALANCE ' +
      '(holdFunds), a domain rule (BUSINESS_RULE_VIOLATION) — or BUSINESS_LINE_REQUIRED: ' +
      'settlement fails closed without a commission rule (docs/24 Q-29; on outside development ' +
      'and test, `ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE`), so a new obligation must name ' +
      '`businessLine`. Only marketplace-service recording its own `ORDER` may leave it out ' +
      '(docs/24 Q-130)',
  },
  'POST /v1/settlements': {
    422:
      'A business rule refuses the settlement, and nothing moved: INSUFFICIENT_BALANCE, ' +
      'LEDGER_UNBALANCED, a domain rule (BUSINESS_RULE_VIOLATION) — or NO_ACTIVE_RULE: no ' +
      'active commission rule covers the transaction’s business line, and settlement fails ' +
      'closed (docs/24 Q-29; on outside development and test, ' +
      '`ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE`). The funds stay held; the same ' +
      'settlement succeeds once a rule for the line — a 0% rule included — is in force',
  },
};

/**
 * The same statuses on the internal routes (`/v1/internal/…`, ADR-061 § 4),
 * which answer one named service and no user at all.
 */
const INTERNAL_STATUS_TEXT: Record<number, string> = {
  403: 'Authenticated, but not the service this route answers: any user token (whatever its roles), another service’s internal token, or an internal token signed for no organization',
  404: 'Not found — also returned for a record of any organization but the one the internal token is signed for, so its existence is never disclosed',
};

/**
 * The internal routes' credential: a service's internal token in
 * `X-Internal-Token` and nothing else. `AuthGuard` judges a request that also
 * carries `Authorization` on that bearer token, as a user — so the internal
 * routes cannot be described by the bearer scheme.
 */
export const INTERNAL_TOKEN_SCHEME = 'internalToken';

const INTERNAL_TOKEN_SECURITY_SCHEME = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Internal-Token',
  description:
    'A service’s internal token (ADR-061 § 4), signed for the organization it acts for. Sent alone: a request that also carries an `Authorization` bearer token is judged on that token, as a user.',
} as const;

const isInternalPath = (path: string): boolean => path.startsWith('/v1/internal/');

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

/**
 * Success bodies outside the transaction views (`transaction-view.ts`), by
 * component name, and the routes that send them. Held to the route's answer
 * by `api-wallet.int-spec.ts` with `schemaMismatches`, both ways.
 */
const OTHER_VIEW_SCHEMAS: Record<string, JsonSchema> = {
  PaymentDisclosure: {
    type: 'object',
    required: ['simulated'],
    properties: {
      simulated: {
        type: 'boolean',
        description:
          'True while no real money moves (the simulated provider, ADR-024): a screen that ' +
          'shows or moves money draws «حالت نمایشی» (Q-14).',
      },
    },
  },
};

const OTHER_RESPONSES: Record<string, string> = {
  'GET /v1/wallets/provider/disclosure': 'PaymentDisclosure',
};

const RESPONSES: Record<string, string> = { ...TRANSACTION_RESPONSES, ...OTHER_RESPONSES };

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  // The one error shape every Rasta service returns. Referenced rather than
  // inlined per response, so a client generates a single error type.
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;
  // The transaction a response carries, and the disclosure — referenced for the same reason.
  for (const [name, schema] of Object.entries({
    ...TRANSACTION_VIEW_SCHEMAS,
    ...OTHER_VIEW_SCHEMAS,
  })) {
    document.components.schemas[name] = schema as never;
  }
  document.components.securitySchemes ??= {};
  document.components.securitySchemes[INTERNAL_TOKEN_SCHEME] = INTERNAL_TOKEN_SECURITY_SCHEME;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;
      const internal = isInternalPath(path);

      // Only the internal token reaches an internal route; a bearer token there
      // is a user, and refused.
      if (internal) operation.security = [{ [INTERNAL_TOKEN_SCHEME]: [] }];

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
              'Required. A retry with the same key returns the first response without ' +
              'executing again; the same key with a different body is refused with 409 ' +
              'IDEMPOTENCY_KEY_REUSED, and while the first request is still in flight with ' +
              'CONFLICT and a Retry-After header, in seconds. Keys are honoured for 24 hours.',
          },
        ];
      }

      // The success body, under the status the handler answers with.
      const success = successStatus(key, operation);
      const view = RESPONSES[key];
      operation.responses ??= {};
      operation.responses[success] = {
        description: 'Success',
        content: {
          'application/json': { schema: view ? { $ref: `#/components/schemas/${view}` } : {} },
        },
      };

      for (const status of ERRORS[key] ?? []) {
        operation.responses[String(status)] = {
          description:
            ROUTE_STATUS_TEXT[key]?.[status] ??
            (internal ? INTERNAL_STATUS_TEXT[status] : undefined) ??
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

/**
 * The status a route answers success with: the one Nest wrote into the
 * document for it — the handler's `@HttpCode`, or without one Nest's default
 * (201 for a POST, 200 otherwise), which is also what the route sends.
 *
 * Read from the route, never guessed from the request. Guessing that a POST
 * with a body creates something documented the dispute, resolution, refund
 * and cancel views under a 201 those routes never send, and left their real
 * 200 with no schema (Codex on #322). A route with no success status, or
 * more than one, is refused: there is nothing to attach the body to that
 * would not be a guess.
 */
function successStatus(key: string, operation: MutableOperation): string {
  const declared = Object.keys(operation.responses ?? {}).filter((status) =>
    /^2\d\d$/.test(status),
  );
  if (declared.length !== 1) {
    throw new Error(
      `OpenAPI: ${key} declares ${declared.length} success statuses (${declared.join(', ')}); ` +
        'exactly one is needed to document its body',
    );
  }
  return declared[0]!;
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
