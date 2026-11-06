import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter, StrictQueryParserInstaller } from '@rasta/nest-common';
import { ClaimService } from '../insurance/claim.service';
import { InsuranceService } from '../insurance/insurance.service';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { IdempotencyStore } from './idempotency';

/**
 * A filter hidden behind 1000 empty query segments (FU-072), through the real
 * `AssetController` and its `GET /v1/assets` validation pipe. Express's default
 * parser dropped it and the list answered unfiltered; with the installer that
 * AppModule provides (app.module.query-parser.spec.ts) it is a 400 and the
 * service is never asked.
 */
describe('GET /v1/assets with a padded query string (FU-072)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const assets = { list: jest.fn() };

  async function boot(strict: boolean): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetController],
      providers: [
        ...(strict ? [StrictQueryParserInstaller] : []),
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: {} },
        { provide: ClaimService, useValue: {} },
        { provide: IdempotencyStore, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter(QUIET_LOGGER as never));
    await app.init();
    return app;
  }

  const padded = '&'.repeat(1000) + 'status=x';

  beforeEach(() => {
    assets.list.mockReset().mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  });

  it('Express default (before FU-072): the filter vanishes and the list answers unfiltered', async () => {
    const app = await boot(false);
    try {
      await request(app.getHttpServer()).get(`/v1/assets?${padded}`).expect(200);
      expect(assets.list).toHaveBeenCalledTimes(1);
      expect(assets.list.mock.calls[0][0]).not.toHaveProperty('status');
    } finally {
      await app.close();
    }
  });

  it('with the strict parser: 400 VALIDATION_FAILED and the service is never asked', async () => {
    const app = await boot(true);
    try {
      const res = await request(app.getHttpServer()).get(`/v1/assets?${padded}`).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).toContain('QUERY_TOO_MANY_SEGMENTS');
      expect(assets.list).not.toHaveBeenCalled();

      // Under the bound the filter is parsed whole and reaches validation.
      await request(app.getHttpServer())
        .get(`/v1/assets?${'&'.repeat(990)}status=x`)
        .expect(400);
      expect(assets.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
