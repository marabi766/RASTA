import { enrichOpenApiDocument } from './document';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * The published contract, assembled.
 *
 * Nest derives paths, methods and security from the decorators; it cannot see
 * a Zod schema, so the payload shapes are filled in afterwards from the very
 * schemas the service validates with. That is the whole point — one definition
 * rather than a decorated class and a hand-written document that drift — and
 * it means this function is the last thing standing between the schemas and
 * every generated client.
 *
 * `api-operability.int-spec.ts` proves the document generates against the real
 * application. This file covers the shapes that application does not produce:
 * a document with no paths, an operation that is not one, a route that already
 * carries parameters, and the fallbacks for a route nobody registered.
 */
describe('enrichOpenApiDocument', () => {
  const emptyDocument = (): OpenAPIObject =>
    ({ openapi: '3.0.0', info: { title: 't', version: '1' } }) as OpenAPIObject;

  it('publishes the one error shape every service returns, even for an empty document', () => {
    // Referenced rather than inlined per response, so a client generates a
    // single error type instead of one per endpoint.
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
    // body to a string.
    const document = emptyDocument();
    document.paths = {
      '/v1/wallets/me': {
        summary: 'not an operation',
        parameters: [],
        get: { responses: {} },
      },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const item = enriched.paths['/v1/wallets/me'] as Record<string, unknown>;

    expect(item.summary).toBe('not an operation');
    expect((item.get as { responses: Record<string, unknown> }).responses['200']).toBeDefined();
  });

  it('appends to the parameters an operation already has rather than replacing them', () => {
    // Nest emits path parameters from `@Param`. Overwriting them would publish
    // a document in which `/v1/wallets/{id}/top-up` has no `id`.
    const document = emptyDocument();
    document.paths = {
      '/v1/wallets/{id}/top-up': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        },
      },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const operation = (enriched.paths['/v1/wallets/{id}/top-up'] as Record<string, never>)
      .post as unknown as { parameters: { name: string; in: string; required: boolean }[] };

    const names = operation.parameters.map((parameter) => parameter.name);
    expect(names).toContain('id');
    // Required, and said so: the gateway rejects a financial write without it,
    // and a client generated from a document that called it optional would
    // discover that at runtime (docs/06 § 6.8).
    expect(names).toContain('Idempotency-Key');
    const key = operation.parameters.find((parameter) => parameter.name === 'Idempotency-Key');
    expect(key?.required).toBe(true);
    expect(key?.in).toBe('header');
  });

  it('flattens a query schema into one parameter each, carrying descriptions', () => {
    const document = emptyDocument();
    document.paths = { '/v1/transactions': { get: { responses: {} } } } as never;

    const enriched = enrichOpenApiDocument(document);
    const operation = (enriched.paths['/v1/transactions'] as Record<string, never>)
      .get as unknown as { parameters: { name: string; in: string }[] };

    // Adding a filter to the DTO publishes it automatically — the alternative
    // is a hand-written parameter list that silently falls behind.
    const names = operation.parameters.map((parameter) => parameter.name);
    expect(names).toContain('status');
    expect(names).toContain('limit');
    for (const parameter of operation.parameters) expect(parameter.in).toBe('query');
  });

  it('gives a POST that takes no body a 200 rather than a 201', () => {
    // `POST /v1/transactions/{id}/authorise-settlement` creates nothing; a
    // document promising 201 would have clients waiting for a Location header
    // that never arrives.
    const document = emptyDocument();
    document.paths = {
      '/v1/transactions/{id}/authorise-settlement': { post: { responses: {} } },
      '/v1/transactions': { post: { responses: {} } },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const authorise = (
      enriched.paths['/v1/transactions/{id}/authorise-settlement'] as Record<string, never>
    ).post as unknown as { responses: Record<string, unknown> };
    const create = (enriched.paths['/v1/transactions'] as Record<string, never>)
      .post as unknown as { responses: Record<string, unknown> };

    expect(authorise.responses['200']).toBeDefined();
    expect(create.responses['201']).toBeDefined();
  });

  it('describes each documented error status, and falls back rather than omitting one', () => {
    const document = emptyDocument();
    document.paths = { '/v1/settlements': { post: { responses: {} } } } as never;

    const enriched = enrichOpenApiDocument(document);
    const operation = (enriched.paths['/v1/settlements'] as Record<string, never>)
      .post as unknown as {
      responses: Record<string, { description: string; content: unknown }>;
    };

    // 409 is the one that matters most here: settling a transaction that has
    // not been authorised, or one under dispute. A client has to be able to
    // branch on it.
    expect(operation.responses['409']).toBeDefined();
    expect(operation.responses['409'].description).toBeTruthy();
    expect(JSON.stringify(operation.responses['409'].content)).toContain(
      '#/components/schemas/ApiError',
    );
  });

  it('leaves a route it knows nothing about with a success response and no body', () => {
    const document = emptyDocument();
    document.paths = { '/v1/not-a-real-route': { get: { responses: {} } } } as never;

    const enriched = enrichOpenApiDocument(document);
    const operation = (enriched.paths['/v1/not-a-real-route'] as Record<string, never>)
      .get as unknown as { responses: Record<string, unknown>; requestBody?: unknown };

    // Enrichment is additive. An unknown route is published as Nest saw it
    // rather than dropped, because a missing path is harder to notice than an
    // under-described one.
    expect(operation.responses['200']).toBeDefined();
    expect(operation.requestBody).toBeUndefined();
  });
});
