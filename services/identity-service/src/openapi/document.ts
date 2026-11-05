import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { publishApiErrors, healthProbeErrorSchema, type PublishedSchema } from '@rasta/nest-common';
import { identityDocumentConfig } from '../openapi-config';
import {
  UserController,
  MembershipController,
  RegistrationController,
} from '../identity/identity.controller';
import { IdentityService } from '../identity/identity.service';
import { AuditCorrectionController } from '../audit-correction/audit-correction.controller';
import { AuditCorrectionService } from '../audit-correction/audit-correction.service';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { HealthController, MetricsController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';
import { spawnSync } from 'node:child_process';

/** What the routes themselves declare, before the shared error envelope is published. */
export function identityRouteDocument(app: INestApplication, version = '0.1.0'): OpenAPIObject {
  return SwaggerModule.createDocument(app, identityDocumentConfig(version));
}

/** D-121: the one registry of probe routes whose 503 is a health body, not the envelope. */
export const IDENTITY_PROBE_EXCEPTIONS: Readonly<Record<string, PublishedSchema>> = {
  'GET /health/ready 503': healthProbeErrorSchema('identity-service', 'ready'),
  'GET /health/startup 503': healthProbeErrorSchema('identity-service', 'startup', [
    'database',
    'keycloak',
  ]),
};

/** The builder used by the real application and the documentation fixture. */
export function buildIdentityOpenApiDocument(
  app: INestApplication,
  version = '0.1.0',
): OpenAPIObject {
  return publishApiErrors(identityRouteDocument(app, version), IDENTITY_PROBE_EXCEPTIONS);
}

/** Decorators only: no database, broker, credentials or external requests. */
@Module({
  controllers: [
    UserController,
    MembershipController,
    RegistrationController,
    AuditCorrectionController,
    HealthController,
    MetricsController,
  ],
  providers: [
    IdentityService,
    AuditCorrectionService,
    PrismaService,
    KafkaEventPublisher,
    KeycloakAdminClient,
  ].map((provide) => ({ provide, useValue: {} })),
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
