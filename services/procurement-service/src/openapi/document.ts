import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { RETRY_AFTER_MAX_SECONDS, RETRY_AFTER_MIN_SECONDS } from '@rasta/nest-common';
import { AggregationController, DemandController } from '../demand/demand.controller';
import { DemandService } from '../demand/demand.service';
import {
  aggregationViewSchema,
  demandViewSchema,
  listAggregationsQuerySchema,
  listDemandsQuerySchema,
  submitDemandSchema,
  withdrawDemandSchema,
} from '../demand/dto';
import { IdempotencyStore } from '../shared/idempotency';
import { REFUSAL_REASONS, type RefusalArea } from '../shared/refusal';

/**
 * The published contract of procurement-service — **OpenAPI first**.
 *
 * `docs/api/procurement-service.openapi.json` is committed, so an API change shows in a PR's
 * diff and a client can be generated without running anything. It is the slice of the planned
 * contract (`docs/api/procurement-service.planned.openapi.json`, the operations of ADR-070 plan
 * PR 1) that exists. Three checks keep it honest, the arrangement construction-service made:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below and requires the
 *     committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` — real guards, real
 *     router — and requires the same bytes, so the documentation module cannot drift from the
 *     application;
 *   - the same suite provokes the documented statuses against the real API.
 *
 * Payload shapes come from the Zod schemas the pipes validate with (`src/demand/dto.ts`),
 * converted by `zod-schema.ts`; Nest supplies paths, methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/procurement-service openapi:generate`.
 */

/** Pinned so the committed document is deterministic. */
export const PROCUREMENT_VERSION = '0.1.0';

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
    })
    .strict();

/** Success responses, each with the status the handler actually answers. */
export const RESPONSE_BODIES: Record<string, { status: '200' | '201'; schema: z.ZodTypeAny }> = {
  'POST /v1/demand-requests': { status: '201', schema: demandViewSchema },
  'GET /v1/demand-requests': { status: '200', schema: cursorPageOf(demandViewSchema) },
  'GET /v1/demand-requests/{id}': { status: '200', schema: demandViewSchema },
  'POST /v1/demand-requests/{id}/withdraw': { status: '200', schema: demandViewSchema },
  'GET /v1/aggregations': { status: '200', schema: cursorPageOf(aggregationViewSchema) },
  'GET /v1/aggregations/{id}': { status: '200', schema: aggregationViewSchema },
};

/** Every command takes a strict body. */
const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/demand-requests': submitDemandSchema,
  'POST /v1/demand-requests/{id}/withdraw': withdrawDemandSchema,
};

/** The commands that require an `Idempotency-Key` (docs/06 § 6.8): every one. */
const IDEMPOTENT_COMMANDS: ReadonlySet<string> = new Set(Object.keys(REQUEST_BODIES));

/** The area whose closed reasons a command's refusals carry in `details[].code` (docs/06 § 6.7). */
const REFUSAL_AREA_OF: Record<string, RefusalArea> = {
  'POST /v1/demand-requests': 'submission',
  'POST /v1/demand-requests/{id}/withdraw': 'withdrawal',
};

/** `Retry-After` on a command's in-flight 409: optional, only that 409 carries it. */
const RETRY_AFTER_HEADER = {
  required: false,
  description:
    'Sent only when this Idempotency-Key is still being processed, or the window of the product ' +
    'changed meanwhile (CONFLICT): the seconds to wait before retrying with the same key. Absent ' +
    'on every other 409.',
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
  ' When refused for a closed reason, `details` names it: one entry, `path` the area ' +
  '(submission or withdrawal) and `code` the reason, one of those listed here. Branch on `code` and ' +
  '`details[].code`, never on `message`.';

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/demand-requests': listDemandsQuerySchema,
  'GET /v1/aggregations': listAggregationsQuerySchema,
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query or body does not match the published schema. Unknown parameters and fields are refused rather than ignored; on a command, a missing or malformed Idempotency-Key is a 400 too.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: a role PROCUREMENT_DEMAND_ROLES does not grant in the organization the request acts for (INSUFFICIENT_ROLE), the oversight role (AUDITOR), the platform administrator (SYSTEM_ADMIN, whatever organization it selected — it never acts for a buyer), a service-to-service token, a caller acting for no organization, or — on a command — a user token without the platform user id. Refused before anything is read, so it discloses nothing.',
  404: 'Not found — also returned for a demand or aggregation of any other organization, so its existence is never disclosed.',
  409: 'On a command: an Idempotency-Key reused with a different request or user (IDEMPOTENCY_KEY_REUSED) or still in flight (CONFLICT, with Retry-After); the window of the product opened or ended by another request at the same moment, more than a few times (CONFLICT, with Retry-After — retry); on withdraw, `expectedVersion` that is not the demand’s current version (OPTIMISTIC_LOCK_FAILED — reload and retry).',
  422: 'Well-formed but refused by the lifecycle (BUSINESS_RULE_VIOLATION): on submit, a demand that would take the total of the window it joins past 2147483647, the most an RFQ and a purchase order can state (AGGREGATION_QUANTITY_LIMIT_EXCEEDED; nothing is written); on withdraw, a demand that is not SUBMITTED (DEMAND_NOT_SUBMITTED) or whose window has ended — its aggregation is no longer OPEN, or the database clock is at or past closesAt (AGGREGATION_WINDOW_ENDED: the demand set is frozen).',
  500: 'Unexpected server error.',
};

