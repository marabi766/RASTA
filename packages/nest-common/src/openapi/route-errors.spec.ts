import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { RastaError } from '../errors/rasta-error';
import { publishedApiErrorSchema } from './api-error';
import { healthProbeErrorSchema, publishApiErrors } from './error-document';
import {
  errorEnvelopeProblems,
  probeExceptionProblems,
  realFilterResponse,
  realRoutesOf,
  routeErrorProblems,
  type PublishedDocument,
  type RoutedApplication,
} from './published-body';
import { toJsonSchema } from './zod-schema';

/** FU-031: the publisher keeps typed refusals; the check reads the real routes and their answers. */

const typedRefusal = publishedApiErrorSchema.extend({
  details: z
    .array(
      z
        .object({ path: z.literal('thing'), code: z.literal('LOCKED'), message: z.string() })
        .strict(),
    )
    .optional(),
});
const TYPED_REF = { $ref: '#/components/schemas/ThingRefusal' };

/** Nest's document as the routes declare it, before publication. */
function declared(): PublishedDocument {
  return {
    paths: {
      '/things/{id}': {
        get: {
          responses: {
            '200': { description: 'Success' },
            '409': {
              description: 'Locked',
              content: { 'application/json': { schema: TYPED_REF } },
            },
          },
        },
      },
      '/things': { post: { responses: { '201': { description: 'Created' } } } },
    },
    components: { schemas: { ThingRefusal: toJsonSchema(typedRefusal) } },
  };
}

function refusal(area: string, code: string): RastaError {
  return new RastaError('CONFLICT', 'Refused', { details: [{ path: area, code, message: 'x' }] });
}

const BEFORE = ['<anonymous>', 'bound use', 'jsonParser', 'urlencodedParser'].map((name) => ({
  name,
}));
const AFTER = [{ name: '<anonymous>' }, { name: '<anonymous>' }];

/** An Express-shaped router as Nest builds it, holding `routes` (`METHOD path`, Express syntax). */
function appOf(routes: string[], extra: { at: number; layer: object }[] = []): RoutedApplication {
  const stack: object[] = [
    ...BEFORE,
    ...routes.map((entry) => {
      const [method, path] = entry.split(' ');
      return { name: 'handle', route: { path, methods: { [method!.toLowerCase()]: true } } };
    }),
    ...AFTER,
  ];
  for (const { at, layer } of extra) stack.splice(at, 0, layer);
  return { getHttpAdapter: () => ({ getInstance: () => ({ router: { stack } }) }) };
}

const ROUTES = ['GET /things/:id', 'POST /things'];

/** What the real filter answers for every request, with the path the middleware records. */
async function send(_method: string, url: string): Promise<{ status: number; body: unknown }> {
  const { status, body } = realFilterResponse(new HttpException('Refused', 500), {
    correlationId: 'c',
    path: url,
  });
  return { status, body };
}

function check(
  routes: string[] = ROUTES,
  published = publishApiErrors(declared()),
  options: Partial<Parameters<typeof routeErrorProblems>[2]> = {},
): Promise<string[]> {
  return routeErrorProblems(appOf(routes), published, {
    declared: declared(),
    send,
    refusal,
    ...options,
  });
}

describe('publishApiErrors keeps a route-declared typed refusal (FU-031)', () => {
  it('keeps the typed schema and supplies the envelope only where nothing was declared', () => {
    const published = publishApiErrors(declared());
    const get = (published.paths!['/things/{id}'] as { get: { responses: Record<string, any> } })
      .get;
    expect(get.responses['409'].content['application/json'].schema).toEqual(TYPED_REF);
    // OpenAPI's default response is JSON metadata, not Zod's unparsed default() method.
    // eslint-disable-next-line zod/no-default
    expect(get.responses.default.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });
  });

  it('refuses to publish an error body it cannot read', () => {
    const notJson = declared();
    (notJson.paths!['/things/{id}'] as any).get.responses['409'].content = {
      'text/plain': { schema: { type: 'string' } },
    };
    expect(() => publishApiErrors(notJson)).toThrow('not one JSON schema');
    const unresolved = declared();
    unresolved.components!.schemas = {};
    expect(() => publishApiErrors(unresolved)).toThrow('unresolved #/components/schemas/Thing');
  });

  it('accepts the typed schema at the probe check only where the route declared it', () => {
    const published = publishApiErrors(declared());
    expect(probeExceptionProblems(published, 's', [], { declared: declared(), refusal })).toEqual(
      [],
    );
    expect(probeExceptionProblems(published, 's', [], { refusal })).toContain(
      'GET /things/{id} 409: does not use the shared envelope',
    );
  });
});

