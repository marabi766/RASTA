import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { publishApiErrors, healthProbeErrorSchema } from '@rasta/nest-common';
import { AssetController } from '../asset/asset.controller';
import { AssetInternalController, TransferRecordService } from '../asset/transfer-record';
import { AssetSnapshotService } from '../asset/asset-snapshot';
import { InsurancePolicyStandingService } from '../insurance/policy-standing';
import { AssetService } from '../asset/asset.service';
import { InsuranceService } from '../insurance/insurance.service';
import { ClaimService } from '../insurance/claim.service';
import { IdempotencyStore } from '../asset/idempotency';
import { HealthController, MetricsController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';

/** The builder used by the real application and the documentation fixture. */
export function buildAssetOpenApiDocument(app: INestApplication, version = '0.1.0'): OpenAPIObject {
  return publishApiErrors(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rasta — Asset Service')
        .setDescription(
          'The asset is the centre of the platform, not the user. Every machine ' +
            'carries an electronic dossier assembled from the events other services ' +
            'publish about it — usage, maintenance, insurance, cost and location.',
        )
        .setVersion(version)
        .addBearerAuth()
        .build(),
    ),
    {
      'GET /health/ready 503': healthProbeErrorSchema('asset-service', 'ready'),
      'GET /health/startup 503': healthProbeErrorSchema('asset-service', 'startup'),
    },
  );
}

/** Decorators only: no database, broker, credentials or external requests. */
@Module({
  controllers: [AssetController, AssetInternalController, HealthController, MetricsController],
  providers: [
    AssetService,
    TransferRecordService,
    AssetSnapshotService,
    InsurancePolicyStandingService,
    InsuranceService,
    ClaimService,
    IdempotencyStore,
    PrismaService,
    KafkaEventPublisher,
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
