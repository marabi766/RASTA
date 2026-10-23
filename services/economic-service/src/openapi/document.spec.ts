import { enrichOpenApiDocument, INTERNAL_TOKEN_SCHEME } from './document';
import { INVALID_CURSOR_MESSAGE } from '../shared/cursor';
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
  /** An operation as Nest emits it: the handler's success status, nothing else. */
  const nest = (status: string) => ({ responses: { [status]: { description: '' } } });

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
        get: nest('200'),
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
          ...nest('201'),
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
    document.paths = { '/v1/transactions': { get: nest('200') } } as never;

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

  it('publishes the business line a commission rule requires, and the commission filters (ADR-045)', () => {
    const document = emptyDocument();
    document.paths = {
      '/v1/commissions/rules': { post: nest('201'), get: nest('200') },
      '/v1/commissions': { get: nest('200') },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const rules = enriched.paths['/v1/commissions/rules'] as Record<string, never>;
    const body = JSON.stringify((rules.post as unknown as { requestBody: unknown }).requestBody);
    // Required, closed to the seven lines of the contract — never free text.
    expect(body).toMatch(/"required":\[[^\]]*"businessLine"/);
    expect(body).toContain('MARKETPLACE_SERVICE');

    const names = (path: string, operation: Record<string, never>) =>
      (operation.get as unknown as { parameters: { name: string }[] }).parameters.map(
        (parameter) => `${path}?${parameter.name}`,
      );
    expect(names('rules', rules)).toContain('rules?businessLine');
    const charges = enriched.paths['/v1/commissions'] as Record<string, never>;
    expect(names('commissions', charges)).toEqual(
      expect.arrayContaining(['commissions?businessLine', 'commissions?outcome']),
    );
  });

  it.each(['/v1/rewards/participation-rules', '/v1/rewards/recognition-rules'])(
    'publishes %s version creation as idempotent and preconditioned (#328 r1)',
    (path) => {
      const document = emptyDocument();
      // As Nest emits it: the route's `@HttpCode(201)` (#322 documents only the declared status).
      document.paths = { [path]: { post: nest('201') } } as never;

      const enriched = enrichOpenApiDocument(document);
      const create = (enriched.paths[path] as Record<string, never>).post as unknown as {
        parameters: { name: string; in: string; required: boolean }[];
        requestBody: unknown;
        responses: Record<string, { headers?: Record<string, unknown> }>;
      };
      const key = create.parameters.find((parameter) => parameter.name === 'Idempotency-Key');
      expect(key).toMatchObject({ in: 'header', required: true });
      expect(JSON.stringify(create.requestBody)).toMatch(
        /"required":\[[^\]]*"expectedCurrentVersion"/,
      );
      expect(create.responses['409']?.headers?.['Retry-After']).toBeDefined();
    },
  );

  it('documents the success body under the status the route declares, never a guessed one', () => {
    // `dispute` takes a body and answers 200 (`@HttpCode(200)`). Guessed from
    // the body, it was documented as a 201 carrying the view, and its real
    // 200 carried nothing (Codex on #322).
    const document = emptyDocument();
    document.paths = {
      '/v1/transactions/{id}/authorise-settlement': { post: nest('200') },
      '/v1/transactions/{id}/dispute': { post: nest('200') },
      '/v1/transactions': { post: nest('201') },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const responsesOf = (path: string) =>
      (
        (enriched.paths[path] as Record<string, never>).post as unknown as {
          responses: Record<string, { content?: unknown }>;
        }
      ).responses;
    const successes = (path: string) =>
      Object.keys(responsesOf(path)).filter((status) => status.startsWith('2'));

    expect(successes('/v1/transactions/{id}/authorise-settlement')).toEqual(['200']);
    expect(successes('/v1/transactions/{id}/dispute')).toEqual(['200']);
    expect(JSON.stringify(responsesOf('/v1/transactions/{id}/dispute')['200']?.content)).toContain(
      '#/components/schemas/TransactionDetailView',
    );
    expect(successes('/v1/transactions')).toEqual(['201']);
  });

  it.each([
    ['no success status', { responses: {} }],
    ['two success statuses', { responses: { '200': {}, '201': {} } }],
  ])('refuses a route that declares %s rather than guess', (_, operation) => {
    const document = emptyDocument();
    document.paths = { '/v1/transactions/{id}/refund': { post: operation } } as never;

    expect(() => enrichOpenApiDocument(document)).toThrow(
      /POST \/v1\/transactions\/\{id\}\/refund declares \d success statuses/,
    );
  });

  it('declares an optional integer Retry-After on an idempotent route’s 409, and only there', () => {
    // docs/06 § 6.8: the in-flight CONFLICT carries it. A route with no
    // Idempotency-Key has no in-flight state, so its 409 must not promise one.
    const document = emptyDocument();
    document.paths = {
      '/v1/settlements': { post: nest('201') },
      '/v1/ledger/journals/{id}/reverse': { post: nest('201') },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const conflictOf = (path: string) =>
      (
        (enriched.paths[path] as Record<string, never>).post as unknown as {
          responses: Record<string, { headers?: Record<string, unknown> }>;
        }
      ).responses['409'];

    expect(conflictOf('/v1/settlements')?.headers).toEqual({
      'Retry-After': expect.objectContaining({
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 3600 },
      }),
    });
    expect(conflictOf('/v1/ledger/journals/{id}/reverse')).toBeDefined();
    expect(conflictOf('/v1/ledger/journals/{id}/reverse')?.headers).toBeUndefined();
  });

  it('describes each documented error status, and falls back rather than omitting one', () => {
    const document = emptyDocument();
    document.paths = { '/v1/settlements': { post: nest('201') } } as never;

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

  it('names NO_ACTIVE_RULE on the settlement’s 422, and only there (docs/24 Q-29)', () => {
    const document = emptyDocument();
    document.paths = {
      '/v1/settlements': { post: nest('201') },
      '/v1/transactions': { post: nest('201') },
    } as never;

    const enriched = enrichOpenApiDocument(document);
    const unprocessable = (path: string) =>
      (
        (enriched.paths[path] as Record<string, never>).post as unknown as {
          responses: Record<string, { description: string }>;
        }
      ).responses['422']?.description;

    expect(unprocessable('/v1/settlements')).toContain('NO_ACTIVE_RULE');
    expect(unprocessable('/v1/settlements')).toContain('INSUFFICIENT_BALANCE');
    expect(unprocessable('/v1/transactions')).not.toContain('NO_ACTIVE_RULE');
  });

  it.each([
    '/v1/transactions',
    '/v1/settlements',
    '/v1/ledger/accounts/{id}/entries',
    '/v1/commissions',
    '/v1/payment-intents',
  ])('publishes the out-of-scope cursor refusal on %s', (path) => {
    // Every cursor-paginated list resolves its cursor in its own scope and
    // refuses one outside it with 400 (shared/cursor.ts). The document says
    // so, on the response and on the parameter, so a client can tell a
    // refused cursor from the end of the list.
    const document = emptyDocument();
    document.paths = { [path]: { get: nest('200') } } as never;

    const enriched = enrichOpenApiDocument(document);
    const operation = (enriched.paths[path] as Record<string, never>).get as unknown as {
      responses: Record<string, { description: string }>;
      parameters: { name: string; description?: string }[];
    };

    expect(operation.responses['400']?.description).toContain('cursor');
    const cursor = operation.parameters.find((parameter) => parameter.name === 'cursor');
    expect(cursor?.description).toContain(INVALID_CURSOR_MESSAGE);
    expect(cursor?.description).toContain('400 VALIDATION_FAILED');
  });

  describe('internal routes (ADR-061 § 4)', () => {
    const INTERNAL = '/v1/internal/obligations/by-source/STATEMENT/{statementId}';

    const enrichedWith = (path: string) => {
      const document = emptyDocument();
      // As Nest emits a plain @Get: 200 (#322 documents only the declared status).
      document.paths = { [path]: { get: nest('200') } } as never;
      const enriched = enrichOpenApiDocument(document);
      return {
        enriched,
        operation: (enriched.paths[path] as Record<string, never>).get as unknown as {
          security?: unknown;
          responses: Record<string, { description: string }>;
        },
      };
    };

    it('declares the internal token as an apiKey in X-Internal-Token, not a bearer token', () => {
      const { enriched } = enrichedWith(INTERNAL);

      expect(enriched.components?.securitySchemes?.[INTERNAL_TOKEN_SCHEME]).toMatchObject({
        type: 'apiKey',
        in: 'header',
        name: 'X-Internal-Token',
      });
    });

    it('requires that scheme alone on an internal route, with its own 403 and 404', () => {
      const { operation } = enrichedWith(INTERNAL);

      expect(operation.security).toEqual([{ [INTERNAL_TOKEN_SCHEME]: [] }]);
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '403', '404', '500']);
      expect(operation.responses['403']?.description).toContain('user token');
      expect(operation.responses['403']?.description).toContain('signed for no organization');
      expect(operation.responses['404']?.description).toContain('internal token is signed for');
    });

    it('gives a public route neither the internal scheme nor the internal wording', () => {
      const { operation } = enrichedWith('/v1/transactions/{id}');

      expect(operation.security).toBeUndefined();
      expect(operation.responses['403']?.description).toContain('AUDITOR');
    });
  });

  it('leaves a route it knows nothing about with a success response and no body', () => {
    const document = emptyDocument();
    document.paths = { '/v1/not-a-real-route': { get: nest('200') } } as never;

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
