import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { toJsonSchema } from '@rasta/nest-common';
import { DashboardController } from '../maintenance/dashboard.controller';
import { DashboardService } from '../maintenance/dashboard.service';
import { fleetDashboardQuerySchema, fleetDashboardViewSchema } from '../maintenance/dto';

/**
 * The published contract of analytics-service — **OpenAPI first**.
 *
 * `docs/api/analytics-service.openapi.json` is committed, so an API change shows in a PR's diff
 * and a client can be generated without running anything. Two checks keep it honest, the
 * arrangement construction-service and contract-service made:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below and requires the
 *     committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` — real guards, real
 *     router — and requires the same bytes, so the documentation module cannot drift from the
 *     application.
 *
 * Payload shapes come from the Zod schemas the pipes validate with (`src/maintenance/dto.ts`),
 * converted by `toJsonSchema`; Nest supplies paths, methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/analytics-service openapi:generate`.
 */

/** Pinned so the committed document is deterministic. */
export const ANALYTICS_VERSION = '0.1.0';

const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();

/** Success responses, each with the status the handler actually answers. */
export const RESPONSE_BODIES: Record<string, { status: '200'; schema: z.ZodTypeAny }> = {
  'GET /v1/dashboards/fleet': { status: '200', schema: fleetDashboardViewSchema },
};

/** Query parameters, from the schema the pipe validates with. */
export const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/dashboards/fleet': fleetDashboardQuerySchema,
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query does not match the published schema, or the window does not start before it ends. Unknown parameters are refused rather than ignored.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: a role the configuration (ANALYTICS_FLEET_DASHBOARD_ROLES) does not grant (INSUFFICIENT_ROLE), the oversight role (AUDITOR reads aggregate governance views only), a service-to-service token, or a SYSTEM_ADMIN that has not selected an organization with X-Organization-Id.',
  500: 'Unexpected server error.',
};

const DESCRIPTION =
  'Event-driven read models (RUN-001, ADR-071). Every number here is built from the domain ' +
  'events this service received — never from another service’s database — and only for the ' +
  'organization the request acts for. This release offers the maintenance part of the fleet ' +
  'dashboard, from MAINTENANCE_COMPLETED. Amounts are decimal strings of minor units, per ' +
  'currency. No route writes, and no parameter names an organization, a subtree or a scope. ' +
  'The governance view (aggregate-only, for AUDITOR) is not served yet; when it is, it answers ' +
  'only an organization that is a root of the hierarchy, as one group, for one closed period, ' +
  'from an immutable release — never a child subtree, never live facts (ADR-071 § 5). The ' +
  'KPIs with INSUFFICIENT_BASELINE and the other dashboards follow (ADR-071 implementation plan).';

/** Builds the finished document for a booted application. */
export function buildAnalyticsOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Analytics Service')
      .setDescription(DESCRIPTION)
      .setVersion(ANALYTICS_VERSION)
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
  controllers: [DashboardController],
  providers: [{ provide: DashboardService, useValue: {} }],
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

      // `addBearerAuth()` declares the scheme; it does not apply it. Without this the contract
      // would describe endpoints anybody can call.
      operation.security ??= [{ bearer: [] }];

      const query = QUERY_SCHEMAS[key];
      operation.parameters = operation.parameters ?? [];
      if (query) {
        operation.parameters = [...operation.parameters, ...toQueryParameters(query)];
      }

      const response = RESPONSE_BODIES[key];
      operation.responses ??= {};
      if (response) {
        delete operation.responses['200'];
        operation.responses[response.status] = {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(response.schema) } },
        };
      }

      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
        // Only a route with a query can answer 400; no route names a row, so none answers 404.
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
  // JUSTIFIED-ANY: zod's `_def` is untyped across its type-kinds, and the walk below re-checks
  // the kind before reading a field.
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
