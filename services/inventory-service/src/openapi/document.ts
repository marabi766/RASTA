import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  isOptionalField,
  objectShapeOf,
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  toJsonSchema,
} from '@rasta/nest-common';
import { WarehouseController } from '../warehouse/warehouse.controller';
import { WarehouseService } from '../warehouse/warehouse.service';
import {
  createWarehouseSchema,
  listWarehousesQuerySchema,
  warehouseViewSchema,
} from '../warehouse/dto';
import { StockController } from '../stock/stock.controller';
import { StockService } from '../stock/stock.service';
import {
  adjustStockSchema,
  listMovementsQuerySchema,
  listStockQuerySchema,
  receiveStockSchema,
  stockChangeViewSchema,
  stockItemViewSchema,
  stockMovementViewSchema,
} from '../stock/dto';
import { ReservationController } from '../reservation/reservation.controller';
import { ReservationService } from '../reservation/reservation.service';
import {
  endReservationSchema,
  listReservationsQuerySchema,
  reservationBatchViewSchema,
  reservationViewSchema,
  reserveStockSchema,
} from '../reservation/dto';
import { ShipmentController } from '../shipment/shipment.controller';
import { ShipmentService } from '../shipment/shipment.service';
import {
  createShipmentSchema,
  listShipmentsQuerySchema,
  moveShipmentSchema,
  shipmentViewSchema,
  trackingViewSchema,
} from '../shipment/dto';
import { ReturnShipmentController } from '../return-shipment/return-shipment.controller';
import { ReturnShipmentService } from '../return-shipment/return-shipment.service';
import {
  createReturnShipmentSchema,
  listReturnShipmentsQuerySchema,
  inspectReturnShipmentSchema,
  receiveReturnShipmentSchema,
  resolveReturnShipmentSchema,
  returnShipmentViewSchema,
  returnTrackingViewSchema,
  dispatchWithdrawalViewSchema,
  returnRequestShipmentViewSchema,
  withdrawDispatchSchema,
} from '../return-shipment/dto';
import { ReturnDispatchFenceService } from '../return-shipment/dispatch-fence';
import { InternalReturnRequestController } from '../return-shipment/internal-return-request.controller';
import { IdempotencyStore } from '../shared/idempotency';
import { REFUSAL_REASONS, type RefusalArea } from '../shared/refusal';

/**
 * The published contract of inventory-service — **OpenAPI first**.
 *
 * `docs/api/inventory-service.openapi.json` is committed, so an API change shows in a PR's diff
 * and a client can be generated without running anything. The arrangement contract-service and
 * construction-service made keeps it honest:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below and requires the
 *     committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` — real guards, real
 *     router — and requires the same bytes, so the documentation module cannot drift from the
 *     application;
 *   - the same suite provokes the documented refusals against the real API.
 *
 * Payload shapes come from the Zod schemas the pipes validate with, converted by
 * `toJsonSchema`; Nest supplies paths, methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/inventory-service openapi:generate`.
 */

/** Pinned so the committed document is deterministic. */
export const INVENTORY_VERSION = '0.1.0';

const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();

const cursorPageOf = (item: z.ZodTypeAny) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    })
    .strict();

