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
 * This file covers the enrichment itself, including the shapes the running
 * application does not produce: a document with no paths, an operation that is
 * not one, a route that already carries parameters, and the fallbacks for a
 * route nobody registered.
 *
 * It does **not** prove the document generates against the real application —
 * economic-service has an `api-operability.int-spec.ts` for that and this
 * service has no equivalent, which an earlier version of this comment claimed
 * it did. Stated plainly rather than removed, because the gap is real: nothing
 * here would catch a decorator that stopped registering a route.
 */
describe('enrichOpenApiDocument', () => {
  const emptyDocument = (): OpenAPIObject =>
    ({ openapi: '3.0.0', info: { title: 't', version: '1' } }) as OpenAPIObject;

  /** The default the environment schema carries, unless a test names another. */
  const OPTIONS = { idempotencyTtlHours: 24 };

  it('publishes the one error shape every service returns, even for an empty document', () => {
    // Referenced rather than inlined per response, so a client generates a
    // single error type instead of one per endpoint.
    const document = enrichOpenApiDocument(emptyDocument(), OPTIONS);

    expect(document.components?.schemas?.ApiError).toBeDefined();
    expect(JSON.stringify(document.components?.schemas?.ApiError)).toContain('correlationId');
  });

  it('leaves an existing components block alone', () => {
    const document = emptyDocument();
    document.components = { schemas: { Existing: { type: 'object' } } } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);

    expect(enriched.components?.schemas?.Existing).toBeDefined();
    expect(enriched.components?.schemas?.ApiError).toBeDefined();
  });

  it('skips anything under a path that is not an operation', () => {
    // A path item may carry `parameters`, `summary` or `$ref` alongside its
    // methods. Treating one of those as an operation would attach a request
    // body to a string.
    const document = emptyDocument();
    document.paths = {
      '/v1/orders': {
        summary: 'not an operation',
        parameters: [],
        get: { responses: {} },
      },
    } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const item = enriched.paths['/v1/orders'] as Record<string, unknown>;

    expect(item.summary).toBe('not an operation');
    expect((item.get as { responses: Record<string, unknown> }).responses['200']).toBeDefined();
  });

  it('appends to the parameters an operation already has rather than replacing them', () => {
    // Nest emits path parameters from `@Param`. Overwriting them would publish
    // a document in which `/v1/wallets/{id}/top-up` has no `id`.
    const document = emptyDocument();
    document.paths = {
      '/v1/orders/{id}/cancel': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        },
      },
    } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const operation = (enriched.paths['/v1/orders/{id}/cancel'] as Record<string, never>)
      .post as unknown as { parameters: { name: string; in: string; required: boolean }[] };

    const names = operation.parameters.map((parameter) => parameter.name);
    expect(names).toContain('id');
    // Required, and said so: the gateway rejects an unsafe order write without it,
    // and a client generated from a document that called it optional would
    // discover that at runtime (docs/06 § 6.8).
    expect(names).toContain('Idempotency-Key');
    const key = operation.parameters.find((parameter) => parameter.name === 'Idempotency-Key');
    expect(key?.required).toBe(true);
    expect(key?.in).toBe('header');
  });

  describe('the retention window the key description states', () => {
    /** The `Idempotency-Key` parameter of `POST /v1/orders`, as published. */
    function keyDescription(idempotencyTtlHours: number): string {
      const document = emptyDocument();
      document.paths = { '/v1/orders': { post: { responses: {} } } } as never;

      const enriched = enrichOpenApiDocument(document, { idempotencyTtlHours });
      const operation = (enriched.paths['/v1/orders'] as Record<string, never>).post as unknown as {
        parameters: { name: string; description: string }[];
      };
      const parameter = operation.parameters.find((p) => p.name === 'Idempotency-Key');
      if (!parameter) throw new Error('the Idempotency-Key parameter was not published');
      return parameter.description;
    }

    it('is the configured one, not a number written beside the configuration', () => {
      // `MARKETPLACE_IDEMPOTENCY_TTL_HOURS` accepts 1..168. A document that
      // always claimed 24 would be wrong on every deployment that set anything
      // else, and wrong in the direction that matters: a client reading it
      // builds a retry policy around a window the service does not honour.
      expect(keyDescription(72)).toContain('72 hours');
      expect(keyDescription(1)).toContain('1 hour');
      expect(keyDescription(168)).toContain('168 hours');
    });

    it('states no window the configuration did not produce', () => {
      // The regression guard. A literal reintroduced anywhere in this
      // description — 24, or any other fixed figure — shows up as a second
      // number in a document generated with a different setting.
      const description = keyDescription(72);
      const numbers = description.match(/\b\d+\b/g) ?? [];

      // 409 is the documented status; 72 is the configured window. Nothing else.
      expect(numbers.sort()).toEqual(['409', '72']);
      expect(description).not.toContain('24');
    });

    it('says the window is configured, so a reader does not take it for a constant', () => {
      expect(keyDescription(24)).toMatch(/configured/i);
    });
  });

  it('flattens a query schema into one parameter each, carrying descriptions', () => {
    const document = emptyDocument();
    document.paths = { '/v1/orders': { get: { responses: {} } } } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const operation = (enriched.paths['/v1/orders'] as Record<string, never>).get as unknown as {
      parameters: { name: string; in: string }[];
    };

    // Adding a filter to the DTO publishes it automatically — the alternative
    // is a hand-written parameter list that silently falls behind.
    const names = operation.parameters.map((parameter) => parameter.name);
    expect(names).toContain('status');
    expect(names).toContain('limit');
    for (const parameter of operation.parameters) expect(parameter.in).toBe('query');
  });

  it('gives a POST that takes no body a 200 rather than a 201', () => {
    // `POST /v1/orders/{id}/authorise-settlement` creates nothing; a
    // document promising 201 would have clients waiting for a Location header
    // that never arrives.
    const document = emptyDocument();
    document.paths = {
      '/v1/orders/{id}/authorise-settlement': { post: { responses: {} } },
      '/v1/orders': { post: { responses: {} } },
    } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const authorise = (
      enriched.paths['/v1/orders/{id}/authorise-settlement'] as Record<string, never>
    ).post as unknown as { responses: Record<string, unknown> };
    const create = (enriched.paths['/v1/orders'] as Record<string, never>).post as unknown as {
      responses: Record<string, unknown>;
    };

    expect(authorise.responses['200']).toBeDefined();
    expect(create.responses['201']).toBeDefined();
  });

  it('describes each documented error status, and falls back rather than omitting one', () => {
    const document = emptyDocument();
    document.paths = { '/v1/offers': { post: { responses: {} } } } as never;

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const operation = (enriched.paths['/v1/offers'] as Record<string, never>).post as unknown as {
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

    const enriched = enrichOpenApiDocument(document, OPTIONS);
    const operation = (enriched.paths['/v1/not-a-real-route'] as Record<string, never>)
      .get as unknown as { responses: Record<string, unknown>; requestBody?: unknown };

    // Enrichment is additive. An unknown route is published as Nest saw it
    // rather than dropped, because a missing path is harder to notice than an
    // under-described one.
    expect(operation.responses['200']).toBeDefined();
    expect(operation.requestBody).toBeUndefined();
  });
});
