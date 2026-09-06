import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { startApi, type ApiHarness } from './api-helpers';

/**
 * The published contract, built from the **running application**.
 *
 * `src/openapi/document.spec.ts` already checks what the enrichment adds to a
 * hand-made document. That cannot catch the failure that actually matters:
 * documentation drifting away from the routes the service serves. A controller
 * gains a route and the specification does not; a route is renamed and the
 * specification still advertises the old path; an endpoint nobody implemented
 * is documented and a client is written against it.
 *
 * So this file builds the document the way `main.ts` does — `SwaggerModule`
 * over the real `AppModule` — and compares it against the router the same
 * application is answering on. Neither side is written down here, so neither
 * can be updated to match the other by hand.
 */
describe('the OpenAPI document describes the application that is running', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;

  /** Every route the running application actually serves, as `METHOD /path`. */
  const runtimeRoutes = (): string[] => {
    // Express' own router, read from the adapter — the routes the application
    // resolves, not a list maintained beside it.
    const server = api.app.getHttpAdapter().getInstance() as {
      router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    const stack = (server.router ?? server._router)?.stack ?? [];

    const routes: string[] = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    return routes.sort();
  };

  /** Every route the document advertises, in the same shape. */
  const documentedRoutes = (): string[] => {
    const routes: string[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const method of Object.keys(item ?? {})) {
        routes.push(`${method.toUpperCase()} ${path}`);
      }
    }
    return routes.sort();
  };

  beforeAll(async () => {
    api = await startApi();
    document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        api.app,
        new DocumentBuilder()
          .setTitle('RASTA Supplier Service')
          .setVersion('1')
          .addBearerAuth()
          .build(),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await api.close();
  });

  it('documents exactly the ten supplier routes the controller serves', () => {
    const documented = documentedRoutes().filter((route) => route.includes('/suppliers'));
    expect(documented).toEqual([
      'GET /v1/suppliers',
      'GET /v1/suppliers/qualifications',
      'GET /v1/suppliers/qualified',
      'GET /v1/suppliers/{id}',
      'POST /v1/suppliers',
      'POST /v1/suppliers/{id}/qualifications',
      'POST /v1/suppliers/{id}/qualifications/{qualificationId}/approve',
      'POST /v1/suppliers/{id}/qualifications/{qualificationId}/reject',
      'POST /v1/suppliers/{id}/reinstate',
      'POST /v1/suppliers/{id}/suspend',
    ]);
  });

  it('advertises no route the application does not serve', () => {
    // The drift that produces a client written against an endpoint nobody
    // implemented.
    const runtime = new Set(
      runtimeRoutes().map((route) => route.replace(/:([A-Za-z0-9_]+)/g, '{$1}')),
    );
    const phantom = documentedRoutes().filter((route) => !runtime.has(route));
    expect(phantom).toEqual([]);
  });

  it('serves no supplier route the document omits', () => {
    // The drift that leaves a real endpoint undocumented, and therefore
    // unreviewed.
    const documented = new Set(documentedRoutes());
    const undocumented = runtimeRoutes()
      .map((route) => route.replace(/:([A-Za-z0-9_]+)/g, '{$1}'))
      .filter((route) => route.includes('/suppliers'))
      .filter((route) => !documented.has(route));
    expect(undocumented).toEqual([]);
  });

  it('exposes no Phase 2 surface', () => {
    // Q-12 is open: no score, no rating, no weight, no performance event, and
    // no endpoint or field that would imply one exists.
    //
    // Checked against **names** — routes, operation ids and schema properties —
    // rather than against the raw document. The prose deliberately says these
    // things are absent ("no free-text or rating sort", "no performance score
    // exists"), and a substring search over descriptions would fail on the
    // sentences that exist precisely to prevent the misunderstanding.
    const forbidden = /(performance|rating|score|weight|licen[cs]e)/i;

    const offenders: string[] = [];

    for (const [path, item] of Object.entries(document.paths ?? {})) {
      if (forbidden.test(path)) offenders.push(`path ${path}`);
      for (const [method, operation] of Object.entries(item ?? {})) {
        const id = (operation as { operationId?: string }).operationId;
        if (id && forbidden.test(id)) offenders.push(`operationId ${method} ${path} -> ${id}`);
      }
    }

    // Every property name anywhere in the document, however deeply nested.
    const walkNames = (node: unknown, trail: string): void => {
      if (Array.isArray(node)) {
        for (const entry of node) walkNames(entry, trail);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const properties = record.properties as Record<string, unknown> | undefined;
      if (properties && typeof properties === 'object') {
        for (const name of Object.keys(properties)) {
          if (forbidden.test(name)) offenders.push(`property ${trail}.${name}`);
        }
      }
      for (const [key, value] of Object.entries(record)) {
        walkNames(value, `${trail}.${key}`);
      }
    };
    walkNames(document.paths ?? {}, 'paths');
    walkNames(document.components ?? {}, 'components');

    expect(offenders).toEqual([]);
  });

  it('marks every operation as requiring a bearer token', () => {
    // Closed by default is a property of the contract as well as of the guard.
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      if (!path.includes('/suppliers')) continue;
      for (const [method, operation] of Object.entries(item ?? {})) {
        const security = (operation as { security?: unknown[] }).security;
        expect({ route: `${method} ${path}`, secured: Boolean(security?.length) }).toEqual({
          route: `${method} ${path}`,
          secured: true,
        });
      }
    }
  });
});
