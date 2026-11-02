import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { ClaimService } from '../insurance/claim.service';
import { InsuranceService } from '../insurance/insurance.service';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { IdempotencyStore } from './idempotency';

/**
 * An asset whose name, manufacturer and site carry the Persian comma «،»,
 * semicolon «؛» and question mark «؟», through the real `AssetController` and
 * its validation pipe. The rule is `displayText` in `@rasta/contracts`.
 */
describe('an asset with Persian punctuation (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const assets = { create: jest.fn(), assertVisible: jest.fn() };
  const idempotency = { execute: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: {} },
        { provide: ClaimService, useValue: {} },
        { provide: IdempotencyStore, useValue: idempotency },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter(QUIET_LOGGER as never));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    assets.create.mockReset().mockResolvedValue({ id: 'AST_1' });
    idempotency.execute
      .mockReset()
      .mockImplementation(
        async (
          _endpoint: string,
          _key: string,
          _body: unknown,
          _status: number,
          work: (fence: object) => Promise<unknown>,
        ) => ({ result: await work({}) }),
      );
  });

  const BODY = {
    name: 'گریدر راهسازی، شماره دو',
    type: 'GRADER',
    manufacturer: 'کوماتسو؛ ژاپن',
    location: { siteName: 'انبار مرکزی، دهیاری؟' },
  };

  it('POST /v1/assets accepts «،» «؛» «؟» in name, manufacturer and site', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Idempotency-Key', 'create-asset-0001')
      .send(BODY);

    expect(response.status).toBe(201);
    expect(assets.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: BODY.name, manufacturer: BODY.manufacturer }),
      expect.anything(),
    );
  });

  it('still refuses a bidi control in the name', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Idempotency-Key', 'create-asset-0002')
      .send({ ...BODY, name: `${BODY.name}‮` });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(assets.create).not.toHaveBeenCalled();
  });
});