describe('routeErrorProblems reads the real routes (FU-031)', () => {
  it('accepts a document that matches the routes and their real error bodies', async () => {
    await expect(check()).resolves.toEqual([]);
  });

  it('refuses a real route the document does not publish, and a published one no route serves', async () => {
    const problems = await check(['GET /things/:id', 'POST /things', 'DELETE /things/:id']);
    expect(problems).toContain('DELETE /things/{id}: served but not published');
    expect(await check(['GET /things/:id'])).toContain(
      'POST /things: published but no route serves it',
    );
  });

  it('holds exclusions to a reason, a real route and an unpublished path', async () => {
    const routes = [...ROUTES, 'GET /v1/*path'];
    expect(await check(routes, undefined, { excluded: { '/v1/*path': 'proxy' } })).toEqual([]);
    expect(await check(routes, undefined, { excluded: { '/v1/*path': ' ' } })).toContain(
      '/v1/*path: excluded without a reason',
    );
    expect(await check(ROUTES, undefined, { excluded: { '/gone': 'x' } })).toContain(
      '/gone: excluded but no route serves it',
    );
    expect(await check(ROUTES, undefined, { excluded: { '/things': 'x' } })).toContain(
      'POST /things: excluded but published',
    );
  });

  it('refuses a published document that erased a typed refusal the route declared', async () => {
    const erased = publishApiErrors(declared());
    (erased.paths!['/things/{id}'] as any).get.responses['409'].content = {
      'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
    };
    expect(await check(ROUTES, erased)).toContain(
      'GET /things/{id} 409: the error body the route declares is not the one published',
    );
    const changed = publishApiErrors(declared());
    (changed.components!.schemas!.ThingRefusal as any).description = 'drifted';
    expect(await check(ROUTES, changed)).toContain(
      'GET /things/{id} 409: the error body the route declares is not the one published',
    );
  });

  it('refuses an operation declared by a route but missing from the published document', async () => {
    const published = publishApiErrors(declared());
    delete (published.paths as any)['/things'];
    const problems = await check(['GET /things/:id'], published, {});
    expect(problems).toContain('POST /things: declared by its route but not published');
  });

  it('validates every real error answer against the route it came from', async () => {
    const wrong = async (method: string, url: string) => {
      const sent = await send(method, url);
      return { ...sent, body: { ...(sent.body as object), injected: true } };
    };
    expect(await check(ROUTES, undefined, { send: wrong })).toContain(
      'GET /things/01JD0000000000000000000000 500: $.injected: not allowed',
    );
  });

  it('accepts a D-121 health body only at its explicit probe exception', async () => {
    const health = { status: 'starting', checks: { database: false } };
    const withProbe = (): PublishedDocument => {
      const document = declared();
      document.paths!['/health/startup'] = {
        get: { responses: { '200': { description: 'Up' } } },
      };
      return document;
    };
    const probeSend = async (method: string, url: string) =>
      url === '/health/startup' ? { status: 503, body: health } : send(method, url);
    const routes = [...ROUTES, 'GET /health/startup'];
    const registry = { 'GET /health/startup 503': healthProbeErrorSchema('s', 'startup') };
    const published = publishApiErrors(withProbe(), registry);
    expect(
      await routeErrorProblems(appOf(routes), published, {
        declared: withProbe(),
        probeExceptions: registry,
        send: probeSend,
        refusal,
      }),
    ).toEqual([]);
    // r2 F3: the published D-121 branch alone authorizes nothing; only the registry does.
    expect(
      await routeErrorProblems(appOf(routes), published, {
        declared: withProbe(),
        send: probeSend,
        refusal,
      }),
    ).toContain('GET /health/startup 503: no path');
    const problems = await routeErrorProblems(appOf(routes), publishApiErrors(withProbe()), {
      declared: withProbe(),
      send: probeSend,
      refusal,
    });
    expect(problems).toContain('GET /health/startup 503: no path');
  });

  it('fails closed on what it cannot read', async () => {
    const unread = { getHttpAdapter: () => ({ getInstance: () => ({}) }) };
    expect(
      await routeErrorProblems(unread, publishApiErrors(declared()), {
        declared: declared(),
        send,
      }),
    ).toEqual(['the application routes cannot be read']);
    expect(() => realRoutesOf(appOf(['GET /things{/:id}']))).toThrow('cannot be resolved');
    expect(() => realRoutesOf(appOf([]))).toThrow('cannot read');
    const silent = async () => {
      throw new Error('socket hang up');
    };
    expect(await check(ROUTES, undefined, { send: silent })).toContain(
      'POST /things: no answer (socket hang up)',
    );
    const fine = async () => ({ status: 200, body: {} });
    expect(await check(ROUTES, undefined, { send: fine })).toContain(
      'no real route answered with an error body',
    );
  });
});

