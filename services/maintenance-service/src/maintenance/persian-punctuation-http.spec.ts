import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RequestController } from './request.controller';
import { RequestService } from './request.service';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore } from './idempotency';

/**
 * A maintenance request whose description and title carry the Persian comma
 * «،», semicolon «؛» and question mark «؟» (the demo run of 2026-10-24 was
 * refused with an English message), through the real `RequestController` and
 * its validation pipe. The rule is `displayText` in `@rasta/contracts`.
 */
describe('a maintenance request with Persian punctuation (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const create = jest.fn();
  const approve = jest.fn();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RequestController],
      providers: [
        { provide: RequestService, useValue: { create, approve } },
        { provide: RepairOrderService, useValue: {} },
        { provide: IdempotencyStore, useValue: {} },
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
    create.mockReset().mockResolvedValue({ id: 'MNT-1' });
    approve.mockReset().mockResolvedValue({ id: 'MNT-1' });
  });

  const BODY = {
    assetId: 'AST-SEED-0001',
    type: 'CORRECTIVE',
    severity: 'MEDIUM',
    title: 'خرابی استارت، لودر',
    description: 'موتور روشن نمی‌شود؛ باتری یا استارت؟ لطفاً بررسی شود.',
  };

  it('POST /v1/maintenance-requests accepts «،» «؛» «؟» in the title and description', async () => {
    const response = await request(app.getHttpServer()).post('/v1/maintenance-requests').send(BODY);

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: BODY.title, description: BODY.description }),
    );
  });

  it('POST …/approve accepts them in the notes', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/maintenance-requests/MNT-1/approve')
      .send({ expectedTotalCostMinor: '100', notes: 'تایید، با توجه به گزارش؛ موافقید؟' });

    expect(response.status).toBe(200);
  });

  it('still refuses a bidi control in the description', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/maintenance-requests')
      .send({ ...BODY, description: `${BODY.description}‮` });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(create).not.toHaveBeenCalled();
  });
});
