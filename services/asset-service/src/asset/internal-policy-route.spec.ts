import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ALLOW_SERVICE_KEY } from '@rasta/nest-common';
import { InsurancePolicyStandingService } from '../insurance/policy-standing';
import { AssetSnapshotService } from './asset-snapshot';
import { AssetInternalController, TransferRecordService } from './transfer-record';

/**
 * The internal policy route fleet-service verifies `INSURANCE_RECORDED`
 * against (ADR-061 § 4, #240 r6), as the served OpenAPI document and the route
 * metadata describe it. The document is built the way `main.ts` builds it; the
 * providers are stubs because only decorators are read.
 */
describe('GET /v1/internal/assets/{assetId}/insurance-policies/{policyId}', () => {
  const path = '/v1/internal/assets/{assetId}/insurance-policies/{policyId}';
  let operation: Record<string, unknown> | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetInternalController],
      providers: [
        { provide: TransferRecordService, useValue: {} },
        { provide: AssetSnapshotService, useValue: {} },
        { provide: InsurancePolicyStandingService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Rasta — Asset Service').setVersion('test').build(),
    );
    await app.close();
    operation = document.paths[path]?.get as unknown as Record<string, unknown> | undefined;
  });

  it('is in the served document, with both ids as path parameters', () => {
    expect(operation).toBeDefined();
    const parameters = (operation!.parameters as { name: string; in: string }[]).map(
      (parameter) => `${parameter.in}:${parameter.name}`,
    );
    expect(parameters.sort()).toEqual(['path:assetId', 'path:policyId']);
  });

  it('documents the answers it gives: 200, 403 for anyone but fleet-service, 404', () => {
    expect(Object.keys(operation!.responses as object).sort()).toEqual(['200', '403', '404']);
    expect(operation!.description).toMatch(/fleet-service/);
    expect(operation!.description).toMatch(/counts: true/);
  });

  it('is allowed to fleet-service only', () => {
    const handler = AssetInternalController.prototype.insurancePolicy;
    expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, handler)).toEqual(['fleet-service']);
  });
});
