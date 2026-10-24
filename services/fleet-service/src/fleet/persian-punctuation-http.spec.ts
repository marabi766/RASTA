import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { AssignmentService } from './assignment.service';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

/**
 * The Persian comma «،», semicolon «؛» and question mark «؟» are Script=Common,
 * so the old Arabic-script allow-list refused them (the demo run of 2026-10-24
 * hit it on a driver's notes). Through the real `DriverController` and its
 * validation pipe: a note with them is accepted and reaches the service; a bidi
 * control next to them is still refused. The rule itself is `displayText` in
 * `@rasta/contracts` (table test in `common/text.spec.ts`).
 */
describe('a driver note with Persian punctuation (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const drivers = { create: jest.fn(), update: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DriverController],
      providers: [
        { provide: DriverService, useValue: drivers },
        { provide: AssignmentService, useValue: {} },
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
    drivers.create.mockReset().mockResolvedValue({ id: 'DRV-1' });
    drivers.update.mockReset().mockResolvedValue({ id: 'DRV-1' });
  });

  const USER = 'USR-SEED-DRIVER-0001';
  const NOTES = 'شیفت شب، پایه دو؛ آیا مجوز دارد؟';

  it('POST /v1/drivers accepts «،» «؛» «؟» in the notes', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/drivers')
      .send({ userId: USER, notes: NOTES });

    expect(response.status).toBe(201);
    expect(drivers.create).toHaveBeenCalledWith(expect.objectContaining({ notes: NOTES }));
  });

  it('PATCH /v1/drivers/:id accepts them too', async () => {
    const response = await request(app.getHttpServer())
      .patch('/v1/drivers/DRV-1')
      .send({ notes: NOTES });

    expect(response.status).toBe(200);
    expect(drivers.update).toHaveBeenCalledWith('DRV-1', expect.objectContaining({ notes: NOTES }));
  });

  it('still refuses a bidi control in a note that has them', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/drivers')
      .send({ userId: USER, notes: `${NOTES}‮` });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(drivers.create).not.toHaveBeenCalled();
  });
});
