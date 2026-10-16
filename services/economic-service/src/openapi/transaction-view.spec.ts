import type { OpenAPIObject } from '@nestjs/swagger';
import { enrichOpenApiDocument } from './document';
import { TRANSACTION_RESPONSES, TRANSACTION_VIEW_SCHEMAS } from './transaction-view';
import { toTransactionDetailView, toTransactionView } from '../shared/views';
import type { JsonSchema } from './zod-schema';

/**
 * The documented transaction against the one `shared/views.ts` writes.
 *
 * The view is an interface, so the document cannot be derived from it; this
 * is what keeps the two from drifting. Every documented property must be one
 * the view writes, with a value of the documented type — for a row with every
 * field set and for one with every optional field empty.
 */
describe('the documented transaction view', () => {
  const at = new Date('2026-10-16T10:00:00.000Z');

  const full = {
    id: 'TXN_1',
    organizationId: 'ORG-A',
    counterpartyOrganizationId: 'ORG-B',
    transactionType: 'LOGISTICS',
    businessLine: 'LOGISTICS',
    status: 'PENDING_SETTLEMENT',
    grossAmountMinor: 9_007_199_254_740_993n,
    commissionAmountMinor: 0n,
    netAmountMinor: 0n,
    currency: 'IRR',
    occurredAt: at,
    sourceType: 'E2E',
    sourceReference: 'REF-1',
    disputedAt: at,
    disputedBy: 'USR-PAYER',
    disputeReason: 'The delivered quantity does not match.',
    disputeResolvedAt: at,
    disputeResolvedBy: 'USR-PLATFORM',
    disputeResolution: 'Confirmed by the delivery note.',
    settledAt: at,
    failureReason: 'none',
    createdAt: at,
    createdBy: 'USR-PAYER',
    legs: [{ organizationId: 'ORG-A', role: 'PAYER', amountMinor: 1n, currency: 'IRR' }],
    commission: {
      id: 'CMS_1',
      ruleId: 'CMR_1',
      outcome: 'RULE_APPLIED',
      rateBasisPoints: 250,
      amountMinor: 2n,
    },
    settlement: { id: 'STL_1', journalId: 'JRN_1', settledAt: at },
  };

  const empty = {
    ...full,
    counterpartyOrganizationId: null,
    businessLine: null,
    sourceType: null,
    sourceReference: null,
    disputedAt: null,
    disputedBy: null,
    disputeReason: null,
    disputeResolvedAt: null,
    disputeResolvedBy: null,
    disputeResolution: null,
    settledAt: null,
    failureReason: null,
    legs: [],
    commission: { ...full.commission, ruleId: null },
    settlement: null,
  };

  /** The problems with `value` against `schema`, at `path`. */
  function mismatches(schema: JsonSchema, value: unknown, path: string): string[] {
    if (value === null) return schema.nullable === true ? [] : [`${path}: null, not nullable`];
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.replace('#/components/schemas/', '');
      const target = TRANSACTION_VIEW_SCHEMAS[name];
      return target ? mismatches(target, value, path) : [`${path}: unknown ${name}`];
    }
    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') return [`${path}: ${typeof value}, not string`];
        if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
          return [`${path}: not a date-time`];
        }
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
          return [`${path}: does not match ${schema.pattern}`];
        }
        return [];
      case 'integer':
        return Number.isInteger(value) ? [] : [`${path}: not an integer`];
      case 'boolean':
        return typeof value === 'boolean' ? [] : [`${path}: not a boolean`];
      case 'array':
        if (!Array.isArray(value)) return [`${path}: not an array`];
        return value.flatMap((item, i) =>
          mismatches(schema.items as JsonSchema, item, `${path}[${i}]`),
        );
      case 'object': {
        if (typeof value !== 'object') return [`${path}: not an object`];
        const record = value as Record<string, unknown>;
        const properties = schema.properties as Record<string, JsonSchema>;
        return Object.entries(properties).flatMap(([key, property]) =>
          key in record
            ? mismatches(property, record[key], `${path}.${key}`)
            : [`${path}.${key}: documented, never written`],
        );
      }
      default:
        return [`${path}: undocumented type ${String(schema.type)}`];
    }
  }

  it.each([
    ['every field set', full],
    ['every optional field empty', empty],
  ])('describes the detail view with %s', (_, row) => {
    const schema = TRANSACTION_VIEW_SCHEMAS.TransactionDetailView as JsonSchema;
    expect(mismatches(schema, toTransactionDetailView(row), 'detail')).toEqual([]);
  });

  it.each([
    ['every field set', full],
    ['every optional field empty', empty],
  ])('describes a list page with %s', (_, row) => {
    const page = { items: [toTransactionView(row)], nextCursor: null, hasMore: false };
    const schema = TRANSACTION_VIEW_SCHEMAS.TransactionPage as JsonSchema;
    expect(mismatches(schema, page, 'page')).toEqual([]);
  });

  it('writes and documents the dispute, its reason and its resolution apart', () => {
    const view = toTransactionView(full);
    expect(view).toMatchObject({
      disputedAt: at.toISOString(),
      disputedBy: 'USR-PAYER',
      disputeReason: 'The delivered quantity does not match.',
      disputeResolvedAt: at.toISOString(),
      disputeResolvedBy: 'USR-PLATFORM',
      disputeResolution: 'Confirmed by the delivery note.',
    });

    const properties = TRANSACTION_VIEW_SCHEMAS.TransactionView?.properties as Record<
      string,
      unknown
    >;
    for (const field of [
      'disputedBy',
      'disputeReason',
      'disputeResolvedAt',
      'disputeResolvedBy',
      'disputeResolution',
    ]) {
      expect(properties[field]).toEqual(expect.objectContaining({ nullable: true }));
    }
  });

  it('answers every transaction route with the documented view', () => {
    const operation = () => ({ responses: {} });
    const document = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/v1/transactions': { get: operation(), post: operation() },
        '/v1/transactions/{id}': { get: operation() },
        '/v1/transactions/{id}/authorise-settlement': { post: operation() },
        '/v1/transactions/{id}/dispute': { post: operation() },
        '/v1/transactions/{id}/resolve-dispute': { post: operation() },
        '/v1/transactions/{id}/refund': { post: operation() },
        '/v1/transactions/{id}/cancel': { post: operation() },
        '/v1/settlements': { post: operation() },
      },
    } as unknown as OpenAPIObject;

    const enriched = enrichOpenApiDocument(document);
    type Response = { content?: { 'application/json'?: { schema?: { $ref?: string } } } };
    const successRef = (path: string, method: string) => {
      const item = enriched.paths[path] as Record<string, { responses: Record<string, Response> }>;
      const responses = item[method]?.responses ?? {};
      const success = Object.entries(responses).find(([status]) => status.startsWith('2'));
      return success?.[1].content?.['application/json']?.schema?.$ref;
    };

    for (const [route, view] of Object.entries(TRANSACTION_RESPONSES)) {
      const [method, path] = route.split(' ') as [string, string];
      expect([route, successRef(path, method.toLowerCase())]).toEqual([
        route,
        `#/components/schemas/${view}`,
      ]);
    }
    for (const name of Object.keys(TRANSACTION_VIEW_SCHEMAS)) {
      expect(enriched.components?.schemas?.[name]).toBeDefined();
    }
    // A route that is not a transaction keeps the open success body.
    expect(successRef('/v1/settlements', 'post')).toBeUndefined();
  });
});
