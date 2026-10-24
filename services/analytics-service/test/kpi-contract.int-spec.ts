import request from 'supertest';
import type { Logger } from '@rasta/logging';
import { buildAnalyticsOpenApiDocument } from '../src/openapi/document';
import { kpiValueReaders } from '../src/kpis/kpi.service';
import { KpiRepository } from '../src/kpis/kpi.repository';
import { actor, startApi, type ApiHarness } from './api-helpers';
import { cleanup, maintenanceCompleted, newCompletion, newOrganizationId, wire } from './helpers';
import { KPI_WINDOW } from './baseline-helpers';

// Test-only registry injection, before DTO/OpenAPI/service imports are evaluated.
// There is no third production KPI or implicit fallback dispatch.
jest.mock('../src/kpis/definitions', () => {
  const original = jest.requireActual('../src/kpis/definitions');
  return {
    ...original,
    KPI_DEFINITIONS: [
      ...original.KPI_DEFINITIONS,
      {
        key: 'TEST_ONLY_DOUBLE_COUNT',
        unit: 'TEST_COUNT',
        dependsOnBaseline: false,
        formula: 'Synthetic test only: twice the held completion count.',
      },
    ],
  };
});

const logs: unknown[] = [];
const capture = (...args: unknown[]): void => {
  logs.push(args);
};
const logger = {
  error: capture,
  warn: capture,
  info: capture,
  debug: capture,
} as unknown as Logger;
let api: ApiHarness;
const organizationId = newOrganizationId();
const wiring = wire();
const event = maintenanceCompleted(newCompletion(organizationId));
const readers = {
  ...kpiValueReaders,
  TEST_ONLY_DOUBLE_COUNT: (read: Awaited<ReturnType<KpiRepository['read']>>) => ({
    status: 'AVAILABLE' as const,
    value: (BigInt(read.completed_count) * 2n).toString(),
  }),
};

beforeAll(async () => {
  api = await startApi({ kpiReaders: readers, logger });
  await wiring.consumer.handle(event);
});
afterAll(async () => {
  await cleanup([organizationId], [event.eventId]);
  await Promise.all([api.close(), wiring.close()]);
});

function getKpis() {
  return request(api.app.getHttpServer())
    .get('/v1/kpis')
    .query(KPI_WINDOW)
    .set('authorization', `Bearer ${actor(organizationId, ['FLEET_MANAGER'])}`);
}

it('a synthetic third definition reaches both published enums and a served, semantically distinct value', async () => {
  const doc = buildAnalyticsOpenApiDocument(api.app);
  const schema = doc.paths['/v1/kpis']?.get?.responses?.['200'];
  const metadata = {
    key: {
      enum: [
        'MAINTENANCE_COMPLETED_COUNT',
        'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
        'TEST_ONLY_DOUBLE_COUNT',
      ],
    },
    unit: { enum: ['COUNT', 'MINUTES', 'TEST_COUNT'] },
  };
  expect(
    schema && 'content' in schema ? schema.content?.['application/json']?.schema : undefined,
  ).toMatchObject({
    properties: {
      kpis: { items: { anyOf: [{ properties: metadata }, { properties: metadata }] } },
    },
  });
  const response = await getKpis().expect(200);
  expect(response.body.kpis).toEqual([
    {
      key: 'MAINTENANCE_COMPLETED_COUNT',
      unit: 'COUNT',
      dependsOnBaseline: false,
      status: 'AVAILABLE',
      value: '1',
    },
    {
      key: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
      unit: 'MINUTES',
      dependsOnBaseline: true,
      status: 'INSUFFICIENT_BASELINE',
      value: null,
    },
    {
      key: 'TEST_ONLY_DOUBLE_COUNT',
      unit: 'TEST_COUNT',
      dependsOnBaseline: false,
      status: 'AVAILABLE',
      value: '2',
    },
  ]);
});

it('an unhandled definition fails closed as 500 rather than borrowing a value', async () => {
  const missing = await startApi({ logger });
  try {
    const response = await request(missing.app.getHttpServer())
      .get('/v1/kpis')
      .query(KPI_WINDOW)
      .set('authorization', `Bearer ${actor(organizationId, ['FLEET_MANAGER'])}`)
      .expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(response.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(response.body)).not.toContain('TEST_ONLY_DOUBLE_COUNT');
  } finally {
    await missing.close();
  }
});

it('response validation failure exposes no sentinel through the real global filter or captured logs', async () => {
  const sentinel = 'SENTINEL-PRIVATE-RESPONSE-VALUE';
  const spy = jest.spyOn(KpiRepository.prototype, 'read').mockResolvedValueOnce({
    completed_count: '1',
    baseline_minutes: sentinel,
    earliest_completion: null,
  });
  logs.length = 0;
  try {
    const response = await getKpis().expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(response.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(logs)).not.toContain(sentinel);
    expect(JSON.stringify(logs)).toContain('KPI_RESPONSE_INVALID');
    expect(JSON.stringify(logs)).not.toMatch(/ZodError|invalid_string/);
  } finally {
    spy.mockRestore();
  }
});
