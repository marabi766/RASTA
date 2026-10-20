import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { ulid } from 'ulid';
import { buildProcurementOpenApiDocument, formatDocument } from '../src/openapi/document';
import { actor, buyer, client, key, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';
import { responseSchemaOf, validateBody } from './openapi-body';

/**
 * The published contract, checked against the service that answers it (the arrangement
 * construction-service, contract-service and inventory-service made):
 *
 *   **The committed document is the real application's.** Built from the booted `AppModule` and
 *   required to equal `docs/api/procurement-service.openapi.json` byte for byte; the unit spec
 *   proves the generator's module produces the same file.
 *
 *   **It describes exactly the routes the application serves**, read from the Express router.
 *   The statuses it documents are provoked by `demand.int-spec.ts`, `window.int-spec.ts` and
 *   `tenancy.int-spec.ts`.
 *
 *   **It accepts what the application answers** (PR-327 r1 F3): every documented status of every
 *   route, provoked here once, has its real body validated against the document's own schema for
 *   that operation and status — the envelope `AllExceptionsFilter` writes (`timestamp`, `path`,
 *   `correlationId`) included.
 */
const MAX_QUANTITY = 2_147_483_647;

describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi({
      PROCUREMENT_AGGREGATION_WINDOW_HOURS: '168',
      PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
      PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
    });
    document = buildProcurementOpenApiDocument(api.app);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  const runtimeRoutes = () => {
    const server = api.app.getHttpAdapter().getInstance() as {
      router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    return ((server.router ?? server._router)?.stack ?? [])
      .filter((layer) => layer.route && layer.route.path.startsWith('/v1/'))
      .flatMap((layer) =>
        Object.entries(layer.route!.methods)
          .filter(([, enabled]) => enabled)
          .map(
            ([method]) => `${method.toUpperCase()} ${layer.route!.path.replace(/:(\w+)/g, '{$1}')}`,
          ),
      );
  };

  it('is exactly the committed document', () => {
    const committedPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'api',
      'procurement-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the business routes the application answers on', () => {
    const documented = Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(documented).toEqual([...runtimeRoutes()].sort());
  });

  it('accepts the real body of every documented status of every route', async () => {
    const a = newOrganizationId();
    organizations.push(a);
    const as = client(api, buyer(a));
    const other = client(api, actor(a, ['FLEET_MANAGER']));
    const anonymous = () => request(api.app.getHttpServer());
    const provoked = new Set<string>();
    const problems: string[] = [];
    const documentedAs = (method: string, path: string, response: request.Response) => {
      const at = `${method} ${path} ${response.status}`;
      provoked.add(at);
      const schema = responseSchemaOf(document, method, path, response.status);
      for (const problem of validateBody(document, schema, response.body)) {
        problems.push(`${at}: ${problem}`);
      }
      return response;
    };

    const SUBMIT = '/v1/demand-requests';
    const DEMAND = '/v1/demand-requests/{id}';
    const WITHDRAW = '/v1/demand-requests/{id}/withdraw';
    const AGGREGATIONS = '/v1/aggregations';
    const AGGREGATION = '/v1/aggregations/{id}';
    const missing = { demand: `DMD_${ulid()}`, aggregation: `AGG_${ulid()}` };

    const demand = documentedAs(
      'POST',
      SUBMIT,
      await as.submit({ quantity: 3, note: 'for the depot' }),
    );
    const id = demand.body.id as string;
    documentedAs('POST', SUBMIT, await as.submit({ quantity: 0 }));
    documentedAs(
      'POST',
      SUBMIT,
      await anonymous().post(SUBMIT).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', SUBMIT, await other.submit({ quantity: 1 }));
    const reusedKey = key();
    await as.submit({ quantity: 1 }, reusedKey);
    documentedAs('POST', SUBMIT, await as.submit({ quantity: 2 }, reusedKey));
    const full = newProductId();
    await as.submit({ productId: full, quantity: MAX_QUANTITY });
    documentedAs('POST', SUBMIT, await as.submit({ productId: full, quantity: 1 }));

    documentedAs('GET', SUBMIT, await as.demands());
    documentedAs('GET', SUBMIT, await as.demands('?status=PENDING'));
    documentedAs('GET', SUBMIT, await anonymous().get(SUBMIT));
    documentedAs('GET', SUBMIT, await other.demands());

    documentedAs('GET', DEMAND, await as.demand(id));
    documentedAs('GET', DEMAND, await as.demand(missing.demand));
    documentedAs('GET', DEMAND, await anonymous().get(`${SUBMIT}/${id}`));
    documentedAs('GET', DEMAND, await other.demand(id));

    const stale = (await as.submit({ quantity: 1 })).body.id as string;
    documentedAs('POST', WITHDRAW, await as.withdraw(id, 1));
    documentedAs('POST', WITHDRAW, await as.withdraw(id, 2));
    documentedAs('POST', WITHDRAW, await as.withdraw(stale, 9));
    documentedAs('POST', WITHDRAW, await as.withdraw(missing.demand, 1));
    documentedAs(
      'POST',
      WITHDRAW,
      await as.post(`${SUBMIT}/${stale}/withdraw`, { expectedVersion: 1 }),
    );
    documentedAs(
      'POST',
      WITHDRAW,
      await anonymous().post(`${SUBMIT}/${stale}/withdraw`).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', WITHDRAW, await other.withdraw(stale, 1));

    const aggregationId = demand.body.aggregationId as string;
    documentedAs('GET', AGGREGATIONS, await as.aggregations());
    documentedAs('GET', AGGREGATIONS, await as.aggregations('?status=CLOSED'));
    documentedAs('GET', AGGREGATIONS, await anonymous().get(AGGREGATIONS));
    documentedAs('GET', AGGREGATIONS, await other.aggregations());

    documentedAs('GET', AGGREGATION, await as.aggregation(aggregationId));
    documentedAs('GET', AGGREGATION, await as.aggregation(missing.aggregation));
    documentedAs('GET', AGGREGATION, await anonymous().get(`${AGGREGATIONS}/${aggregationId}`));
    documentedAs('GET', AGGREGATION, await other.aggregation(aggregationId));

    expect(problems).toEqual([]);
    // Every status the document gives a route was answered here, but the 500 nothing provokes.
    const documented = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { responses?: object }>).flatMap(([method, op]) =>
        Object.keys(op.responses ?? {})
          .filter((status) => status !== '500')
          .map((status) => `${method.toUpperCase()} ${path} ${status}`),
      ),
    );
    expect([...provoked].sort()).toEqual(documented.sort());
  });
});
