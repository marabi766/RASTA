import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { publishApiErrors, healthProbeErrorSchema, type PublishedSchema } from '@rasta/nest-common';
import { OrganizationController } from '../organization/organization.controller';
import { OrganizationService } from '../organization/organization.service';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { toJsonSchema } from '@rasta/nest-common';
import { HealthController, MetricsController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';

/** What the routes themselves declare, before the shared error envelope is published. */
export function organizationRouteDocument(app: INestApplication, version = '0.1.0'): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Organization Service')
      .setDescription(
        'Generic, extensible organization model and hierarchy. Deliberately knows ' +
          'nothing about dehyaris: an organization has a type, and the type is data.',
      )
      .setVersion(version)
      .addBearerAuth()
      .build(),
  );
}

/** D-121: the one registry of probe routes whose 503 is a health body, not the envelope. */
export const ORGANIZATION_PROBE_EXCEPTIONS: Readonly<Record<string, PublishedSchema>> = {
  'GET /health/ready 503': healthProbeErrorSchema('organization-service', 'ready'),
  'GET /health/startup 503': healthProbeErrorSchema('organization-service', 'startup'),
};

/** The builder used by the real application and the documentation fixture. */
export function buildOrganizationOpenApiDocument(
  app: INestApplication,
  version = '0.1.0',
): OpenAPIObject {
  return publishApiErrors(organizationRouteDocument(app, version), ORGANIZATION_PROBE_EXCEPTIONS);
}

/** Decorators only: no database, broker, credentials or external requests. */
@Module({
  controllers: [OrganizationController, HealthController, MetricsController],
  providers: [OrganizationService, PrismaService, KafkaEventPublisher].map((provide) => ({
    provide,
    useValue: {},
  })),
})
export class DocumentationModule {}

export async function buildDocumentationApp(
  configure?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const app = await NestFactory.create(DocumentationModule, { logger: false });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  configure?.(app);
  await app.init();
  return app;
}

/** Keep the committed document scoped to the existing procurement-thresholds read. */
export function buildScopedOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = buildOrganizationOpenApiDocument(app);
  const path = '/v1/organizations/{id}/procurement-thresholds';
  const operation = document.paths[path]!.get!;
  document.openapi = '3.0.3';
  operation.operationId = 'OrganizationController_procurementThresholds';
  operation.description =
    'Service callers only (construction-service). Person/session callers and other services receive 403. The signed token organization must equal the requested id exactly, including when it is an ancestor: otherwise generic 404 without existence details. Returns only the effective inherited-resolved construction.tender.procurement_thresholds key, or null when absent. Bounds are inclusive integer rial strings; minimum must not exceed maximum. Governance values are stored as configured; malformed values fail closed at the construction consumer.';
  // Preserve the existing scoped success contract: raw governance is checked by its consumer.
  const bound = z
    .string()
    .regex(/^[0-9]+$/)
    .nullable();
  const entry = z
    .object({ minAmountMinor: bound, maxAmountMinor: bound, mode: z.enum(['WARN', 'REJECT']) })
    .strict();
  const thresholds = z
    .object({ FORMAL_TENDER: entry, INQUIRY: entry, RFP: entry, MARKETPLACE_DEAL: entry })
    .strict();
  const policy = z.object({ id: z.string().min(1), value: thresholds }).strict();
  const body = z.object({ organizationId: z.string(), policy: policy.nullable() }).strict();
  operation.security = [{ internalToken: [] }];
  operation.responses['200'] = {
    description: 'One effective policy or explicit null',
    content: { 'application/json': { schema: toJsonSchema(body) } },
  };
  for (const [status, description] of Object.entries({
    '401': 'Missing or invalid authentication',
    '403': 'Person/session caller or another service refused',
    '404': 'Token organization mismatch or organization absent; no existence details',
  })) {
    operation.responses[status] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
  }
  document.info.title = 'Rasta Organization Service — procurement thresholds';
  document.info.description =
    'Scoped contract for the procurement-thresholds service read. Other organization routes are documented by the runtime Swagger surface.';
  document.paths = { [path]: { get: operation } };
  document.components!.securitySchemes = {
    internalToken: { type: 'apiKey', in: 'header', name: 'X-Internal-Token' },
  };
  return document;
}

/** Same formatter and repository configuration as the other committed contracts. */
export function formatDocument(document: OpenAPIObject, filePath: string): string {
  const cli = require.resolve('prettier/bin/prettier.cjs');
  const result = spawnSync(
    process.execPath,
    [cli, '--parser', 'json', '--stdin-filepath', filePath],
    {
      input: JSON.stringify(document, null, 2),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error(`prettier failed: ${result.stderr}`);
  return result.stdout;
}