describe('every reference, mount and indirection is read or refused (FU-031 r2)', () => {
  it('F1: refuses a referenced response at publication and at every reader', async () => {
    const referenced = declared();
    (referenced.paths!['/things/{id}'] as any).get.responses['409'] = {
      $ref: '#/components/responses/Wrong',
    };
    expect(() => publishApiErrors(referenced)).toThrow('a referenced response');
    const published = publishApiErrors(declared());
    (published.paths!['/things/{id}'] as any).get.responses['409'] = {
      $ref: '#/components/responses/Wrong',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
    expect(() => probeExceptionProblems(published, 's', [], { refusal })).toThrow(
      'a referenced response',
    );
    await expect(check(ROUTES, published)).rejects.toThrow('a referenced response');
  });

  it('F2: refuses a mounted router, a sub-application and a middleware among the routes', () => {
    const router = { name: 'router', handle: { stack: [] } };
    expect(() => realRoutesOf(appOf(ROUTES, [{ at: 4, layer: router }]))).toThrow('cannot read');
    expect(() => realRoutesOf(appOf(ROUTES, [{ at: 5, layer: router }]))).toThrow(
      'the routing layer router cannot be read',
    );
    const subApp = { name: 'mounted_app', handle: () => undefined };
    expect(() => realRoutesOf(appOf(ROUTES, [{ at: 0, layer: subApp }]))).toThrow('cannot read');
    const terminal = { name: '<anonymous>', handle: () => undefined };
    expect(() => realRoutesOf(appOf(ROUTES, [{ at: 8, layer: terminal }]))).toThrow('cannot read');
  });

  it('F3: a declared schema that is not the envelope with narrowed details is refused', async () => {
    const other = { type: 'object', properties: { status: { const: 'starting' } } };
    const loose = (): PublishedDocument => {
      const document = declared();
      document.components!.schemas!.ThingRefusal = {
        anyOf: [toJsonSchema(typedRefusal), { ...other, description: 'D-121' }],
      };
      return document;
    };
    expect(
      probeExceptionProblems(publishApiErrors(loose()), 's', [], { declared: loose(), refusal }),
    ).toContain('GET /things/{id} 409: does not use the shared envelope');
    const healthOnThings = async () => ({
      status: 409,
      body: { status: 'starting' },
    });
    expect(
      await routeErrorProblems(appOf(ROUTES), publishApiErrors(loose()), {
        declared: loose(),
        send: healthOnThings,
        refusal,
      }),
    ).toContain('GET /things/01JD0000000000000000000000 409: no path');
    const opened = (): PublishedDocument => {
      const document = declared();
      (document.components!.schemas!.ThingRefusal as any).required = ['path', 'timestamp'];
      return document;
    };
    expect(
      probeExceptionProblems(publishApiErrors(opened()), 's', [], { declared: opened(), refusal }),
    ).toContain('GET /things/{id} 409: does not use the shared envelope');
  });

  it.each([
    [
      'an alias',
      (s: any) => ({ ...s, Alias: TYPED_REF, root: { $ref: '#/components/schemas/Alias' } }),
    ],
    ['a root anyOf', (s: any) => ({ ...s, root: { anyOf: [TYPED_REF] } })],
    [
      'references at details, items, variant, path and code',
      (s: any) => {
        const typed = structuredClone(s.ThingRefusal);
        const item = typed.properties.details.items;
        return {
          ...s,
          Path: item.properties.path,
          Code: item.properties.code,
          Variant: {
            ...item,
            properties: {
              ...item.properties,
              path: { $ref: '#/components/schemas/Path' },
              code: { $ref: '#/components/schemas/Code' },
            },
          },
          Items: { anyOf: [{ $ref: '#/components/schemas/Variant' }] },
          Details: { type: 'array', items: { $ref: '#/components/schemas/Items' } },
          ThingRefusal: {
            ...typed,
            properties: { ...typed.properties, details: { $ref: '#/components/schemas/Details' } },
          },
          root: TYPED_REF,
        };
      },
    ],
  ])('F4: finds a typed reason behind %s', (_name, shape) => {
    const document = declared();
    const schemas = shape(document.components!.schemas);
    const { root, ...components } = schemas;
    document.components!.schemas = components;
    (document.paths!['/things/{id}'] as any).get.responses['409'].content[
      'application/json'
    ].schema = root;
    const published = publishApiErrors(document);
    expect(probeExceptionProblems(published, 's', [])).toContain(
      'GET /things/{id} 409: lists thing/LOCKED but no refusal producer was given',
    );
    expect(errorEnvelopeProblems(published, { refusal })).toEqual([]);
  });

  it('F4: refuses details whose reasons cannot be read', () => {
    const document = declared();
    const item = (document.components!.schemas!.ThingRefusal as any).properties.details.items;
    item.properties.code = { type: 'string' };
    item.required = ['path', 'message'];
    expect(errorEnvelopeProblems(publishApiErrors(document), { refusal })).toContainEqual(
      expect.stringContaining('GET /things/{id} 409: its typed reasons cannot be read'),
    );
  });
});