/** Success responses, each with the status the handler actually answers. */
export const RESPONSE_BODIES: Record<string, { status: '200' | '201'; schema: z.ZodTypeAny }> = {
  'GET /v1/warehouses': { status: '200', schema: cursorPageOf(warehouseViewSchema) },
  'GET /v1/warehouses/{id}': { status: '200', schema: warehouseViewSchema },
  'POST /v1/warehouses': { status: '201', schema: warehouseViewSchema },
  'GET /v1/stock': { status: '200', schema: cursorPageOf(stockItemViewSchema) },
  'GET /v1/stock/movements': { status: '200', schema: cursorPageOf(stockMovementViewSchema) },
  'GET /v1/stock/{id}': { status: '200', schema: stockItemViewSchema },
  'POST /v1/stock/receipts': { status: '201', schema: stockChangeViewSchema },
  'POST /v1/stock/adjustments': { status: '201', schema: stockChangeViewSchema },
  'GET /v1/stock/reservations': { status: '200', schema: cursorPageOf(reservationViewSchema) },
  'GET /v1/stock/reservations/{id}': { status: '200', schema: reservationViewSchema },
  'POST /v1/stock/reservations': { status: '201', schema: reservationBatchViewSchema },
  'POST /v1/stock/reservations/{id}/release': { status: '200', schema: reservationViewSchema },
  'POST /v1/stock/reservations/{id}/issue': { status: '200', schema: reservationViewSchema },
  'GET /v1/shipments': { status: '200', schema: cursorPageOf(shipmentViewSchema) },
  'GET /v1/shipments/{id}': { status: '200', schema: shipmentViewSchema },
  'GET /v1/shipments/{id}/tracking': { status: '200', schema: trackingViewSchema },
  'POST /v1/shipments': { status: '201', schema: shipmentViewSchema },
  'POST /v1/shipments/{id}/dispatch': { status: '200', schema: shipmentViewSchema },
  'POST /v1/shipments/{id}/deliver': { status: '200', schema: shipmentViewSchema },
  'GET /v1/return-shipments': { status: '200', schema: cursorPageOf(returnShipmentViewSchema) },
  'GET /v1/return-shipments/{id}': { status: '200', schema: returnShipmentViewSchema },
  'GET /v1/return-shipments/{id}/tracking': { status: '200', schema: returnTrackingViewSchema },
  'POST /v1/return-shipments': { status: '201', schema: returnShipmentViewSchema },
  'POST /v1/return-shipments/{id}/receive': { status: '200', schema: returnShipmentViewSchema },
  'POST /v1/return-shipments/{id}/inspection': { status: '200', schema: returnShipmentViewSchema },
  'POST /v1/return-shipments/{id}/resolution': { status: '200', schema: returnShipmentViewSchema },
  // Internal (Q-133 (9)): marketplace-service asks before a cancellation and a release.
  'GET /v1/internal/return-requests/{id}/return-shipment': {
    status: '200',
    schema: returnRequestShipmentViewSchema,
  },
  'POST /v1/internal/return-requests/{id}/dispatch-withdrawal': {
    status: '200',
    schema: dispatchWithdrawalViewSchema,
  },
};

/**
 * The internal routes' credential: a service's internal token in `X-Internal-Token` and nothing
 * else — `AuthGuard` judges a request that also carries `Authorization` on that bearer token, as a
 * user (marketplace-service's and contract-service's documents say the same).
 */
export const INTERNAL_TOKEN_SCHEME = 'internalToken';

export const INTERNAL_TOKEN_API_KEY = {
  type: 'apiKey' as const,
  in: 'header',
  name: 'X-Internal-Token',
  description:
    'A service’s internal token (ADR-061 § 4), signed for the organization it acts for. Sent alone: a request that also carries an `Authorization` bearer token is judged on that token, as a user.',
};

const isInternal = (path: string): boolean => path.startsWith('/v1/internal/');

/** The internal routes' bodies: no Idempotency-Key — each is idempotent by itself. */
const INTERNAL_REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/internal/return-requests/{id}/dispatch-withdrawal': withdrawDispatchSchema,
};

/** What an internal route can answer besides its 200: one named service, no user, no 404. */
const INTERNAL_ERRORS: Record<number, string> = {
  400: 'The path names no return request (`RET_<ULID>`), or the body does not match the published schema.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not the service this route answers: any user token (whatever its roles), another service’s internal token, or an internal token signed for no organization.',
  409: 'The request’s dispatch lock was held past INVENTORY_LOCK_TIMEOUT_MS, or no database connection or transaction was to be had within the budget (CONFLICT, with Retry-After): nothing was withdrawn; ask again.',
  422: 'The reservation was withdrawn for another return request (BUSINESS_RULE_VIOLATION): nothing was withdrawn.',
  500: 'Unexpected server error.',
};

