import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RepairOrderController } from './repair-order.controller';
import { RepairOrderService } from './repair-order.service';

/**
 * `POST /v1/repair-orders/:id/complete` over HTTP, through the real controller,
 * validation pipe and exception filter, with the service stubbed.
 *
 * `expectedTotalCostMinor` is optional here — unlike the approval's — so this
 * proves both halves: a completion that states no total still goes through, and
 * one that states a malformed total is refused at the boundary with nothing
 * reaching the service. What the service does with a stated total is proved
 * against PostgreSQL in `test/request-lifecycle.int-spec.ts`.
 */
describe('POST /v1/repair-orders/:id/complete', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const complete = jest.fn();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RepairOrderController],
      providers: [{ provide: RepairOrderService, useValue: { complete } }],
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
    complete.mockReset();
    complete.mockResolvedValue({ id: 'RPR-1', status: 'COMPLETED' });
  });

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/v1/repair-orders/RPR-1/complete')
      .send(body as object);

  it('completes without a stated total: the control is optional for this command', async () => {
    const response = await post({ workPerformed: 'شیلنگ تعویض شد' });

    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith('RPR-1', { workPerformed: 'شیلنگ تعویض شد' });
  });

  it('hands a stated total to the service as it was sent, zero included', async () => {
    for (const total of ['750000', '0']) {
      complete.mockClear();
      const response = await post({ workPerformed: 'انجام شد', expectedTotalCostMinor: total });

      expect(response.status).toBe(200);
      expect(complete).toHaveBeenCalledWith('RPR-1', {
        workPerformed: 'انجام شد',
        expectedTotalCostMinor: total,
      });
    }
  });

  it.each([
    ['a number, not a string', 750_000],
    ['a decimal', '12.5'],
    ['a negative', '-1'],
    ['empty', ''],
  ])('refuses a stated total that is %s, and completes nothing', async (_label, value) => {
    const response = await post({ workPerformed: 'انجام شد', expectedTotalCostMinor: value });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(complete).not.toHaveBeenCalled();
  });
});
