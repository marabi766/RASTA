import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { ulid } from 'ulid';
import { buildProcurementOpenApiDocument, formatDocument } from '../src/openapi/document';
import { actor, buyer, client, key, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';
import { responseSchemaOf, validateBody } from './openapi-body';
import { kekEnvironment } from './rfq-helpers';
import { startSupplierStub, type SupplierStub } from './supplier-stub';

/**
 * The published contract, checked against the service that answers it (the arrangement
 * construction-service, contract-service and inventory-service made):
 *
 *   **The committed document is the real application's.** Built from the booted `AppModule` and
 *   required to equal `docs/api/procurement-service.openapi.json` byte for byte; the unit spec
 *   proves the generator's module produces the same file.
 *
 *   **It describes exactly the routes the application serves**, read from the Express router.
 *   The statuses it documents are provoked by `demand.int-spec.ts`, `window.int-spec.ts`,
 *   `aggregation-cancel.int-spec.ts`, `tenancy.int-spec.ts` and the `rfq-*.int-spec.ts` suites.
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
  /** The database clock, pinned only to make READY aggregations for the cancel and RFQ routes. */
  const clock = new TestClock();
  /** supplier-service, for an RFQ's invitees (plan PR 6): its 503 and 504 are provoked too. */
  let supplier: SupplierStub;

  beforeAll(async () => {
    supplier = await startSupplierStub({ slowMs: 1500 });
    api = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '168',
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
        SUPPLIER_SERVICE_URL: supplier.url,
        PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS: '1000',
        ...kekEnvironment(),
      },
      { clock },
    );
    document = buildProcurementOpenApiDocument(api.app);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
    await supplier.close();
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
    const missing = { demand: `DMD_${ulid()}`, aggregation: `AGG_${ulid()}`, rfq: `RFQ_${ulid()}` };

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

    // A READY aggregation to cancel: a window ended by a later demand, the clock pinned for both.
    const CANCEL = '/v1/aggregations/{id}/cancel';
    const issuer = client(api, actor(a, ['ORGANIZATION_ADMIN']));
    const readyProduct = newProductId();
    clock.set(new Date('2032-01-01T08:00:00.000Z'));
    const ending = (await as.submit({ productId: readyProduct, quantity: 2 })).body;
    clock.set(new Date('2032-01-08T08:00:00.000Z'));
    await as.submit({ productId: readyProduct, quantity: 1 });
    // After the end it was cancelled at: a cancellation never precedes the end (its CHECK).
    clock.set(new Date('2032-01-09T08:00:00.000Z'));
    const ready = (await as.aggregation(ending.aggregationId as string)).body;
    expect(ready.status).toBe('READY');
    const cancelPath = `${AGGREGATIONS}/${ready.id as string}/cancel`;
    documentedAs('POST', CANCEL, await issuer.cancel(ready.id, ready.version + 1));
    documentedAs('POST', CANCEL, await issuer.post(cancelPath, { expectedVersion: ready.version }));
    documentedAs(
      'POST',
      CANCEL,
      await anonymous().post(cancelPath).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', CANCEL, await as.cancel(ready.id, ready.version));
    documentedAs('POST', CANCEL, await issuer.cancel(missing.aggregation, 1));
    // The OPEN window at its current version: the version is judged first (409), the status then.
    const openVersion = (await as.aggregation(aggregationId)).body.version as number;
    documentedAs('POST', CANCEL, await issuer.cancel(aggregationId, openVersion));
    documentedAs('POST', CANCEL, await issuer.cancel(ready.id, ready.version));
    clock.set(null);

    // The organization's settings (plan PR 3): read by a requester; recorded by the administrator.
    const SETTINGS = '/v1/aggregation-settings';
    documentedAs('GET', SETTINGS, await as.setting());
    documentedAs('GET', SETTINGS, await anonymous().get(SETTINGS));
    documentedAs('GET', SETTINGS, await other.setting());
    documentedAs('POST', SETTINGS, await issuer.recordSetting({ windowHours: 48 }));
    documentedAs('POST', SETTINGS, await issuer.recordSetting({ windowHours: 0 }));
    documentedAs(
      'POST',
      SETTINGS,
      await anonymous().post(SETTINGS).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', SETTINGS, await as.recordSetting({ expectedCurrentVersion: 1 }));
    documentedAs('POST', SETTINGS, await issuer.recordSetting({ expectedCurrentVersion: null }));

    // An RFQ (plan PR 6): issued from a READY aggregation, read, closed at its deadline, cancelled.
    const ISSUE = '/v1/aggregations/{id}/rfq';
    const RFQS = '/v1/rfqs';
    const RFQ = '/v1/rfqs/{id}';
    const CLOSE = '/v1/rfqs/{id}/close';
    const CANCEL_RFQ = '/v1/rfqs/{id}/cancel';
    const rfqProduct = newProductId();
    // In the past: the database judges a close's deadline on its own clock (`ck_rfq_deadline`).
    clock.set(new Date('2021-01-01T08:00:00.000Z'));
    const opening = (await as.submit({ productId: rfqProduct, quantity: 4 })).body;
    clock.set(new Date('2021-01-08T08:00:00.000Z'));
    await as.submit({ productId: rfqProduct, quantity: 1 });
    clock.set(new Date('2021-01-09T08:00:00.000Z'));
    const forRfq = (await as.aggregation(opening.aggregationId as string)).body;
    expect(forRfq.status).toBe('READY');
    const issueBody = (overrides: Record<string, unknown> = {}) => ({
      expectedVersion: forRfq.version,
      procurementNature: 'INQUIRY',
      quotationClosingAt: '2021-01-10T08:00:00.000Z',
      criteria: [
        {
          code: 'Q',
          label: 'Quality',
          weightBp: 10000,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 10,
        },
      ],
      invitedSupplierOrganizationIds: [supplier.organization()],
      ...overrides,
    });
    const issuePath = `${AGGREGATIONS}/${forRfq.id as string}/rfq`;
    documentedAs(
      'POST',
      ISSUE,
      await issuer.post(issuePath, issueBody({ procurementNature: undefined })),
    );
    documentedAs(
      'POST',
      ISSUE,
      await anonymous().post(issuePath).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', ISSUE, await as.issueRfq(forRfq.id, issueBody()));
    documentedAs('POST', ISSUE, await issuer.issueRfq(missing.aggregation, issueBody()));
    documentedAs(
      'POST',
      ISSUE,
      await issuer.issueRfq(forRfq.id, issueBody({ expectedVersion: forRfq.version + 1 })),
    );
    for (const standing of ['SUSPENDED', 'DOWN', 'SLOW'] as const) {
      const invitees = [supplier.organization(standing)];
      documentedAs(
        'POST',
        ISSUE,
        await issuer.issueRfq(forRfq.id, issueBody({ invitedSupplierOrganizationIds: invitees })),
      );
    }
    const issued = documentedAs('POST', ISSUE, await issuer.issueRfq(forRfq.id, issueBody()));
    const rfqId = issued.body.id as string;

    documentedAs('GET', RFQS, await as.rfqs('?side=BUYER'));
    documentedAs('GET', RFQS, await as.rfqs(''));
    documentedAs('GET', RFQS, await anonymous().get(`${RFQS}?side=BUYER`));
    documentedAs('GET', RFQS, await other.rfqs('?side=BUYER'));

    documentedAs('GET', RFQ, await as.rfq(rfqId));
    documentedAs('GET', RFQ, await anonymous().get(`${RFQS}/${rfqId}`));
    documentedAs('GET', RFQ, await other.rfq(rfqId));
    documentedAs('GET', RFQ, await as.rfq(missing.rfq));

    const closePath = `${RFQS}/${rfqId}/close`;
    documentedAs('POST', CLOSE, await issuer.closeRfq(rfqId));
    documentedAs('POST', CLOSE, await issuer.post(closePath, {}, 'short'));
    documentedAs(
      'POST',
      CLOSE,
      await anonymous().post(closePath).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', CLOSE, await as.closeRfq(rfqId));
    documentedAs('POST', CLOSE, await issuer.closeRfq(missing.rfq));
    clock.set(new Date('2021-01-10T08:00:00.000Z'));
    const closeKey = key();
    documentedAs('POST', CLOSE, await issuer.closeRfq(rfqId, closeKey));
    documentedAs('POST', CLOSE, await issuer.closeRfq(missing.rfq, closeKey));

    const cancelRfqPath = `${RFQS}/${rfqId}/cancel`;
    documentedAs('POST', CANCEL_RFQ, await issuer.cancelRfq(rfqId, 1));
    documentedAs('POST', CANCEL_RFQ, await issuer.post(cancelRfqPath, { expectedVersion: 2 }));
    documentedAs(
      'POST',
      CANCEL_RFQ,
      await anonymous().post(cancelRfqPath).set('idempotency-key', key()).send({}),
    );
    documentedAs('POST', CANCEL_RFQ, await as.cancelRfq(rfqId, 2));
    documentedAs('POST', CANCEL_RFQ, await issuer.cancelRfq(missing.rfq, 1));
    documentedAs('POST', CANCEL_RFQ, await issuer.cancelRfq(rfqId, 2));
    documentedAs('POST', CANCEL_RFQ, await issuer.cancelRfq(rfqId, 3));
    clock.set(null);

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