/** Every command takes a strict body, and every command requires an Idempotency-Key. */
const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/warehouses': createWarehouseSchema,
  'POST /v1/stock/receipts': receiveStockSchema,
  'POST /v1/stock/adjustments': adjustStockSchema,
  'POST /v1/stock/reservations': reserveStockSchema,
  'POST /v1/stock/reservations/{id}/release': endReservationSchema,
  'POST /v1/stock/reservations/{id}/issue': endReservationSchema,
  'POST /v1/shipments': createShipmentSchema,
  'POST /v1/shipments/{id}/dispatch': moveShipmentSchema,
  'POST /v1/shipments/{id}/deliver': moveShipmentSchema,
  'POST /v1/return-shipments': createReturnShipmentSchema,
  'POST /v1/return-shipments/{id}/receive': receiveReturnShipmentSchema,
  'POST /v1/return-shipments/{id}/inspection': inspectReturnShipmentSchema,
  'POST /v1/return-shipments/{id}/resolution': resolveReturnShipmentSchema,
};

/** The area whose closed reasons a command's refusals carry in `details[].code` (docs/06 § 6.7). */
const REFUSAL_AREA_OF: Record<string, RefusalArea> = {
  'POST /v1/stock/receipts': 'stock',
  'POST /v1/stock/adjustments': 'stock',
  'POST /v1/stock/reservations': 'reservation',
  'POST /v1/stock/reservations/{id}/release': 'reservation',
  'POST /v1/stock/reservations/{id}/issue': 'reservation',
  'POST /v1/shipments/{id}/dispatch': 'shipment',
  'POST /v1/shipments/{id}/deliver': 'shipment',
  'POST /v1/return-shipments': 'returnShipment',
  'POST /v1/return-shipments/{id}/receive': 'returnShipment',
  'POST /v1/return-shipments/{id}/inspection': 'returnShipment',
  'POST /v1/return-shipments/{id}/resolution': 'returnShipment',
};

/** The stock commands: they lock stock items and may break a stock rule (422). */
const STOCK_COMMANDS: ReadonlySet<string> = new Set(
  Object.entries(REFUSAL_AREA_OF)
    .filter(([, area]) => area !== 'shipment' && area !== 'returnShipment')
    .map(([key]) => key),
);

/**
 * The non-stock commands with a rule to break (422): a dispatch must match the return request
 * marketplace holds, a receipt must match what was dispatched, and a resolution must name allowed
 * dispositions that add up to what was received.
 */
const RECEIPT_COMMANDS: ReadonlySet<string> = new Set([
  'POST /v1/return-shipments',
  'POST /v1/return-shipments/{id}/receive',
  'POST /v1/return-shipments/{id}/resolution',
]);

/**
 * The commands that ask another service before their transaction (A-13): a return shipment reads
 * and reserves its return request in marketplace-service, and is refused when it cannot.
 */
const UPSTREAM_COMMANDS: ReadonlySet<string> = new Set(['POST /v1/return-shipments']);

/** Commands whose **body** names an existing row of the caller's — another's is 404. */
const BODY_NAMES_A_ROW: ReadonlySet<string> = new Set([
  ...STOCK_COMMANDS,
  'POST /v1/shipments',
  'POST /v1/return-shipments',
]);

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/warehouses': listWarehousesQuerySchema,
  'GET /v1/stock': listStockQuerySchema,
  'GET /v1/stock/movements': listMovementsQuerySchema,
  'GET /v1/stock/reservations': listReservationsQuerySchema,
  'GET /v1/shipments': listShipmentsQuerySchema,
  'GET /v1/return-shipments': listReturnShipmentsQuerySchema,
};

/** `Retry-After` on a command's 409 CONFLICT: optional, only that 409 carries it. */
const RETRY_AFTER_HEADER = {
  required: false,
  description:
    'Sent only with CONFLICT — this Idempotency-Key is still being processed, or a stock item or ' +
    'shipment another request holds was not released within INVENTORY_LOCK_TIMEOUT_MS, or no database ' +
    'connection or transaction was to be had within the budget, or reservations past their ' +
    'expiresAt whose release would reverse the refusal are still being released: the seconds ' +
    'to wait before retrying with the same key. Absent on every other 409.',
  schema: { type: 'integer', minimum: RETRY_AFTER_MIN_SECONDS, maximum: RETRY_AFTER_MAX_SECONDS },
};

