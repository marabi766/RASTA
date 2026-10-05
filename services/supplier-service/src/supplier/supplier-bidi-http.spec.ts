import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { SUPPLIER_CAPABILITIES } from './capabilities';
import { QualificationService } from './qualification.service';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';
import { SuspensionService } from './suspension.service';

/**
 * Bidi controls at the HTTP boundary (#209 r1), through the real
 * `SupplierController` and its validation pipes. The stated reason — shared by
 * reject-qualification, suspend and reinstate, stored and published on the
 * supplier events — and an evidence `documentId`, stored as given, used to be
 * bare strings. Each now answers 400 `VALIDATION_FAILED`, repeats nothing of
 * the value, and never reaches the service, so nothing is written.
 */
describe('a supplier write carrying a bidi control (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const qualifications = { submit: jest.fn(), reject: jest.fn() };
  const suspensions = { suspend: jest.fn(), reinstate: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SupplierController],
      providers: [
        { provide: SupplierService, useValue: {} },
        { provide: QualificationService, useValue: qualifications },
        { provide: SuspensionService, useValue: suspensions },
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
    for (const mock of [...Object.values(qualifications), ...Object.values(suspensions)]) {
      mock.mockReset().mockResolvedValue({ id: 'QLF_1' });
    }
  });

  const SUPPLIER = '/v1/suppliers/SUP_1';
  const REASON_ROUTES = [
    ['reject-qualification', `${SUPPLIER}/qualifications/QLF_1/reject`, qualifications.reject],
    ['suspend', `${SUPPLIER}/suspend`, suspensions.suspend],
    ['reinstate', `${SUPPLIER}/reinstate`, suspensions.reinstate],
  ] as const;
  const SPOOFED_REASONS = [
    ['U+202E', 'مدرک ارائه‌شده ‮نامعتبر‬ است'],
    ['U+061C', 'مدرک؜ ارائه‌شده نامعتبر است'],
    ['U+2066', 'evidence ⁦expired⁩ in 2025'],
  ] as const;

  describe.each(REASON_ROUTES)('%s', (_name, path, handler) => {
    it.each(SPOOFED_REASONS)(
      'refuses a reason carrying %s, repeats nothing, and writes nothing',
      async (_label, reason) => {
        const response = await request(app.getHttpServer()).post(path).send({ reason });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(response.body)).not.toContain(reason);
        expect(handler).not.toHaveBeenCalled();
      },
    );

    it('still accepts a clean Persian reason with ZWNJ, and keeps its bounds', async () => {
      const accepted = await request(app.getHttpServer())
        .post(path)
        .send({ reason: 'مدرک ارائه‌شده منقضی شده است' });
      expect(accepted.status).toBeLessThan(300);
      expect(handler).toHaveBeenCalledTimes(1);

      const short = await request(app.getHttpServer()).post(path).send({ reason: 'کوتاه' });
      expect(short.status).toBe(400);
    });
  });

  describe('submit qualification', () => {
    const path = `${SUPPLIER}/qualifications`;
    const capability = SUPPLIER_CAPABILITIES[0];

    it.each([
      ['U+202E', 'DOC_01‮J9'],
      ['U+200F', 'DOC_01‏J9'],
      ['ZWNJ', 'DOC_01‌J9'],
      ['a C0 control', 'DOC_01\u0007J9'],
    ])('refuses an evidence documentId carrying %s, and writes nothing', async (_label, id) => {
      const response = await request(app.getHttpServer())
        .post(path)
        .send({ capability, evidence: [{ documentId: id }] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).not.toContain(id);
      expect(qualifications.submit).not.toHaveBeenCalled();
    });

    it('still accepts a clean document id', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .send({ capability, evidence: [{ documentId: 'DOC_01J9ZK7Q', label: 'پروانه کسب' }] });

      expect(response.status).toBe(201);
      expect(qualifications.submit).toHaveBeenCalledWith(
        'SUP_1',
        expect.objectContaining({
          evidence: [{ documentId: 'DOC_01J9ZK7Q', label: 'پروانه کسب' }],
        }),
      );
    });
  });
});
