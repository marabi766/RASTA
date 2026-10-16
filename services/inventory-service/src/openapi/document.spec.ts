import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  RESPONSE_BODIES,
  buildDocumentationApp,
  buildInventoryOpenApiDocument,
  formatDocument,
} from './document';
import { REFUSAL_REASONS } from '../shared/refusal';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/inventory-service.openapi.json` is checked in so an API change shows in a PR's diff;
 * this spec turns "remember to regenerate" into a failing test. That the document describes the
 * **real** application is `test/openapi.int-spec.ts`.
 */

type Operation = {
  security?: unknown;
  parameters: { name: string; in: string; required?: boolean }[];
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>;
      content?: Record<string, { schema: { properties?: Record<string, unknown> } }>;
    }
  >;
};

describe('the committed OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const committedPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'api',
    'inventory-service.openapi.json',
  );

  const operations = () =>
    Object.entries(buildInventoryOpenApiDocument(app).paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Operation>).map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${path}`,
        operation,
      })),
    );
  const operation = (key: string): Operation =>
    operations().find((entry) => entry.key === key)!.operation;

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildInventoryOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes the warehouse, stock, reservation (PR 1) and shipment (PR 2) routes, each closed', () => {
    const keys = operations().map((o) => o.key);
    expect(keys.sort()).toEqual(Object.keys(RESPONSE_BODIES).sort());
    expect(keys.sort()).toEqual([
      'GET /v1/return-shipments',
      'GET /v1/return-shipments/{id}',
      'GET /v1/return-shipments/{id}/tracking',
      'GET /v1/shipments',
      'GET /v1/shipments/{id}',
      'GET /v1/shipments/{id}/tracking',
      'GET /v1/stock',
      'GET /v1/stock/movements',
      'GET /v1/stock/reservations',
      'GET /v1/stock/reservations/{id}',
      'GET /v1/stock/{id}',
      'GET /v1/warehouses',
      'GET /v1/warehouses/{id}',
      'POST /v1/return-shipments',
      'POST /v1/return-shipments/{id}/inspection',
      'POST /v1/return-shipments/{id}/receive',
      'POST /v1/return-shipments/{id}/resolution',
      'POST /v1/shipments',
      'POST /v1/shipments/{id}/deliver',
      'POST /v1/shipments/{id}/dispatch',
      'POST /v1/stock/adjustments',
      'POST /v1/stock/receipts',
      'POST /v1/stock/reservations',
      'POST /v1/stock/reservations/{id}/issue',
      'POST /v1/stock/reservations/{id}/release',
      'POST /v1/warehouses',
    ]);
    for (const { operation: op } of operations()) {
      expect(op.security).toEqual([{ bearer: [] }]);
    }
  });

  it('requires an Idempotency-Key on every command and on nothing else', () => {
    for (const { key, operation: op } of operations()) {
      const headers = op.parameters.filter((p) => p.in === 'header');
      if (key.startsWith('POST ')) {
        expect([key, headers]).toEqual([
          key,
          [expect.objectContaining({ name: 'Idempotency-Key', required: true })],
        ]);
        expect(op.responses['409']?.headers).toHaveProperty('Retry-After');
      } else {
        expect([key, headers]).toEqual([key, []]);
        expect([key, op.responses['409']]).toEqual([key, undefined]);
      }
    }
  });

  it('types each stock command’s 422 and 409 with its closed reasons', () => {
    const codesOf = (key: string, status: string) => {
      const schema = operation(key).responses[status]?.content?.['application/json']?.schema as {
        properties: { details: { items: { properties: { code: { enum: string[] } } } } };
      };
      return schema.properties.details.items.properties.code.enum;
    };
    expect(codesOf('POST /v1/stock/reservations', '422')).toEqual([
      'INSUFFICIENT_AVAILABLE_STOCK',
      'LINES_SPAN_WAREHOUSES',
      'EXPIRY_OUT_OF_RANGE',
      'HOLDER_NOT_OWNER',
    ]);
    expect(codesOf('POST /v1/stock/reservations/{id}/issue', '409')).toEqual([
      'RESERVATION_NOT_ACTIVE',
    ]);
    expect(codesOf('POST /v1/stock/adjustments', '422')).toEqual(
      Object.keys(REFUSAL_REASONS.stock),
    );
    expect(codesOf('POST /v1/shipments/{id}/deliver', '409')).toEqual([
      'SHIPMENT_NOT_CREATED',
      'SHIPMENT_NOT_DISPATCHED',
    ]);
  });

  it('answers 404 on a read by id and on a command whose body names a row, never on a list or on creating a warehouse', () => {
    expect(operation('GET /v1/stock/{id}').responses['404']).toBeDefined();
    expect(operation('POST /v1/stock/receipts').responses['404']).toBeDefined();
    expect(operation('POST /v1/shipments').responses['404']).toBeDefined();
    expect(operation('GET /v1/shipments/{id}/tracking').responses['404']).toBeDefined();
    expect(operation('GET /v1/stock').responses['404']).toBeUndefined();
    expect(operation('GET /v1/shipments').responses['404']).toBeUndefined();
    expect(operation('POST /v1/warehouses').responses['404']).toBeUndefined();
    expect(operation('POST /v1/warehouses').responses['422']).toBeUndefined();
  });

  it('gives a shipment command no 422: it breaks no stock rule, it can only be in the wrong state', () => {
    for (const key of [
      'POST /v1/shipments',
      'POST /v1/shipments/{id}/dispatch',
      'POST /v1/shipments/{id}/deliver',
    ]) {
      expect([key, operation(key).responses['422']]).toEqual([key, undefined]);
    }
  });

  it('answers 201 when something is created, 200 otherwise', () => {
    for (const { key, operation: op } of operations()) {
      const created = RESPONSE_BODIES[key]?.status === '201';
      expect([key, op.responses['201'] !== undefined]).toEqual([key, created]);
      expect([key, op.responses['200'] !== undefined]).toEqual([key, !created]);
    }
  });
});
