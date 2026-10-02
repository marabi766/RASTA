import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RequestController } from './request.controller';
import { RequestService } from './request.service';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore } from './idempotency';

/**
 * `POST /v1/maintenance-requests/:id/approve` over HTTP, through the real
 * controller, validation pipe and exception filter, with the service behind it
 * stubbed.
 *
 * `expectedTotalCostMinor` is the control the product document makes mandatory
 * before settlement (docs/17, ADR-028 § 4). It was optional, which let a direct
 * API client approve without ever stating the amount; this is the proof that a
 * missing or malformed one is refused at the boundary and that nothing reaches
 * the service. What the service does with a stated total — match, mismatch,
 * the state guard — is proved against PostgreSQL in
 * `test/request-lifecycle.int-spec.ts`.
 */
describe('POST /v1/maintenance-requests/:id/approve', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const approve = jest.fn();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RequestController],
      providers: [
        { provide: RequestService, useValue: { approve } },
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
    approve.mockReset();
    approve.mockResolvedValue({ id: 'MNT-1', status: 'APPROVED' });
  });

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/v1/maintenance-requests/MNT-1/approve')
      .send(body as object);

  it('refuses an approval that does not state the total, and approves nothing', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'expectedTotalCostMinor' })]),
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it('refuses notes alone: a note is not a confirmation of an amount', async () => {
    const response = await post({ notes: 'تأیید شد' });

    expect(response.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([
    ['a number, not a string', 12_000],
    ['a decimal', '12.5'],
    ['a negative', '-1'],
    ['empty', ''],
  ])('refuses a total that is %s', async (_label, value) => {
    const response = await post({ expectedTotalCostMinor: value });

    expect(response.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });

  it('hands a stated total to the service as it was sent', async () => {
    const response = await post({ expectedTotalCostMinor: '1200000', notes: 'تأیید شد' });

    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith('MNT-1', {
      expectedTotalCostMinor: '1200000',
      notes: 'تأیید شد',
    });
  });

  it('accepts a total of zero: a request with no cost is still confirmed, not unconfirmed', async () => {
    const response = await post({ expectedTotalCostMinor: '0' });

    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith('MNT-1', { expectedTotalCostMinor: '0' });
  });
});
