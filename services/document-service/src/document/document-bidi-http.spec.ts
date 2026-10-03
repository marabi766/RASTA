import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

/**
 * Bidi controls at the HTTP boundary (#209 r1), through the real
 * `DocumentController` and its validation pipes. `ownerResourceId` is stored as
 * given and was a bare string; `filename` was accepted and its bidi controls
 * silently stripped later. Both now answer 400 `VALIDATION_FAILED`, repeat
 * nothing of the value, and never reach the service.
 */
describe('a document write carrying a bidi control (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const documents = { requestUploadUrl: jest.fn(), finalize: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [{ provide: DocumentService, useValue: documents }],
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
    documents.requestUploadUrl.mockReset().mockResolvedValue({ uploadIntentId: 'UPI_1' });
    documents.finalize.mockReset().mockResolvedValue({ id: 'DOC_1' });
  });

  describe('POST /v1/documents (finalize)', () => {
    it.each([
      ['U+202E', 'AST_01‮J9'],
      ['U+061C', 'AST_01؜J9'],
      ['ZWNJ', 'AST_01‌J9'],
      ['a C0 control', 'AST_01\u0000J9'],
    ])('refuses an ownerResourceId carrying %s, and writes nothing', async (_label, id) => {
      const response = await request(app.getHttpServer())
        .post('/v1/documents')
        .send({ uploadIntentId: 'UPI_1', ownerResourceType: 'Asset', ownerResourceId: id });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).not.toContain(id);
      expect(documents.finalize).not.toHaveBeenCalled();
    });

    it('still accepts a clean owner reference', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/documents')
        .send({ uploadIntentId: 'UPI_1', ownerResourceType: 'Asset', ownerResourceId: 'AST_01J9' });

      expect(response.status).toBe(201);
      expect(documents.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ ownerResourceId: 'AST_01J9' }),
      );
    });
  });

  describe('POST /v1/documents/upload-url', () => {
    const body = { documentClass: 'CONTRACT', contentType: 'application/pdf', sizeBytes: 1024 };

    it.each([
      ['U+202E', 'invoice‮fdp.exe'],
      ['U+200F', 'قرارداد‏.pdf'],
      ['U+2067', 'scan⁧.pdf'],
    ])(
      'refuses a filename carrying %s rather than stripping it later',
      async (_label, filename) => {
        const response = await request(app.getHttpServer())
          .post('/v1/documents/upload-url')
          .send({ ...body, filename });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(response.body)).not.toContain(filename);
        expect(documents.requestUploadUrl).not.toHaveBeenCalled();
      },
    );

    it('still accepts a Persian filename with ZWNJ', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/documents/upload-url')
        .send({ ...body, filename: 'قرارداد‌نهایی.pdf' });

      expect(response.status).toBe(201);
      expect(documents.requestUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'قرارداد‌نهایی.pdf' }),
      );
    });
  });
});
