import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ulid } from 'ulid';
import { buildContractOpenApiDocument, formatDocument } from '../src/openapi/document';
import { person, startApi, type ApiHarness } from './api-helpers';
import { cleanup, seedDraft, wire, type Wiring } from './helpers';

/**
 * The published contract, checked against the service that answers it (the arrangement
 * construction-service made):
 *
 *   **The committed document is the real application's.** Built from the booted `AppModule` and
 *   required to equal `docs/api/contract-service.openapi.json` byte for byte; the unit spec
 *   proves the generator's module produces the same file.
 *
 *   **It describes exactly the routes the application serves.** Read from the Express router.
 *
 *   **Every documented status of the two commands is reachable** by a real request (500 aside),
 *   so no documented status is a lie a client must branch for.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let w: Wiring;
  let document: OpenAPIObject;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    w = wire();
    document = buildContractOpenApiDocument(api.app);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  it('is exactly the committed document', () => {
    const committedPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'api',
      'contract-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the business routes the application answers on', () => {
    const server = api.app.getHttpAdapter().getInstance() as {
      router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    const runtime = ((server.router ?? server._router)?.stack ?? [])
      .filter((layer) => layer.route && layer.route.path.startsWith('/v1/'))
      .flatMap((layer) =>
        Object.entries(layer.route!.methods)
          .filter(([, enabled]) => enabled)
          .map(
            ([method]) => `${method.toUpperCase()} ${layer.route!.path.replace(/:(\w+)/g, '{$1}')}`,
          ),
      )
      .sort();

    const documented = Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

    expect(documented).toEqual(runtime);
  });

  it('can produce every documented status of the commands except 500', async () => {
    const documented = new Set<string>();
    for (const command of ['sign', 'cancel']) {
      const operation = (
        document.paths?.[`/v1/contracts/{id}/${command}`] as unknown as {
          post: { responses: object };
        }
      ).post;
      for (const status of Object.keys(operation.responses)) documented.add(status);
    }

    const { id, employer, contractor } = await seedDraft(w, organizations);
    const stranger = `ORG-OAS-${ulid()}`;
    organizations.push(stranger);
    const http = () => request(api.app.getHttpServer());
    const post = (
      command: 'sign' | 'cancel',
      contractId: string,
      token: string | undefined,
      body: object,
      key: string | undefined = `oas-${ulid()}`,
    ) => {
      const r = http().post(`/v1/contracts/${contractId}/${command}`);
      if (token) r.set('authorization', `Bearer ${token}`);
      if (key) r.set('idempotency-key', key);
      return r.send(body);
    };
    const employerToken = person(employer, ['ORGANIZATION_ADMIN']);
    const contractorToken = person(contractor, ['CONTRACTOR']);
    const reached = new Set<string>();
    const note = async (call: ReturnType<typeof post>) => {
      reached.add(String((await call).status));
    };

    await note(post('sign', id, employerToken, {})); // 200
    await note(post('sign', id, employerToken, { side: 'EMPLOYER' })); // 400
    await note(post('sign', id, undefined, {})); // 401
    await note(post('sign', id, person(employer, ['DRIVER']), {})); // 403
    await note(post('sign', id, person(stranger, ['ORGANIZATION_ADMIN']), {})); // 404
    await note(post('sign', id, person(employer, ['ORGANIZATION_ADMIN']), {})); // 409 SIDE_ALREADY_SIGNED
    await note(post('cancel', id, employerToken, { reasonCode: 'BECAUSE' })); // 422
    await note(post('cancel', id, contractorToken, { reasonCode: 'OTHER' })); // 403

    for (const status of documented) {
      if (status === '500') continue;
      expect({ status, reached: reached.has(status) }).toEqual({ status, reached: true });
    }
    // The statuses a client is told about are the ones the service answers.
    for (const status of reached) expect(documented.has(status)).toBe(true);
  });
});
