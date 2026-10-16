import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { IdempotencyStore } from '../shared/idempotency';
import { OrderReturnsController, ReturnController } from '../returns/return.controller';
import { ReturnService } from '../returns/return.service';
import { enrichOpenApiDocument } from './document';

/**
 * The return-request routes as the running service publishes them (Codex r1 on #310, finding 2).
 *
 * Asserted on `SwaggerModule.createDocument` over the real controllers — the call `main.ts` makes —
 * then enriched, because the defect was a key mismatch between the two: the routes were in Nest's
 * document but under names (`{orderId}`) the enrichment did not know, so they went out with no
 * body, no query, no required `Idempotency-Key` and no errors. Only the finished document shows
 * that they now meet. The providers are stubs: building the document reads decorators, nothing runs.
 */
async function servedDocument(): Promise<OpenAPIObject> {
  const moduleRef = await Test.createTestingModule({
    controllers: [OrderReturnsController, ReturnController],
    providers: [
      { provide: ReturnService, useValue: {} },
      { provide: IdempotencyStore, useValue: {} },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Rasta — Marketplace Service').setVersion('test').build(),
  );
  await app.close();
  return enrichOpenApiDocument(document, { idempotencyTtlHours: 24 });
}

interface Operation {
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: {
    required: boolean;
    content: {
      'application/json': {
        schema: { properties?: Record<string, unknown>; required?: string[] };
      };
    };
  };
  responses: Record<string, { content?: unknown }>;
}

describe('the served return-request routes', () => {
  let document: OpenAPIObject;
  const operation = (path: string, method: string): Operation => {
    const found = (document.paths[path] as Record<string, Operation> | undefined)?.[method];
    if (!found) throw new Error(`${method.toUpperCase()} ${path} is not in the document`);
    return found;
  };
  const successOf = (op: Operation) =>
    Object.keys(op.responses).filter((status) => /^2\d\d$/.test(status));
  const errorsOf = (op: Operation) =>
    Object.keys(op.responses)
      .filter((status) => !/^2\d\d$/.test(status))
      .sort();
  const keyOf = (op: Operation) => op.parameters?.find((p) => p.name === 'Idempotency-Key');

  beforeAll(async () => {
    document = await servedDocument();
  });

  it('publishes all five routes under the parameter names the controllers use', () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v1/orders/{orderId}/returns',
      '/v1/returns',
      '/v1/returns/{id}',
      '/v1/returns/{id}/cancellation',
      '/v1/returns/{id}/decisions',
    ]);
  });

  it('describes the creation body, requires its key, and answers 201 only', () => {
    const create = operation('/v1/orders/{orderId}/returns', 'post');

    expect(create.requestBody?.required).toBe(true);
    const schema = create.requestBody?.content['application/json'].schema;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['lines', 'reason']);
    expect(schema?.required?.sort()).toEqual(['lines', 'reason']);
    expect(keyOf(create)).toMatchObject({ in: 'header', required: true });
    // The controller's @HttpCode(201), and no spurious 200 beside it.
    expect(successOf(create)).toEqual(['201']);
    expect(errorsOf(create)).toEqual(['400', '401', '403', '404', '409', '422', '500']);
  });

  it('describes the decision body, requires its key, and answers 200 only', () => {
    const decide = operation('/v1/returns/{id}/decisions', 'post');

    const schema = decide.requestBody?.content['application/json'].schema;
    expect(schema?.properties).toHaveProperty('decision');
    expect(schema?.required).toEqual(['decision']);
    expect(keyOf(decide)).toMatchObject({ in: 'header', required: true });
    // A decision creates nothing: 200, as the controller declares, never also 201.
    expect(successOf(decide)).toEqual(['200']);
    expect(errorsOf(decide)).toEqual(['400', '401', '403', '404', '409', '422', '500']);
  });

  it('requires the key on a cancellation, which takes no body, and answers 200', () => {
    const cancel = operation('/v1/returns/{id}/cancellation', 'post');

    expect(cancel.requestBody).toBeUndefined();
    expect(keyOf(cancel)).toMatchObject({ in: 'header', required: true });
    expect(successOf(cancel)).toEqual(['200']);
    expect(errorsOf(cancel)).toEqual(['400', '401', '403', '404', '409', '422', '500']);
  });

  it('publishes the list filters and pagination as query parameters, and no key on a read', () => {
    const list = operation('/v1/returns', 'get');

    const query = (list.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(query.sort()).toEqual(['cursor', 'limit', 'orderId', 'role', 'status']);
    expect(keyOf(list)).toBeUndefined();
    expect(successOf(list)).toEqual(['200']);
    expect(errorsOf(list)).toEqual(['400', '401', '403', '500']);

    const read = operation('/v1/returns/{id}', 'get');
    expect(keyOf(read)).toBeUndefined();
    expect(successOf(read)).toEqual(['200']);
    expect(errorsOf(read)).toEqual(['401', '403', '404', '500']);
  });

  it('refers every error to the one platform error shape', () => {
    const create = operation('/v1/orders/{orderId}/returns', 'post');
    expect(JSON.stringify(create.responses['409']?.content)).toContain(
      '#/components/schemas/ApiError',
    );
  });
});
