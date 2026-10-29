import request from 'supertest';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { PROBE_TRACEPARENT, httpErrorBodyProblems } from '@rasta/nest-common';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { apiTenant, orgAdmin, startApi, type ApiHarness } from './api-helpers';

/**
 * The published error envelope, against the service that sends it (audit 10-26 F3): the error
 * bodies the real application answers — through its real guards, pipes and exception filter — are
 * accepted by the schema the document publishes for that operation and status, raw, with and
 * without a `traceparent` on the request.
 */
describe('the published OpenAPI error envelope (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;

  beforeAll(async () => {
    api = await startApi();
    document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        api.app,
        new DocumentBuilder()
          .setTitle('Rasta — Document Service')
          .setVersion('1')
          .addBearerAuth()
          .build(),
      ),
      { signedUrlTtlSeconds: 300, uploadIntentTtlSeconds: 900 },
    );
  }, 120_000);

  afterAll(async () => {
    await api.close();
  });

  it('accepts the error bodies the application really sends over HTTP, with and without a trace', async () => {
    const problems: string[] = [];
    for (const traced of [true, false]) {
      const headers: Record<string, string> = traced ? { traceparent: PROBE_TRACEPARENT } : {};
      const http = () => request(api.app.getHttpServer());
      const answers = [
        {
          method: 'GET',
          url: '/v1/documents',
          response: await http().get('/v1/documents').set(headers),
        },
        {
          method: 'POST',
          url: '/v1/documents/upload-url',
          response: await http()
            .post('/v1/documents/upload-url')
            .set(headers)
            .set('authorization', `Bearer ${orgAdmin(apiTenant('ENVELOPE'))}`)
            .send({
              documentClass: 'SOMETHING_INVENTED',
              contentType: 'application/pdf',
              sizeBytes: 1024,
              filename: 'x.pdf',
            }),
        },
      ];
      expect(answers.map(({ response }) => response.status)).toEqual([401, 400]);
      expect(answers[1]!.response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(answers[1]!.response.body.details.length).toBeGreaterThan(0);
      for (const { method, url, response } of answers) {
        problems.push(
          ...httpErrorBodyProblems(document, {
            method,
            url,
            status: response.status,
            body: response.body,
            traced,
          }),
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
