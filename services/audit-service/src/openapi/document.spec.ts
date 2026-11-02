import type { OpenAPIObject } from '@nestjs/swagger';
import { errorEnvelopeProblems } from '@rasta/nest-common';
import { enrichOpenApiDocument } from './document';

/**
 * The published contract, assembled from a skeleton shaped the way Nest hands one over. That the
 * document describes the running application is `test/openapi.int-spec.ts`.
 */
describe('the published error envelope (audit 10-26 F3)', () => {
  it('accepts the error bodies the shared filter really sends, on every route', () => {
    const document = enrichOpenApiDocument({
      openapi: '3.0.0',
      info: { title: 'Rasta — Audit Service', version: '0.1.0' },
      paths: {
        '/v1/audit-events': { get: {} },
        '/v1/audit-events/verify': { get: {} },
        '/v1/audit-events/{id}': { get: {} },
        '/v1/internal/audit-events/{id}': { get: {} },
        '/v1/internal/tender-evidence/{tenderId}/chain': { get: {} },
      },
    } as unknown as OpenAPIObject);
    expect(errorEnvelopeProblems(document)).toEqual([]);
  });
});
