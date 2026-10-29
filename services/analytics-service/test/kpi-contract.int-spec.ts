import request from 'supertest';
import type { Logger } from '@rasta/logging';
import { buildAnalyticsOpenApiDocument } from '../src/openapi/document';
import { kpiValueReaders, type KpiContext } from '../src/kpis/kpi.service';
import { KpiRepository } from '../src/kpis/kpi.repository';
import { actor, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  clearCoverage,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  plantCoverage,
  wire,
} from './helpers';
import { COVERED_SINCE, KPI_WINDOW } from './baseline-helpers';

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
const event = maintenanceCompleted(
  newCompletion(organizationId, { completedAt: '2026-07-10T07:30:00.000Z' }),
);
const readers = {
  ...kpiValueReaders,
  // Honours the coverage verdict like the production count: the contract is the same.
  TEST_ONLY_DOUBLE_COUNT: (read: KpiContext) =>
    read.projection_covers_window
      ? { status: 'AVAILABLE' as const, value: (BigInt(read.completed_count) * 2n).toString() }
      : { status: 'NO_DATA' as const },
};

beforeAll(async () => {
  api = await startApi({ kpiReaders: readers, logger });
  await plantCoverage(COVERED_SINCE);
  await wiring.consumer.handle(event);
});
afterAll(async () => {
  await cleanup([organizationId], [event.eventId]);
  await clearCoverage();
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
      kpis: {
        items: {
          anyOf: [{ properties: metadata }, { properties: metadata }, { properties: metadata }],
        },
      },
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

it('NO_DATA is published as its own variant with no value property, and served when coverage is gone', async () => {
  const doc = buildAnalyticsOpenApiDocument(api.app);
  const response = doc.paths['/v1/kpis']?.get?.responses?.['200'];
  const published = JSON.stringify(
    response && 'content' in response ? response.content?.['application/json']?.schema : undefined,
  );
  expect(published).toContain('NO_DATA');
  await clearCoverage();
  try {
    const served = await getKpis().expect(200);
    expect(served.body.kpis[0]).toEqual({
      key: 'MAINTENANCE_COMPLETED_COUNT',
      unit: 'COUNT',
      dependsOnBaseline: false,
      status: 'NO_DATA',
    });
    expect(served.body.kpis[2]).toEqual({
      key: 'TEST_ONLY_DOUBLE_COUNT',
      unit: 'TEST_COUNT',
      dependsOnBaseline: false,
      status: 'NO_DATA',
    });
    expect(served.body.kpis[1].status).toBe('INSUFFICIENT_BASELINE');
  } finally {
    await plantCoverage(COVERED_SINCE);
  }
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
    coverage_start: COVERED_SINCE,
    read_at: new Date(),
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
