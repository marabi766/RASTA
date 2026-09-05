import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { enrichOpenApiDocument } from './document';

/**
 * The published contract, assembled.
 *
 * Nest derives paths, methods and security from the decorators; it cannot see a
 * Zod schema, so the payload shapes are filled in afterwards from the very
 * schemas the service validates with. That is the point — one definition rather
 * than a decorated class and a hand-written document that drift — and it makes
 * this function the last thing standing between the schemas and every generated
 * client.
 *
 * It does **not** prove the document generates against the running application:
 * that needs the Nest factory and therefore a database, and this phase runs no
 * suite that has one. Stated plainly rather than implied — nothing here would
 * catch a decorator that stopped registering a route.
 */

const emptyDocument = (): OpenAPIObject =>
  ({ openapi: '3.0.0', info: { title: 't', version: '1' } }) as OpenAPIObject;

function withPaths(paths: Record<string, unknown>): OpenAPIObject {
  const document = emptyDocument();
  document.paths = paths as never;
  return document;
}

/**
 * Reads one member of a path item.
 *
 * Untyped on purpose: an OpenAPI path item is heterogeneous by construction —
 * `get` is an operation, `summary` is a string, `parameters` is an array — and
 * every assertion below re-checks the field it reads.
 */
const op = (document: OpenAPIObject, path: string, method: string): any =>
  (document.paths as Record<string, Record<string, unknown>> | undefined)?.[path]?.[method];

describe('the shared error shape', () => {
  it('is published even for an empty document', () => {
    // Referenced rather than inlined per response, so a client generates one
    // error type instead of one per endpoint.
    const document = enrichOpenApiDocument(emptyDocument());

    expect(document.components?.schemas?.ApiError).toBeDefined();
    expect(JSON.stringify(document.components?.schemas?.ApiError)).toContain('correlationId');
  });

  it('leaves an existing components block alone', () => {
    const document = emptyDocument();
    document.components = { schemas: { Existing: { type: 'object' } } } as never;

    const enriched = enrichOpenApiDocument(document);

    expect(enriched.components?.schemas?.Existing).toBeDefined();
    expect(enriched.components?.schemas?.ApiError).toBeDefined();
  });

  it('skips anything under a path that is not an operation', () => {
    // A path item may carry `parameters`, `summary` or `$ref` alongside its
    // methods. Treating one of those as an operation would attach a request
    // body to a string, or splice query parameters into an array.
    const document = enrichOpenApiDocument(
      withPaths({
        '/v1/suppliers': { summary: 'not an operation', parameters: [], get: { responses: {} } },
      }),
    );

    // Left exactly as it was — not enriched, not removed.
    expect(op(document, '/v1/suppliers', 'summary')).toBe('not an operation');
    expect(op(document, '/v1/suppliers', 'parameters')).toEqual([]);
    // The real operation beside it is still enriched.
    expect(op(document, '/v1/suppliers', 'get').responses['200']).toBeDefined();
  });
});

describe('request bodies', () => {
  it('publishes the register body with its bounded capability enum', () => {
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers': { post: {} } }));
    const body = JSON.stringify(op(document, '/v1/suppliers', 'post').requestBody);

    expect(body).toContain('displayName');
    expect(body).toContain('GOODS_SUPPLY');
    expect(body).toContain('WORKSHOP_SERVICE');
    expect(body).toContain('CONTRACTING');
  });

  it('publishes no organizationId on the register body', () => {
    // The client cannot name the organization; the token does. A document that
    // advertised the field would send an integrator to build a request the
    // service refuses.
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers': { post: {} } }));

    expect(JSON.stringify(op(document, '/v1/suppliers', 'post').requestBody)).not.toContain(
      'organizationId',
    );
  });

  it('publishes evidence as document identifiers and labels only', () => {
    const document = enrichOpenApiDocument(
      withPaths({ '/v1/suppliers/{id}/qualifications': { post: {} } }),
    );
    const body = JSON.stringify(
      op(document, '/v1/suppliers/{id}/qualifications', 'post').requestBody,
    );

    expect(body).toContain('documentId');
    expect(body).not.toContain('url');
    expect(body).not.toContain('objectKey');
  });

  it('publishes a required reason on rejection and an optional note', () => {
    const path = '/v1/suppliers/{id}/qualifications/{qualificationId}/reject';
    const document = enrichOpenApiDocument(withPaths({ [path]: { post: {} } }));
    const body = op(document, path, 'post').requestBody.content['application/json'].schema;

    expect(body.required).toContain('reason');
    expect(body.required).not.toContain('note');
  });
});

