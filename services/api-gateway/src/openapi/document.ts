import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { publishApiErrors } from '@rasta/nest-common';
import { GatewayHealthController, GatewayMetricsController } from '../app.module';
import { GatewayController } from '../proxy/gateway.controller';
import { GATEWAY_ENV } from '../tokens';
import { ProxyService } from '../proxy/proxy.service';
import { RateLimiter } from '../proxy/rate-limiter';

/** The builder used by the real application and the documentation fixture. */
export function buildGatewayOpenApiDocument(
  app: INestApplication,
  version = '0.1.0',
): OpenAPIObject {
  return publishApiErrors(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rasta — API Gateway')
        .setDescription(
          'The single entry point for external traffic. Authenticates, resolves the ' +
            'tenant, rate limits and routes. Holds no business logic and no database.',
        )
        .setVersion(version)
        .addBearerAuth()
        .build(),
    ),
  );
}

/** Decorators only: no database, broker, credentials or external requests. */
@Module({
  controllers: [GatewayHealthController, GatewayMetricsController, GatewayController],
  providers: [
    ...[ProxyService, RateLimiter].map((provide) => ({ provide, useValue: {} })),
    { provide: GATEWAY_ENV, useValue: {} },
  ],
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
