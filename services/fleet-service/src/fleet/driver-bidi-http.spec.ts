import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { AssignmentService } from './assignment.service';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

/**
 * Server-side bidi controls at the HTTP boundary (#150 triage, item 2), through
 * the real `DriverController` and its validation pipe: a driver identifier or
 * note carrying a bidirectional control is answered 400 `VALIDATION_FAILED`
 * and never reaches the service, so nothing is written. Before, `licenceNumber`
 * and its siblings were bare strings that kept every bidi control, and `notes`
 * kept U+061C ARABIC LETTER MARK — the portal refused both, a direct API caller
 * did not.
 */
describe('a driver write carrying a bidi control (HTTP)', () => {
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
  const SPOOFED = [
    ['licenceNumber', '12‮34'],
    ['employeeNo', 'E-⁦007⁩'],
    ['licenceClass', 'B‏1'],
    ['notes', 'راننده؜ی شیفت شب'],
  ] as const;

  it.each(SPOOFED)('POST /v1/drivers refuses %s, and writes nothing', async (field, value) => {
    const response = await request(app.getHttpServer())
      .post('/v1/drivers')
      .send({ userId: USER, [field]: value });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).not.toContain(value);
    expect(drivers.create).not.toHaveBeenCalled();
  });

  it.each(SPOOFED)('PATCH /v1/drivers/:id refuses %s, and writes nothing', async (field, value) => {
    const response = await request(app.getHttpServer())
      .patch('/v1/drivers/DRV-1')
      .send({ [field]: value });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(drivers.update).not.toHaveBeenCalled();
  });

  it('still registers a driver whose identifiers and notes are clean', async () => {
    const response = await request(app.getHttpServer()).post('/v1/drivers').send({
      userId: USER,
      employeeNo: 'E-007',
      licenceNumber: '1234-5678',
      licenceClass: 'پایه یک',
      notes: 'راننده‌ی شیفت شب',
    });

    expect(response.status).toBe(201);
    expect(drivers.create).toHaveBeenCalledWith(
      expect.objectContaining({ licenceNumber: '1234-5678', notes: 'راننده‌ی شیفت شب' }),
    );
  });
});
