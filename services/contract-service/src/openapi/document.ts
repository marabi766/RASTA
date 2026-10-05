import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { ContractController } from '../contract/contract.controller';
import { ContractService } from '../contract/contract.service';
import { contractViewSchema, listContractsQuerySchema } from '../contract/dto';

/**
 * The published contract of contract-service — **OpenAPI first**.
 *
 * `docs/api/contract-service.openapi.json` is committed, so an API change shows in a PR's
 * diff and a client can be generated without running anything. Three checks keep it honest,
 * the arrangement construction-service made:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below and requires the
 *     committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` — real guards, real
 *     router — and requires the same bytes, so the documentation module cannot drift from the
 *     application;
 *   - the same suite provokes every documented status against the real API.
 *
 * Payload shapes come from the Zod schemas the pipes validate with (`src/contract/dto.ts`),
 * converted by `zod-schema.ts`; Nest supplies paths, methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/contract-service openapi:generate`.
 */

/** Pinned so the committed document is deterministic. */
export const CONTRACT_VERSION = '0.1.0';

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
  'GET /v1/contracts': { status: '200', schema: cursorPageOf(contractViewSchema) },
  'GET /v1/contracts/{id}': { status: '200', schema: contractViewSchema },
};

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/contracts': listContractsQuerySchema,
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query does not match the published schema. Unknown parameters are refused rather than ignored.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: a role neither the configuration (CONTRACT_READER_ROLES) nor the contractor side grants (INSUFFICIENT_ROLE), the oversight role, a service-to-service token, or a SYSTEM_ADMIN that has not selected an organization with X-Organization-Id.',
  404: 'Not found — also returned for a contract of which the caller’s organization is neither the employer nor the winning contractor, so its existence is never disclosed.',
  500: 'Unexpected server error.',
};

const DESCRIPTION =
  'The contract boundary (CON-003, ADR-068). This release offers reading the draft contract ' +
  'that a tender award creates: the system makes it when construction-service publishes ' +
  'TENDER_AWARDED, after reading the award — and its amount, which is on no event — from ' +
  'construction-service itself (ADR-061 § 4); no user creates one. A contract is read by its ' +
  'two parties only: the employer’s organization and the winning contractor’s; anyone else ' +
  'gets 404. Amounts are decimal strings of minor units (rials). Amendments, milestones, ' +
  'statements with their separate technical and financial approvals, and the settlement ' +
  'boundary with economic-service follow (ADR-068 § 9); no money is ever held here.';

/** Builds the finished document for a booted application. */
export function buildContractOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Contract Service')
      .setDescription(DESCRIPTION)
      .setVersion(CONTRACT_VERSION)
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
  controllers: [ContractController],
  providers: [{ provide: ContractService, useValue: {} }],
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
      // contract would describe endpoints anybody can call.
      operation.security ??= [{ bearer: [] }];

      const query = QUERY_SCHEMAS[key];
      operation.parameters = operation.parameters ?? [];
      if (query) {
        operation.parameters = [...operation.parameters, ...toQueryParameters(query)];
      }

      const response = RESPONSE_BODIES[key];
      operation.responses ??= {};
      if (response) {
        // Nest publishes a default `200` for every GET; only the status the handler answers is kept.
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
        // Only a route with a query can answer 400 (the id is an opaque string).
        if (status === '400' && !query) continue;
        operation.responses[status] ??= {
          description,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
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
