import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { MAX_AMOUNT_MINOR } from './dto';
import { RepairOrderController } from './repair-order.controller';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore } from './idempotency';
import { toJsonSchema } from '../openapi/zod-schema';
import { recordCostSchema, recordLabourSchema, recordPartSchema } from './dto';

/**
 * The largest amount any column here can hold, at the boundary: the three
 * writes that take an amount accept exactly that and refuse one unit more with
 * a 400 that names the field — never a 500 from PostgreSQL once the row is
 * written. What happens to a computed line total and to a stored aggregate is
 * proved against the database in `test/repair-order-idempotency.int-spec.ts`.
 */
describe('the ledger’s bound on an amount a caller states', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const service = {
    assertAccessible: jest.fn(),
    recordPart: jest.fn(),
    recordLabour: jest.fn(),
    recordCost: jest.fn(),
  };
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
  });

  const MAX = MAX_AMOUNT_MINOR.toString();
  const PAST = (MAX_AMOUNT_MINOR + 1n).toString();

  const WRITES = [
    {
      verb: 'costs',
      method: 'recordCost',
      field: 'amountMinor',
      body: { category: 'SERVICE', description: 'ایاب و ذهاب' },
    },
    {
      verb: 'parts',
      method: 'recordPart',
      field: 'unitCostMinor',
      body: { partName: 'فیلتر روغن', quantity: '1', unit: 'عدد' },
    },
    {
      verb: 'labour',
      method: 'recordLabour',
      field: 'hourlyRateMinor',
      body: { description: 'تعویض فیلتر', hours: '1' },
    },
  ] as const;

  const post = (verb: string, body: object) =>
    request(app.getHttpServer())
      .post(`/v1/repair-orders/RPO-1/${verb}`)
      .set('Idempotency-Key', 'a-key-of-sufficient-length')
      .send(body as object);

  it('is the BIGINT maximum, 2^63 − 1', () => {
    expect(MAX_AMOUNT_MINOR).toBe(2n ** 63n - 1n);
  });

  describe.each(WRITES)('$verb', ({ verb, method, field, body }) => {
    it('accepts exactly the bound', async () => {
      const response = await post(verb, { ...body, [field]: MAX });

      expect(response.status).toBe(201);
      expect(service[method]).toHaveBeenCalledTimes(1);
    });

    it('refuses one unit more with a 400 that names the field, and writes nothing', async () => {
      const response = await post(verb, { ...body, [field]: PAST });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: field })]),
      );
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('refuses an amount of thirty digits, which the platform’s own schema would let through', async () => {
      const response = await post(verb, { ...body, [field]: '9'.repeat(30) });

      expect(response.status).toBe(400);
      expect(service[method]).not.toHaveBeenCalled();
    });
  });

  it('publishes the bound in the contract, so a client learns it before it is refused', () => {
    for (const [schema, field] of [
      [recordCostSchema, 'amountMinor'],
      [recordPartSchema, 'unitCostMinor'],
      [recordLabourSchema, 'hourlyRateMinor'],
    ] as const) {
      const property = (toJsonSchema(schema).properties as Record<string, Record<string, unknown>>)[
        field
      ];
      expect(property.type).toBe('string');
      expect(property.description).toContain(MAX);
    }
  });
});
