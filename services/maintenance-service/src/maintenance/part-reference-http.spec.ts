import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RepairOrderController } from './repair-order.controller';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore } from './idempotency';

/**
 * A part's two references at the HTTP boundary, through the real
 * `RepairOrderController` and its validation pipe. #209 left both as bare
 * trimmed strings because the portal's contract spec pinned them; they are
 * `referenceId()` now. A bidi control — or any other control or format
 * character, ZWNJ included, since these are identifiers — answers 400
 * `VALIDATION_FAILED`, names the field, repeats nothing of the value, and never
 * reaches the service, so no part is recorded.
 */
describe('recording a part whose reference carries an invisible character (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const service = { assertAccessible: jest.fn(), recordPart: jest.fn() };
  // The store runs the work and hands back what it returned.
  const store = {
    execute: jest.fn(async (...args: unknown[]) => ({
      result: await (args[4] as (fence: unknown) => Promise<unknown>)({}),
      executed: true,
    })),
  };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RepairOrderController],
      providers: [
        { provide: RepairOrderService, useValue: service },
        { provide: IdempotencyStore, useValue: store },
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
    for (const mock of Object.values(service)) mock.mockReset().mockResolvedValue({ id: 'X-1' });
    store.execute.mockClear();
  });

  const PART = { partName: 'فیلتر روغن', quantity: '1', unit: 'عدد', unitCostMinor: '1500000' };
  const MARKER = 'حواله۱۴۰۳ORD';

  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/v1/repair-orders/RPO-1/parts')
      .set('Idempotency-Key', 'a-key-of-sufficient-length')
      .send(body);

  describe.each(['partReference', 'sourceReference'])('%s', (field) => {
    it.each([
      ['U+202E', '‮'],
      ['U+061C', '؜'],
      ['U+2067', '⁧'],
      ['ZWNJ', '‌'],
      ['a byte-order mark', '﻿'],
    ])(
      'refuses %s with 400, naming the field, repeating nothing, writing nothing',
      async (_label, control) => {
        const response = await post({ ...PART, [field]: `${MARKER}${control}-12` });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(response.body.details).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: field })]),
        );
        expect(JSON.stringify(response.body)).not.toContain(MARKER);
        expect(service.recordPart).not.toHaveBeenCalled();
      },
    );

    it('still accepts a reference in Persian letters and digits', async () => {
      const response = await post({ ...PART, [field]: `${MARKER}-12` });

      expect(response.status).toBe(201);
      expect(service.recordPart).toHaveBeenCalledTimes(1);
      expect(service.recordPart.mock.calls[0]).toContainEqual(
        expect.objectContaining({ [field]: `${MARKER}-12` }),
      );
    });
  });
});
