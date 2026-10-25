import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { schemaMismatches } from '../src/openapi/schema-mismatches';
import { TRANSACTION_RESPONSES } from '../src/openapi/transaction-view';
import type { JsonSchema } from '../src/openapi/zod-schema';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * Every transaction route's documented success against what the route sends,
 * in the document generated from the real controllers (Codex on #322).
 *
 * The routes are called for real, and each answer is looked up in the
 * document under the status it actually came with: that status must be the
 * route's one documented success, and its body must be the documented view.
 * The enrichment used to guess the status from the request — a POST with a
 * body creates — and put the view under a 201 that `dispute`,
 * `resolve-dispute`, `refund` and `cancel` never send, leaving their real 200
 * with no schema.
 */
describe('the documented transaction responses, against the routes', () => {
  let harness: ApiHarness;
  let http: Server;
  let document: OpenAPIObject;

  const payer = apiTenant('OAS-PAYER');
  const payee = apiTenant('OAS-PAYEE');
  const platform = apiTenant('OAS-PLATFORM');
  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asSystemAdmin = () => `Bearer ${admin(platform, ['SYSTEM_ADMIN'])}`;

  /** What each route answered, by `METHOD /path` as the document names it. */
  const answered = new Map<string, { status: number; body: unknown }>();
  /** Each command route's last request, sent again: a retry under the same key. */
  const retries = new Map<string, () => request.Test>();

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        harness.app,
        new DocumentBuilder().setTitle('t').setVersion('0.0.0').build(),
      ),
    );

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('oas-fund'))
      .send({ amountMinor: '10000000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);

    // The last command sent, as a retry with the same key and body would send it.
    let lastSent: (() => request.Test) | undefined;
    const sent = (send: () => request.Test) => {
      lastSent = send;
      return send();
    };
    const record = (route: string, response: request.Response) => {
      answered.set(route, { status: response.status, body: response.body });
      if (route.startsWith('POST ')) retries.set(route, lastSent!);
      return response.body as { id: string };
    };
    const create = (holdFunds: boolean) => {
      const key = id('oas-create');
      return sent(() =>
        request(http)
          .post('/v1/transactions')
          .set('authorization', asPayer())
          .set('idempotency-key', key)
          .send({
            transactionType: 'LOGISTICS',
            counterpartyOrganizationId: payee,
            grossAmountMinor: '5000',
            currency: 'IRR',
            holdFunds,
          }),
      );
    };
    const command = (transactionId: string, verb: string, auth: string, body?: object) => {
      const key = id(`oas-${verb}`);
      return sent(() =>
        request(http)
          .post(`/v1/transactions/${transactionId}/${verb}`)
          .set('authorization', auth)
          .set('idempotency-key', key)
          .send(body ?? {}),
      );
    };

    // Held, disputed, resolved back to the queue.
    const disputed = record('POST /v1/transactions', await create(true));
    record(
      'POST /v1/transactions/{id}/dispute',
      await command(disputed.id, 'dispute', asPayer(), { reason: 'Short by two pallets.' }),
    );
    record(
      'POST /v1/transactions/{id}/resolve-dispute',
      await command(disputed.id, 'resolve-dispute', asSystemAdmin(), {
        resolution: 'The delivery note shows every pallet.',
      }),
    );
    // Held, authorised.
    const authorised = record('POST /v1/transactions', await create(true));
    record(
      'POST /v1/transactions/{id}/authorise-settlement',
      await command(authorised.id, 'authorise-settlement', asPayer()),
    );
    // Held, returned by the payee.
    const refunded = record('POST /v1/transactions', await create(true));
    record(
      'POST /v1/transactions/{id}/refund',
      await command(refunded.id, 'refund', asPayee(), { reason: 'Not dispatched.' }),
    );
    // Nothing held, withdrawn.
    const cancelled = record('POST /v1/transactions', await create(false));
    record(
      'POST /v1/transactions/{id}/cancel',
      await command(cancelled.id, 'cancel', asPayer(), { reason: 'Withdrawn.' }),
    );

    record(
      'GET /v1/transactions/{id}',
      await request(http).get(`/v1/transactions/${disputed.id}`).set('authorization', asPayer()),
    );
    record(
      'GET /v1/transactions',
      await request(http).get('/v1/transactions?limit=5').set('authorization', asPayer()),
    );
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, platform]);
    await harness.close();
  });

  type Responses = Record<string, { content?: { 'application/json'?: { schema?: JsonSchema } } }>;
  const responsesOf = (route: string): Responses => {
    const [method, path] = route.split(' ') as [string, string];
    const item = document.paths[path] as unknown as Record<string, { responses: Responses }>;
    return item[method.toLowerCase()]?.responses ?? {};
  };

  it('called every documented transaction route', () => {
    expect([...answered.keys()].sort()).toEqual(Object.keys(TRANSACTION_RESPONSES).sort());
  });

  it.each(Object.entries(TRANSACTION_RESPONSES))(
    '%s: the status it answers is its one documented success, carrying %s',
    (route, view) => {
      const { status, body } = answered.get(route)!;
      const responses = responsesOf(route);

      expect([route, Object.keys(responses).filter((s) => s.startsWith('2'))]).toEqual([
        route,
        [String(status)],
      ]);
      const schema = responses[String(status)]?.content?.['application/json']?.schema;
      expect(schema).toEqual({ $ref: `#/components/schemas/${view}` });

      const components = (document.components?.schemas ?? {}) as Record<string, JsonSchema>;
      expect(schemaMismatches(schema!, body, route, components)).toEqual([]);
    },
  );

  it('documents the four that answer 200 under 200, and no 201', () => {
    for (const verb of ['dispute', 'resolve-dispute', 'refund', 'cancel']) {
      const route = `POST /v1/transactions/{id}/${verb}`;
      expect([route, answered.get(route)?.status]).toEqual([route, 200]);
      expect([route, Object.keys(responsesOf(route)).includes('201')]).toEqual([route, false]);
    }
  });

  it('replays an answer the previous release stored — without `resolvedDisputeId` — as the documented view (Codex on #352, finding 2)', async () => {
    const commands = Object.keys(TRANSACTION_RESPONSES).filter((route) =>
      route.startsWith('POST '),
    );
    expect([...retries.keys()].sort()).toEqual(commands.sort());
    const components = (document.components?.schemas ?? {}) as Record<string, JsonSchema>;

    // Every stored answer of the suite, as that release stored it.
    const stripped = await runUnscoped(
      'the suite rewrites its answers as the previous release stored them',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "idempotency_key"
         SET response_body = response_body - 'resolvedDisputeId'
       WHERE organization_id IN (${payer}, ${payee}, ${platform})
         AND response_body ? 'resolvedDisputeId'`,
    );
    expect(stripped).toBeGreaterThanOrEqual(commands.length);

    for (const route of commands) {
      const fresh = answered.get(route)!;
      const schema =
        responsesOf(route)[String(fresh.status)]!.content!['application/json']!.schema!;
      const { resolvedDisputeId: _dropped, ...asStored } = fresh.body as Record<string, unknown>;
      // Returned as stored, it would break the document.
      expect([route, schemaMismatches(schema, asStored, route, components)]).not.toEqual([
        route,
        [],
      ]);

      const replayed = await retries.get(route)!();
      expect([route, replayed.status]).toEqual([route, fresh.status]);
      expect([route, schemaMismatches(schema, replayed.body, route, components)]).toEqual([
        route,
        [],
      ]);
      // The stored answer, with the field it lacked as explicitly unknown.
      expect([route, replayed.body]).toEqual([route, { ...asStored, resolvedDisputeId: null }]);
    }
  });
});
