import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter, RastaError } from '@rasta/nest-common';
import { REPAIR_ORDER_ENDPOINTS, RepairOrderController } from './repair-order.controller';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore } from './idempotency';

/**
 * The six repair-order writes over HTTP, through the real controller, pipes and
 * exception filter, with the service and the store stubbed: what each does with
 * an `Idempotency-Key` header: required, and refused when missing or malformed. What the store and the database then do with it
 * is proved against PostgreSQL in `test/repair-order-idempotency.int-spec.ts`.
 */
describe('Idempotency-Key on the repair-order writes', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const service = {
    assertAccessible: jest.fn(),
    start: jest.fn(),
    complete: jest.fn(),
    cancel: jest.fn(),
    recordPart: jest.fn(),
    recordLabour: jest.fn(),
    recordCost: jest.fn(),
  };
  const store = { execute: jest.fn() };
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

  const FENCE = { hold: jest.fn(), complete: jest.fn() };

  beforeEach(() => {
    for (const mock of Object.values(service)) mock.mockReset();
    for (const method of [
      'start',
      'complete',
      'cancel',
      'recordPart',
      'recordLabour',
      'recordCost',
    ] as const) {
      service[method].mockResolvedValue({ id: 'X-1' });
    }
    store.execute.mockReset();
    // The store runs the work with a fence and hands back what it returned.
    store.execute.mockImplementation(
      async (
        _endpoint: string,
        _key: string,
        _body: unknown,
        _status: number,
        work: (fence: typeof FENCE) => Promise<unknown>,
      ) => ({ result: await work(FENCE), executed: true }),
    );
  });

  const WRITES = [
    {
      verb: 'start',
      method: 'start',
      endpoint: REPAIR_ORDER_ENDPOINTS.start,
      status: 200,
      body: {},
    },
    {
      verb: 'complete',
      method: 'complete',
      endpoint: REPAIR_ORDER_ENDPOINTS.complete,
      status: 200,
      body: { workPerformed: 'انجام شد', expectedTotalCostMinor: '5' },
    },
    {
      verb: 'cancel',
      method: 'cancel',
      endpoint: REPAIR_ORDER_ENDPOINTS.cancel,
      status: 200,
      body: { reason: 'تعمیرگاه نپذیرفت' },
    },
    {
      verb: 'parts',
      method: 'recordPart',
      endpoint: REPAIR_ORDER_ENDPOINTS.parts,
      status: 201,
      body: { partName: 'فیلتر روغن', quantity: '2', unit: 'عدد', unitCostMinor: '250000' },
    },
    {
      verb: 'labour',
      method: 'recordLabour',
      endpoint: REPAIR_ORDER_ENDPOINTS.labour,
      status: 201,
      body: { description: 'تعویض فیلتر', hours: '1.5', hourlyRateMinor: '800000' },
    },
    {
      verb: 'costs',
      method: 'recordCost',
      endpoint: REPAIR_ORDER_ENDPOINTS.costs,
      status: 201,
      body: { category: 'SERVICE', amountMinor: '500000', description: 'ایاب و ذهاب' },
    },
  ] as const;

  const KEY = 'a-key-of-sufficient-length';
  const post = (verb: string, body: object, key?: string) => {
    const call = request(app.getHttpServer()).post(`/v1/repair-orders/RPO-1/${verb}`);
    return (key === undefined ? call : call.set('Idempotency-Key', key)).send(body);
  };

  describe.each(WRITES)('$verb', ({ verb, method, endpoint, status, body }) => {
    it.each(['__proto__', 'constructor'])(
      'refuses a body carrying a %s key, 400, before any claim: no hash ever sees it (#194)',
      async (name) => {
        // Raw JSON, so the key arrives as an own key, as a client would send it.
        const raw = JSON.stringify(body).replace(
          /^\{/,
          `{"${name}":{"x":1}${Object.keys(body).length > 0 ? ',' : ''}`,
        );
        const response = await request(app.getHttpServer())
          .post(`/v1/repair-orders/RPO-1/${verb}`)
          .set('Idempotency-Key', KEY)
          .set('content-type', 'application/json')
          .send(raw);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(store.execute).not.toHaveBeenCalled();
        expect(service[method]).not.toHaveBeenCalled();
      },
    );

    it('refuses a post with no key, 400 with the code "required", before anything else, and writes nothing', async () => {
      const response = await post(verb, body);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
        ]),
      );
      expect(service.assertAccessible).not.toHaveBeenCalled();
      expect(store.execute).not.toHaveBeenCalled();
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('refuses an empty key the same way: a header that says nothing is no key', async () => {
      const response = await post(verb, body, '   ');

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
        ]),
      );
      expect(store.execute).not.toHaveBeenCalled();
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('checks the caller’s right to the order first, then runs the work under the claim', async () => {
      const response = await post(verb, body, KEY);

      expect(response.status).toBe(status);
      expect(service.assertAccessible).toHaveBeenCalledWith('RPO-1');
      expect(service.assertAccessible.mock.invocationCallOrder[0]).toBeLessThan(
        store.execute.mock.invocationCallOrder[0],
      );
      expect(store.execute).toHaveBeenCalledTimes(1);
      const [storedEndpoint, key, hashed, successStatus] = store.execute.mock.calls[0];
      expect(storedEndpoint).toBe(endpoint);
      expect(key).toBe(KEY);
      // The order is part of the request the key stands for: one key cannot be replayed onto another.
      // (Defaults the schema fills in, such as a part's source, are part of it too.)
      expect(hashed).toEqual(expect.objectContaining({ repairOrderId: 'RPO-1', ...body }));
      expect(successStatus).toBe(status);
      expect(service[method].mock.calls[0][2]).toBe(FENCE);
    });

    it('does not claim, replay or run anything for somebody with no right to the order', async () => {
      service.assertAccessible.mockRejectedValue(RastaError.notFound('RepairOrder', 'RPO-1'));

      const response = await post(verb, body, KEY);

      expect(response.status).toBe(404);
      expect(store.execute).not.toHaveBeenCalled();
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('refuses a key that is present but too short, with the code "invalid", and does nothing', async () => {
      const response = await post(verb, body, 'short');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'invalid' }),
        ]),
      );
      expect(store.execute).not.toHaveBeenCalled();
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('answers what the store answers, which for a replay is the stored response', async () => {
      store.execute.mockResolvedValue({ result: { id: 'STORED-1' }, executed: false });

      const response = await post(verb, body, KEY);

      expect(response.status).toBe(status);
      expect(response.body).toEqual({ id: 'STORED-1' });
      expect(service[method]).not.toHaveBeenCalled();
    });

    it('passes on the store’s conflicts as they are', async () => {
      store.execute.mockRejectedValue(RastaError.idempotencyKeyReused());

      const response = await post(verb, body, KEY);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
});
