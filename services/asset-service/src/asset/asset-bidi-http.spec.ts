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
 * Bidi controls at the HTTP boundary (#209 r1), through the real
 * `AssetController` and its validation pipes:
 *
 *   - `specifications` took any JSON. A bidi control in any key or string
 *     value, at any depth and inside arrays, is now refused.
 *   - A `documentId` — the attachment's, and the optional one on a policy and
 *     an inspection — is stored as given and was a bare string. A control or
 *     format character in it is now refused.
 *
 * Each answers 400 `VALIDATION_FAILED`, repeats nothing of the value, and never
 * reaches the service, so nothing is written.
 */
describe('an asset write carrying a bidi control (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const assets = {
    create: jest.fn(),
    update: jest.fn(),
    attachDocument: jest.fn(),
    changeStatus: jest.fn(),
    decommission: jest.fn(),
  };
  const insurance = { recordPolicy: jest.fn(), recordInspection: jest.fn() };
  const idempotency = { execute: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: insurance },
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
    for (const mock of [...Object.values(assets), ...Object.values(insurance)]) {
      mock.mockReset().mockResolvedValue({ id: 'AST_1' });
    }
    // Runs the work the controller hands it, as the real store does for a new
    // key: the policy and inspection routes record under an Idempotency-Key
    // (EXP-002 slice 6), so what reaches the service is what they send it.
    idempotency.execute
      .mockReset()
      .mockImplementation(
        async (
          _endpoint: string,
          _key: string,
          _body: unknown,
          _status: number,
          work: (f: object) => Promise<unknown>,
        ) => ({
          result: await work({}),
        }),
      );
  });

  const MARKER = 'ساعت‌کارکرد';

  function expectRefused(response: request.Response, ...untouched: jest.Mock[]): void {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).not.toContain(MARKER);
    for (const mock of untouched) expect(mock).not.toHaveBeenCalled();
  }

  describe('specifications', () => {
    const SPOOFED: readonly (readonly [string, Record<string, unknown>])[] = [
      ['a top-level value', { engine: `${MARKER}‮` }],
      ['a top-level key', { [`${MARKER}؜`]: 4380 }],
      ['a nested key', { engine: { [`⁦${MARKER}⁩`]: 4380 } }],
      ['a string in a nested array', { attachments: [['bucket', `${MARKER}‏`]] }],
    ];

    it.each(SPOOFED)('POST /v1/assets refuses one in %s', async (_where, specifications) => {
      const response = await request(app.getHttpServer())
        .post('/v1/assets')
        .set('Idempotency-Key', 'create-asset-0001')
        .send({ name: 'گریدر شماره یک', type: 'GRADER', specifications });
      expectRefused(response, idempotency.execute, assets.create);
    });

    it.each(SPOOFED)('PATCH /v1/assets/:id refuses one in %s', async (_where, specifications) => {
      const response = await request(app.getHttpServer())
        .patch('/v1/assets/AST_1')
        .send({ specifications, expectedVersion: 1 });
      expectRefused(response, assets.update);
    });

    it('still accepts clean nested specifications, Persian with ZWNJ included', async () => {
      const specifications = { ساعت‌کار: 4380, tyres: [['جلو', 'عقب']], engine: { model: 'D6' } };
      const response = await request(app.getHttpServer())
        .patch('/v1/assets/AST_1')
        .send({ specifications, expectedVersion: 1 });

      expect(response.status).toBeLessThan(300);
      expect(assets.update).toHaveBeenCalledWith(
        'AST_1',
        expect.objectContaining({ specifications }),
      );
    });
  });

  describe('document references', () => {
    const SPOOFED_IDS = [
      ['U+202E', `DOC_${MARKER}‮1`],
      ['U+061C', `DOC_${MARKER}؜1`],
      ['ZWNJ', `DOC_${MARKER}‌1`],
      ['a byte-order mark', `DOC_${MARKER}\uFEFF1`],
    ] as const;
    const DAY = '2026-01-01T00:00:00.000Z';
    const YEAR_LATER = '2027-01-01T00:00:00.000Z';
    const ROUTES = [
      [
        'POST /v1/assets/:id/documents',
        '/v1/assets/AST_1/documents',
        { kind: 'OWNERSHIP_TITLE', title: 'سند مالکیت' },
        assets.attachDocument,
      ],
      [
        'POST /v1/assets/:id/insurance-policies',
        '/v1/assets/AST_1/insurance-policies',
        {
          policyNumber: 'POL-1234',
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: DAY,
          validTo: YEAR_LATER,
        },
        insurance.recordPolicy,
      ],
      [
        'POST /v1/assets/:id/inspections',
        '/v1/assets/AST_1/inspections',
        { certificateNo: 'INS-1234', inspectedAt: DAY, validTo: YEAR_LATER, result: 'PASSED' },
        insurance.recordInspection,
      ],
    ] as const;

    describe.each(ROUTES)('%s', (_name, path, body, handler) => {
      it.each(SPOOFED_IDS)('refuses a documentId carrying %s', async (_label, documentId) => {
        const response = await request(app.getHttpServer())
          .post(path)
          .set('Idempotency-Key', 'record-key-0001')
          .send({ ...body, documentId });
        expectRefused(response, handler);
      });

      it('still accepts a clean documentId', async () => {
        const response = await request(app.getHttpServer())
          .post(path)
          .set('Idempotency-Key', 'record-key-0001')
          .send({ ...body, documentId: 'DOC_01J9ZK7Q' });

        expect(response.status).toBeLessThan(300);
        // The record routes pass the claim fence as a third argument.
        expect(handler).toHaveBeenCalledWith(
          'AST_1',
          expect.objectContaining({ documentId: 'DOC_01J9ZK7Q' }),
          ...(path.endsWith('/documents') ? [] : [expect.anything()]),
        );
      });
    });
  });

  /**
   * The six asset fields #209 left to the portal's contract specs (#209,
   * "Follow-up after #206"): `model`, the two lifecycle reasons, and the
   * inspection's certificate number and notes. Each is `plainText()` now.
   */
  describe('the fields the portal pinned until now', () => {
    const DAY = '2026-01-01T00:00:00.000Z';
    const YEAR_LATER = '2027-01-01T00:00:00.000Z';
    const INSPECTION = {
      certificateNo: 'INS-1234',
      inspectedAt: DAY,
      validTo: YEAR_LATER,
      result: 'PASSED',
    };
    const CASES = [
      {
        label: 'POST /v1/assets model',
        send: (value: string) =>
          request(app.getHttpServer())
            .post('/v1/assets')
            .set('Idempotency-Key', 'create-asset-0001')
            .send({ name: 'گریدر شماره یک', type: 'GRADER', model: value }),
        field: 'model',
        handler: assets.create,
      },
      {
        label: 'PATCH /v1/assets/:id model',
        send: (value: string) =>
          request(app.getHttpServer())
            .patch('/v1/assets/AST_1')
            .send({ model: value, expectedVersion: 1 }),
        field: 'model',
        handler: assets.update,
      },
      {
        label: 'POST /v1/assets/:id/status reason',
        send: (value: string) =>
          request(app.getHttpServer())
            .post('/v1/assets/AST_1/status')
            .send({ status: 'IDLE', reason: value, expectedVersion: 1 }),
        field: 'reason',
        handler: assets.changeStatus,
      },
      {
        label: 'POST /v1/assets/:id/decommission reason',
        send: (value: string) =>
          request(app.getHttpServer())
            .post('/v1/assets/AST_1/decommission')
            .send({ reason: value, expectedVersion: 1 }),
        field: 'reason',
        handler: assets.decommission,
      },
      {
        label: 'POST /v1/assets/:id/inspections certificateNo',
        send: (value: string) =>
          request(app.getHttpServer())
            .post('/v1/assets/AST_1/inspections')
            .set('Idempotency-Key', 'record-key-0001')
            .send({ ...INSPECTION, certificateNo: value }),
        field: 'certificateNo',
        handler: insurance.recordInspection,
      },
      {
        label: 'POST /v1/assets/:id/inspections notes',
        send: (value: string) =>
          request(app.getHttpServer())
            .post('/v1/assets/AST_1/inspections')
            .set('Idempotency-Key', 'record-key-0001')
            .send({ ...INSPECTION, notes: value }),
        field: 'notes',
        handler: insurance.recordInspection,
      },
    ];
    // Long enough for every bound (the decommission reason needs ten), short
    // enough for the certificate number's sixty-four.
    const CLEAN = `${MARKER} و تعمیر‌نشدنی`;

    describe.each(CASES)('$label', ({ send, field, handler }) => {
      it.each([
        ['U+202E', '\u202E'],
        ['U+061C', '\u061C'],
        ['U+2066', '\u2066'],
      ])('refuses %s with 400, naming the field and repeating nothing', async (_label, control) => {
        const response = await send(`${MARKER}${control} و تعمیر‌نشدنی`);

        expectRefused(response, handler);
        expect(response.body.details).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: field })]),
        );
      });

      it('still accepts Persian with ZWNJ', async () => {
        const response = await send(CLEAN);

        expect(response.status).toBeLessThan(300);
        expect(handler).toHaveBeenCalledTimes(1);
        // The body is the first argument on register and the second elsewhere.
        expect(handler.mock.calls[0]).toContainEqual(expect.objectContaining({ [field]: CLEAN }));
      });
    });
  });
});