const DESCRIPTION =
  'The procurement boundary (COM-007, ADR-070). An organization registers its needs — a quantity ' +
  'of a product, the product an opaque marketplace identifier that is never checked there ' +
  '(Q-105) — and each joins the one OPEN aggregation of (organization, product), or opens it. ' +
  'A window is open from its first demand for PROCUREMENT_AGGREGATION_WINDOW_HOURS (Q-10), ' +
  'half-open [openedAt, closesAt) by the database clock read after the aggregation’s lock: a ' +
  'demand at or after closesAt never joins it, and ends it instead — READY when it holds a demand ' +
  'and reaches its threshold (a quantity, never an amount), otherwise its snapshot’s shortfall ' +
  'policy: EXTEND, REFER (a fact only) or CLOSE — before joining the window that follows. Each ' +
  'aggregation keeps the settings it opened with. Aggregation never spans organizations (Q-119); ' +
  'only the buyer’s own organization reads or changes its demands, anyone else gets 404. Every ' +
  'change is an event on rasta.procurement.v1 — identifiers, quantities and instants, never a ' +
  'note, a reason or an amount — and so an audit record. RFQs, sealed quotations, evaluation and ' +
  'purchase orders follow (ADR-070 plan PRs 2 to 14); nothing here moves money.';

/** Builds the finished document for a booted application. */
export function buildProcurementOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Procurement Service')
      .setDescription(DESCRIPTION)
      .setVersion(PROCUREMENT_VERSION)
      .addBearerAuth()
      .build(),
  );
  return enrichOpenApiDocument(document);
}

/**
 * The controllers and nothing else, so the generator needs no database, broker or JWKS
 * endpoint and produces the same bytes on every machine.
 */
@Module({
  controllers: [DemandController, AggregationController],
  providers: [
    { provide: DemandService, useValue: {} },
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

      // `addBearerAuth()` declares the scheme; it does not apply it. Without this the
      // contract would describe endpoints anybody can call. No route answers an internal token
      // yet: the first is `GET /v1/internal/purchase-orders/{id}` (ADR-070 plan PR 12), which
      // brings the `internalToken` scheme of the planned contract with it.
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
      }
      const idempotent = IDEMPOTENT_COMMANDS.has(key);
      if (idempotent) {
        // Nest's `@ApiHeader` has no schema; replaced with the truth: required, bounded.
        operation.parameters = operation.parameters.filter(
          (parameter) => !isHeader(parameter, 'idempotency-key'),
        );
        operation.parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Required, 8 to 255 characters. The same key with the same body from the same user returns the first response and does nothing again; with a different body or user, 409 IDEMPOTENCY_KEY_REUSED; while the first request is still in flight, 409 CONFLICT with Retry-After. Scoped to the organization, kept for PROCUREMENT_IDEMPOTENCY_TTL_HOURS (24 by default).',
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
        // A route with no `{id}` names no existing row, so it cannot answer 404.
        if (status === '404' && !path.includes('{id}')) continue;
        // Only a route with a query or a body can answer 400 (the id is an opaque string).
        if (status === '400' && !query && !body) continue;
        // 409 and 422 are a command's: a read has no state to move and no rule to refuse.
        if ((status === '409' || status === '422') && !body) continue;
        operation.responses[status] ??= {
          description,
          ...(status === '409' && idempotent
            ? { headers: { 'Retry-After': RETRY_AFTER_HEADER } }
            : {}),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }

      // The closed reasons of a command, as an enum per status.
      const area = REFUSAL_AREA_OF[key];
      if (area) {
        for (const status of [403, 409, 422]) {
          const typed = refusalErrorSchema(area, status);
          if (!typed) continue;
          const existing = operation.responses[String(status)] as { description?: string };
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

function toQueryParameters(schema: z.ZodTypeAny): unknown[] {
  const shape = objectShapeOf(schema);
  if (!shape) return [];

  return Object.entries(shape).map(([name, member]) => ({
    name,
    in: 'query',
    required: !member.isOptional(),
    schema: toJsonSchema(member),
  }));
}

function objectShapeOf(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  // JUSTIFIED-ANY: zod's `_def` is untyped across its type-kinds, and the walk
  // below re-checks the kind before reading a field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema;

  for (let depth = 0; depth < 10; depth += 1) {
    const typeName = current?._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
      return (current as z.ZodObject<z.ZodRawShape>).shape;
    }
    if (
      typeName === z.ZodFirstPartyTypeKind.ZodEffects ||
      typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      typeName === z.ZodFirstPartyTypeKind.ZodDefault
    ) {
      current =
        typeName === z.ZodFirstPartyTypeKind.ZodEffects
          ? current._def.schema
          : current._def.innerType;
      continue;
    }
    return undefined;
  }

  return undefined;
}