/** One status of a command: `details[]` typed by area, with the closed codes answered with it. */
function refusalErrorSchema(area: RefusalArea, status: number): z.ZodTypeAny | undefined {
  const codes = Object.entries(REFUSAL_REASONS[area])
    .filter(([, answered]) => answered === status)
    .map(([code]) => code);
  if (codes.length === 0) return undefined;
  return apiErrorSchema.extend({
    details: z
      .array(
        z
          .object({
            path: z.literal(area),
            code: z.enum(codes as [string, ...string[]]),
            message: z.string(),
          })
          .strict(),
      )
      .optional(),
  });
}

const REFUSAL_DETAILS_NOTE =
  ' When refused for a closed reason, `details` names it: one entry, `path` the area (stock, ' +
  'reservation, shipment, returnShipment) and `code` the reason, one of those listed here. Branch on `code` and ' +
  '`details[].code`, never on `message`.';

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query or body does not match the published schema. Unknown parameters and fields are refused rather than ignored; on a command, a missing or malformed Idempotency-Key is a 400 too.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: no role of INVENTORY_OPERATOR_ROLES (commands) or INVENTORY_READER_ROLES / INVENTORY_OPERATOR_ROLES (reads) — or, for a shipment read, INVENTORY_CONSIGNEE_READER_ROLES — in the organization the request acts for (INSUFFICIENT_ROLE); acting for an organization the caller is not a member of (TENANT_MISMATCH); the oversight role, the platform administrator, a service token, a caller acting for no organization, or a user token without the platform user id on a command (FORBIDDEN) — on a command, before its Idempotency-Key is claimed or replayed; on creating a warehouse, a body naming another organization (FORBIDDEN); a shipment’s consignee dispatching or delivering it (FORBIDDEN — only the origin warehouse’s owner moves a shipment).',
  404: 'Not found — also returned for a warehouse, stock item, reservation or shipment of another organization (for a shipment: neither the owner of its origin warehouse nor its consignee, ADR-056 § 5), and, when a return shipment is recorded, for a return request marketplace-service does not hold with the acting organization as its supplier — so its existence is never disclosed.',
  409: 'An Idempotency-Key reused with a different request or user, or one that already applied this command (to the stock item, or as this shipment or tracking event) (IDEMPOTENCY_KEY_REUSED); the same key still in flight, a stock item or shipment another request held past INVENTORY_LOCK_TIMEOUT_MS, no database connection or transaction within the command’s budget, or a reservation or adjustment refused only while reservations past their expiresAt — whose release would make room — are still being released (CONFLICT, with Retry-After — retry with the same key); `expectedVersion` that is not the current version (OPTIMISTIC_LOCK_FAILED); a reservation that is no longer ACTIVE (INVALID_STATE_TRANSITION, RESERVATION_NOT_ACTIVE); a shipment not in the status the move starts from (INVALID_STATE_TRANSITION, SHIPMENT_NOT_CREATED / SHIPMENT_NOT_DISPATCHED).',
  422: 'Well-formed but refused by a rule (BUSINESS_RULE_VIOLATION): not enough available stock (INSUFFICIENT_AVAILABLE_STOCK — all or nothing), on hand below what is reserved (ON_HAND_WOULD_BE_NEGATIVE), a balance past the largest quantity stored (QUANTITY_OUT_OF_RANGE), lines of two warehouses (LINES_SPAN_WAREHOUSES), an expiresAt out of range (EXPIRY_OUT_OF_RANGE), a holder other than the owner (HOLDER_NOT_OWNER, Q-104). Final: a refusal no pending expiry could reverse — a line beyond on hand, an adjustment below zero or below what live reservations hold — is a 422 at once.',
  500: 'Unexpected server error.',
  503: 'marketplace-service, which owns the return request, could not be asked or gave no usable answer (UPSTREAM_UNAVAILABLE): the return shipment is not recorded and its dispatch not reserved; retry with the same Idempotency-Key.',
  504: 'marketplace-service did not answer within INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS (UPSTREAM_TIMEOUT): the return shipment is not recorded; retry with the same Idempotency-Key.',
};

