import type { OpenAPIObject } from '@nestjs/swagger';
import { apiErrorSchema } from '@rasta/contracts';
import { toJsonSchema, type JsonSchema } from './zod-schema';
import {
  listEntriesQuerySchema,
  reverseJournalSchema,
  trialBalanceQuerySchema,
} from '../ledger/dto';
import { listHoldsQuerySchema, walletQuerySchema } from '../wallet/dto';
import { listPaymentsQuerySchema, refundPaymentSchema, topUpSchema } from '../payment/dto';
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
  createRewardRuleSchema,
  listRewardRulesQuerySchema,
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
  'POST /v1/payment-intents/{id}/refund': toJsonSchema(refundPaymentSchema),
};

/** Query schemas, so filtering and pagination are described, not implied. */
const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /v1/wallets/me': toJsonSchema(walletQuerySchema),
  'GET /v1/wallets/{id}/holds': toJsonSchema(listHoldsQuerySchema),
  'GET /v1/transactions': toJsonSchema(listTransactionsQuerySchema),
  'GET /v1/ledger/accounts/{id}/entries': toJsonSchema(listEntriesQuerySchema),
  'GET /v1/ledger/trial-balance': toJsonSchema(trialBalanceQuerySchema),
  'GET /v1/commissions': toJsonSchema(listCommissionsQuerySchema),
  'GET /v1/commissions/rules': toJsonSchema(listCommissionRulesQuerySchema),
  'GET /v1/rewards/me': toJsonSchema(myRewardsQuerySchema),
  'GET /v1/rewards/rules': toJsonSchema(listRewardRulesQuerySchema),
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
  'GET /v1/wallets/provider': COMMON,
  'GET /v1/wallets/me': COMMON,
  'GET /v1/wallets/{id}': READ_ONE,
  'GET /v1/wallets/{id}/holds': READ_ONE,
  'POST /v1/wallets/{id}/top-up': WRITE,
  'GET /v1/transactions': COMMON,
  'GET /v1/transactions/{id}': READ_ONE,
  'POST /v1/transactions': WRITE,
  'POST /v1/transactions/{id}/authorise-settlement': WRITE,
  'POST /v1/transactions/{id}/dispute': WRITE,
  'POST /v1/transactions/{id}/resolve-dispute': WRITE,
  'POST /v1/transactions/{id}/refund': WRITE,
  'POST /v1/transactions/{id}/cancel': WRITE,
  'POST /v1/settlements': WRITE,
  'GET /v1/settlements': COMMON,
  'GET /v1/settlements/{id}': READ_ONE,
  'GET /v1/ledger/accounts': COMMON,
  'GET /v1/ledger/accounts/{id}/entries': READ_ONE,
  'GET /v1/ledger/journals/{id}': READ_ONE,
  'POST /v1/ledger/journals/{id}/reverse': WRITE,
  'GET /v1/ledger/trial-balance': COMMON,
  'GET /v1/commissions': COMMON,
  'GET /v1/commissions/rules': COMMON,
  'POST /v1/commissions/rules': WRITE,
  'PATCH /v1/commissions/rules/{id}': WRITE,
  'GET /v1/rewards/me': COMMON,
  'GET /v1/rewards/rules': COMMON,
  'POST /v1/rewards/rules': WRITE,
  'PATCH /v1/rewards/rules/{id}': WRITE,
  'GET /v1/payment-intents': COMMON,
  'GET /v1/payment-intents/{id}': READ_ONE,
  'POST /v1/payment-intents/{id}/refund': WRITE,
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is malformed, failed schema validation, or omitted a required Idempotency-Key (VALIDATION_FAILED)',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted. The oversight role (AUDITOR) is refused every endpoint in this service',
  404: 'Not found — also returned for a resource owned by another organization, so its existence is never disclosed',
  409: 'Conflict: an illegal state transition, an idempotency key reused with a different body, or a request already in flight',
  422: 'The request is well-formed but a business rule refuses it — INSUFFICIENT_BALANCE, LEDGER_UNBALANCED, or a domain rule',
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
              'IDEMPOTENCY_KEY_REUSED. Keys are honoured for 24 hours.',
          },
        ];
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