describe('response bodies', () => {
  it('publishes the catalogue-safe projection for the directory', () => {
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers': { get: {} } }));
    const response = JSON.stringify(op(document, '/v1/suppliers', 'get').responses['200']);

    expect(response).toContain('qualifiedFor');
    // The difference between the two projections is a security boundary, and
    // the document is where a client learns which one it is getting.
    expect(response).not.toContain('decisionNote');
    expect(response).not.toContain('evidence');
    expect(response).not.toContain('registeredBy');
    expect(response).not.toContain('suspensions');
  });

  it('publishes the private projection for the detail endpoint', () => {
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers/{id}': { get: {} } }));
    const response = JSON.stringify(op(document, '/v1/suppliers/{id}', 'get').responses['200']);

    expect(response).toContain('decisionNote');
    expect(response).toContain('documentId');
    expect(response).toContain('suspensions');
  });

  it('publishes 201 for the two endpoints that create, and 200 for the rest', () => {
    // Written down beside the schema rather than derived from the method, which
    // is how document-service published a 201 for an endpoint answering 200.
    const document = enrichOpenApiDocument(
      withPaths({
        '/v1/suppliers': { post: {} },
        '/v1/suppliers/{id}/qualifications': { post: {} },
        '/v1/suppliers/{id}/suspend': { post: {} },
        '/v1/suppliers/{id}/reinstate': { post: {} },
      }),
    );

    expect(op(document, '/v1/suppliers', 'post').responses['201']).toBeDefined();
    expect(
      op(document, '/v1/suppliers/{id}/qualifications', 'post').responses['201'],
    ).toBeDefined();
    expect(op(document, '/v1/suppliers/{id}/suspend', 'post').responses['200']).toBeDefined();
    expect(op(document, '/v1/suppliers/{id}/reinstate', 'post').responses['200']).toBeDefined();
  });

  it('publishes no score or rating anywhere', () => {
    const document = enrichOpenApiDocument(
      withPaths({
        '/v1/suppliers': { get: {}, post: {} },
        '/v1/suppliers/{id}': { get: {} },
        '/v1/suppliers/qualified': { get: {} },
      }),
    );

    expect(JSON.stringify(document)).not.toMatch(/"(score|rating|performanceScore)"/);
  });
});

describe('query parameters', () => {
  it('publishes the directory filters, including one behind a cross-field rule', () => {
    // `searchSuppliersQuerySchema` carries a `.superRefine()`, which wraps the
    // object in a ZodEffects. A converter that did not unwrap it would publish
    // no parameters at all — and the document would still be valid, so the
    // failure would be invisible.
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers': { get: {} } }));
    const names = op(document, '/v1/suppliers', 'get').parameters.map(
      (parameter: { name: string }) => parameter.name,
    );

    expect(names.sort()).toEqual(['capability', 'cursor', 'limit', 'qualifiedFor', 'status']);
  });

  it('marks the capability required on ListQualifiedFor', () => {
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers/qualified': { get: {} } }));
    const parameters = op(document, '/v1/suppliers/qualified', 'get').parameters as {
      name: string;
      required: boolean;
    }[];

    expect(parameters.find((p) => p.name === 'capability')?.required).toBe(true);
    expect(parameters.find((p) => p.name === 'cursor')?.required).toBe(false);
  });

  it('keeps parameters a route already declared', () => {
    const document = enrichOpenApiDocument(
      withPaths({
        '/v1/suppliers': { get: { parameters: [{ name: 'x-existing', in: 'header' }] } },
      }),
    );
    const names = op(document, '/v1/suppliers', 'get').parameters.map(
      (parameter: { name: string }) => parameter.name,
    );

    expect(names).toContain('x-existing');
    expect(names).toContain('qualifiedFor');
  });
});

describe('error descriptions', () => {
  it('explains the 404-for-another-tenant rule where a client will read it', () => {
    const document = enrichOpenApiDocument(withPaths({ '/v1/suppliers/{id}': { get: {} } }));
    const responses = op(document, '/v1/suppliers/{id}', 'get').responses;

    expect(responses['404'].description).toMatch(/never disclosed/);
  });

  it('explains that no role exempts anybody from the self-decision rule', () => {
    const document = enrichOpenApiDocument(
      withPaths({ '/v1/suppliers/{id}/suspend': { post: {} } }),
    );

    expect(op(document, '/v1/suppliers/{id}/suspend', 'post').responses['403'].description).toMatch(
      /own organization/,
    );
  });

  it('does not overwrite a description the decorators already set', () => {
    const document = enrichOpenApiDocument(
      withPaths({ '/v1/suppliers': { get: { responses: { '404': { description: 'mine' } } } } }),
    );

    expect(op(document, '/v1/suppliers', 'get').responses['404'].description).toBe('mine');
  });
});

describe('route ordering in the controller', () => {
  it('declares the literal directory routes before the :id parameter', () => {
    // Nest matches in declaration order. A literal segment after the parameter
    // is swallowed by it, and `GET /v1/suppliers/qualified` would look up a
    // supplier whose id is the word "qualified".
    const controller = readFileSync(
      join(__dirname, '..', 'supplier', 'supplier.controller.ts'),
      'utf8',
    );

    const qualified = controller.indexOf("@Get('qualified')");
    const queue = controller.indexOf("@Get('qualifications')");
    const byId = controller.indexOf("@Get(':id')");

    expect(qualified).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(qualified);
    expect(byId).toBeGreaterThan(queue);
  });

  it('exposes no performance endpoint', () => {
    // docs/04 § 4.10 names GET /suppliers/{id}/performance. It is absent
    // because Q-12 has not defined a score, and an endpoint returning an
    // invented number is worse than one that does not exist (ADR-041).
    const controller = readFileSync(
      join(__dirname, '..', 'supplier', 'supplier.controller.ts'),
      'utf8',
    );

    expect(controller).not.toMatch(/@Get\([^)]*performance/);
  });

  it('names AUDITOR in no @Roles', () => {
    // Layer two of the three-layer defence: the gateway table, every @Roles,
    // and assertNotAuditor on the row.
    const controller = readFileSync(
      join(__dirname, '..', 'supplier', 'supplier.controller.ts'),
      'utf8',
    );

    expect(controller).not.toMatch(/'AUDITOR'/);
  });
});