const DESCRIPTION =
  'Inventory and forward logistics (COM-006, ADR-056). Warehouses — of any organization, never ' +
  'assumed to be a union — and, per product and warehouse, a stock item whose balance (on hand, ' +
  'reserved, available = on hand − reserved) changes only through an append-only ledger of ' +
  'movements: RECEIPT, ADJUSTMENT, and the RESERVE / RELEASE / ISSUE of reservations. Every ' +
  'command is one transaction that locks the stock items it touches in ascending id order ' +
  '(PostgreSQL row locks, no Redis — ADR-056 § 4), so the balance, its movement and its event ' +
  'commit together; the database refuses a negative or over-reserved balance and any balance ' +
  'that does not equal the sum of its movements. Everything is the warehouse owner’s: another ' +
  'organization gets 404. Every command requires an Idempotency-Key. Products, orders and ' +
  'purchase orders are opaque references to the services that own them (Q-105); quantities are ' +
  'whole numbers of a product’s base unit. Shipments leave an owner’s warehouse for a consignee ' +
  'organization, CREATED → DISPATCHED → DELIVERED with a tracking event for each, moved only by ' +
  'the owner and read by the owner and the consignee alone (ADR-056 § 2, § 5); a shipment moves ' +
  'no stock.';

/** Builds the finished document for a booted application. */
export function buildInventoryOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Inventory Service')
      .setDescription(DESCRIPTION)
      .setVersion(INVENTORY_VERSION)
      .addBearerAuth()
      .addApiKey(INTERNAL_TOKEN_API_KEY, INTERNAL_TOKEN_SCHEME)
      .build(),
  );
  return enrichOpenApiDocument(document);
}

/**
 * The controllers and nothing else, so the generator needs no database, broker or JWKS endpoint
 * and produces the same bytes on every machine. The controllers in `AppModule`'s order.
 */
@Module({
  controllers: [
    WarehouseController,
    ReservationController,
    StockController,
    ShipmentController,
    ReturnShipmentController,
    InternalReturnRequestController,
  ],
  providers: [
    { provide: ReturnDispatchFenceService, useValue: {} },
    { provide: WarehouseService, useValue: {} },
    { provide: StockService, useValue: {} },
    { provide: ReservationService, useValue: {} },
    { provide: ShipmentService, useValue: {} },
    { provide: ReturnShipmentService, useValue: {} },
    { provide: IdempotencyStore, useValue: {} },
  ],
})
class DocumentationModule {}

export async function buildDocumentationApp(): Promise<INestApplication> {
  const app = await NestFactory.create(DocumentationModule, { logger: false });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  return app;
}

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      if (isInternal(path)) {
        enrichInternalOperation(key, operation);
        continue;
      }

      // `addBearerAuth()` declares the scheme; it does not apply it. Without this the contract
      // would describe endpoints anybody can call.
      operation.security ??= [{ bearer: [] }];

      const query = QUERY_SCHEMAS[key];
      const body = REQUEST_BODIES[key];
      operation.parameters = operation.parameters ?? [];
      if (query) {
        operation.parameters = [...operation.parameters, ...toQueryParameters(query)];
      }
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(body) } },
        };
        // Nest's `@ApiHeader` has no schema; replaced with the truth: required, bounded.
        operation.parameters = operation.parameters.filter(
          (parameter) => !isHeader(parameter, 'idempotency-key'),
        );
        operation.parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Required, 8 to 255 characters. The same key with the same body from the same user returns the first response and does nothing again; with a different body or user, 409 IDEMPOTENCY_KEY_REUSED; while the first request is still in flight, 409 CONFLICT with Retry-After. Scoped to the organization, kept for INVENTORY_IDEMPOTENCY_TTL_HOURS (24 by default) — and, for a stock command, applied at most once per stock item for good.',
          schema: { type: 'string', minLength: 8, maxLength: 255 },
        });
      }

      const response = RESPONSE_BODIES[key];
      operation.responses ??= {};
      if (response) {
        // Nest publishes a default `200` for every GET and `201` for every POST; only the status
        // the handler answers is kept.
        delete operation.responses['200'];
        delete operation.responses['201'];
        operation.responses[response.status] = {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(response.schema) } },
        };
      }

      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
        // A route with no `{id}` names no existing row — except a command whose body does.
        if (status === '404' && !path.includes('{id}') && !BODY_NAMES_A_ROW.has(key)) continue;
        // Only a route with a query or a body can answer 400 (the id is an opaque string).
        if (status === '400' && !query && !body) continue;
        // 409 is a command's; 422 a stock command's — creating a warehouse or moving a shipment
        // has no rule to break, only a state to be in (409).
        if (status === '409' && !body) continue;
        if (status === '422' && !STOCK_COMMANDS.has(key) && !RECEIPT_COMMANDS.has(key)) continue;
        if ((status === '503' || status === '504') && !UPSTREAM_COMMANDS.has(key)) continue;
        operation.responses[status] ??= {
          description,
          ...(status === '409' && body ? { headers: { 'Retry-After': RETRY_AFTER_HEADER } } : {}),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }

      // The closed reasons of a command, as an enum per status.
      const area = REFUSAL_AREA_OF[key];
      if (area) {
        for (const status of [409, 422]) {
          const typed = refusalErrorSchema(area, status);
          if (!typed) continue;
          const existing = operation.responses[String(status)] as
            { description?: string } | undefined;
          // A command that cannot answer this status (inspecting a return shipment breaks no 422
          // rule) has nothing to type.
          if (!existing) continue;
          const listed = Object.entries(REFUSAL_REASONS[area])
            .filter(([, answered]) => answered === status)
            .map(([code]) => code)
            .join(', ');
          operation.responses[String(status)] = {
            ...existing,
            description: `${existing.description ?? ''}${REFUSAL_DETAILS_NOTE} (${area}: ${listed})`,
            content: { 'application/json': { schema: toJsonSchema(typed) } },
          };
        }
      }
    }
  }

  return document;
}

/**
 * An internal route (ADR-061 § 4): the internal token's scheme, never the bearer one; its body,
 * with no Idempotency-Key; its one success; and only the errors it can give.
 */
function enrichInternalOperation(key: string, operation: MutableOperation): void {
  operation.security = [{ [INTERNAL_TOKEN_SCHEME]: [] }];
  const body = INTERNAL_REQUEST_BODIES[key];
  if (body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: toJsonSchema(body) } },
    };
  }
  operation.responses ??= {};
  const response = RESPONSE_BODIES[key];
  if (response) {
    delete operation.responses['200'];
    delete operation.responses['201'];
    operation.responses[response.status] = {
      description: 'Success',
      content: { 'application/json': { schema: toJsonSchema(response.schema) } },
    };
  }
  for (const [status, description] of Object.entries(INTERNAL_ERRORS)) {
    // Only the withdrawal writes, so only it can contend for the lock or be refused.
    if ((status === '409' || status === '422') && !body) continue;
    operation.responses[status] = {
      description,
      ...(status === '409' ? { headers: { 'Retry-After': RETRY_AFTER_HEADER } } : {}),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
  }
}

/**
 * The committed file's exact bytes: Prettier over two-space JSON, through the CLI so the
 * repository config applies exactly as `pnpm format:check` sees it.
 */
export function formatDocument(document: OpenAPIObject, filePath: string): string {
  const cli = require.resolve('prettier/bin/prettier.cjs');
  const result = spawnSync(
    process.execPath,
    [cli, '--parser', 'json', '--stdin-filepath', filePath],
    { input: JSON.stringify(document, null, 2), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`prettier failed to format the OpenAPI document: ${result.stderr}`);
  }
  return result.stdout;
}

interface MutableOperation {
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: Record<string, string[]>[];
}

function isHeader(parameter: unknown, name: string): boolean {
  const candidate = parameter as { in?: string; name?: string };
  return candidate.in === 'header' && candidate.name?.toLowerCase() === name;
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toQueryParameters(schema: z.ZodType): unknown[] {
  const shape = objectShapeOf(schema);
  if (!shape) return [];

  return Object.entries(shape).map(([name, member]) => ({
    name,
    in: 'query',
    required: !isOptionalField(member),
    schema: toJsonSchema(member),
  }));
}
