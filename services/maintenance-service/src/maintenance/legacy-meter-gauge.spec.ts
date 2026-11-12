import { registry } from '@rasta/observability';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LegacyMeterGauge } from './legacy-meter-gauge';
import type { MaintenanceRepository } from './maintenance.repository';
import { maintenanceMeterLegacyAssets, usageReadingsAppliedTotal } from '../observability/metrics';
import { MetricsController } from '../health/health.controller';

function deferred() {
  let resolve!: (value: number) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const metric = () => registry.getSingleMetricAsString('maintenance_meter_legacy_assets');
const makeGauge = (read: () => Promise<number>) =>
  new LegacyMeterGauge({
    countLegacyMeterAssetsAcrossTenants: read,
  } as unknown as MaintenanceRepository);

describe('legacy meter gauge lifecycle', () => {
  let gauge: LegacyMeterGauge;
  afterEach(async () => {
    await gauge?.stop({ deadlineAt: Date.now() - 1 });
    jest.useRealTimers();
  });

  it('returns /metrics including other metrics within 100ms while the DB read stalls', async () => {
    const d = deferred();
    gauge = makeGauge(() => d.promise);
    const sampling = gauge.sample();
    const module = await Test.createTestingModule({ controllers: [MetricsController] }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.init();
    usageReadingsAppliedTotal.inc({ service: 'maintenance-service' });
    try {
      const response = await request(app.getHttpServer()).get('/metrics').timeout(100).expect(200);
      expect(response.text).toMatch(/^rasta_maintenance_usage_readings_applied_total\{/m);
      expect(response.text).not.toMatch(/^maintenance_meter_legacy_assets /m);
    } finally {
      d.resolve(3);
      await sampling;
      await app.close();
    }
  });

  it('overlapping full-registry scrapes never start additional DB reads', async () => {
    const d = deferred();
    const read = jest.fn(() => d.promise);
    gauge = makeGauge(read);
    const sampling = gauge.sample();
    const scrapes = [registry.metrics(), registry.metrics(), registry.metrics()];
    await Promise.resolve();
    try {
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      d.resolve(3);
      await sampling;
      await Promise.all(scrapes);
    }
  });

  it('samples at startup and periodically, retaining one slot across ticks until settlement', async () => {
    jest.useFakeTimers();
    const d = deferred();
    const read = jest
      .fn()
      .mockImplementationOnce(() => d.promise)
      .mockResolvedValue(7);
    gauge = makeGauge(read);
    gauge.onModuleInit();
    gauge.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    d.resolve(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await metric()).toMatch(/^maintenance_meter_legacy_assets 7$/m);
    await gauge.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('publishes last good count and increasing age; rejected reads remove both series', async () => {
    jest.useFakeTimers();
    const read = jest.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('unavailable'));
    gauge = makeGauge(read);
    await gauge.sample();
    await jest.advanceTimersByTimeAsync(2000);
    expect(await metric()).toMatch(/^maintenance_meter_legacy_assets 3$/m);
    expect(
      await registry.getSingleMetricAsString('maintenance_meter_legacy_assets_sample_age_seconds'),
    ).toMatch(/^maintenance_meter_legacy_assets_sample_age_seconds 2$/m);
    await gauge.sample();
    expect(await metric()).not.toMatch(/^maintenance_meter_legacy_assets /m);
    expect(
      await registry.getSingleMetricAsString('maintenance_meter_legacy_assets_sample_age_seconds'),
    ).not.toMatch(/^maintenance_meter_legacy_assets_sample_age_seconds /m);
  });

  it.each(['resolve', 'reject'] as const)(
    'invalidates timed-out %s and never lets an old completion overwrite a new sample',
    async (settle) => {
      jest.useFakeTimers();
      const d = deferred();
      const read = jest
        .fn()
        .mockResolvedValueOnce(3)
        .mockImplementationOnce(() => d.promise)
        .mockResolvedValue(7);
      gauge = makeGauge(read);
      await gauge.sample();
      const old = gauge.sample();
      await jest.advanceTimersByTimeAsync(5000);
      expect(await metric()).not.toMatch(/^maintenance_meter_legacy_assets /m);
      await gauge.sample(); // A timed-out but unsettled read still occupies the single slot.
      expect(read).toHaveBeenCalledTimes(2);
      if (settle === 'resolve') d.resolve(0);
      else d.reject(new Error('late'));
      await old;
      expect(await metric()).not.toMatch(/^maintenance_meter_legacy_assets /m);
      await gauge.sample();
      expect(await metric()).toMatch(/^maintenance_meter_legacy_assets 7$/m);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'stops a pending %s by a tightened deadline, with no late publication or restart',
    async (settle) => {
      jest.useFakeTimers();
      const d = deferred();
      const read = jest.fn(() => d.promise);
      gauge = makeGauge(read);
      const sampling = gauge.sample();
      const firstStop = gauge.stop({ deadlineAt: Date.now() + 20_000 });
      await gauge.stop({ deadlineAt: Date.now() - 1 });
      await firstStop;
      if (settle === 'resolve') d.resolve(0);
      else d.reject(new Error('late'));
      await sampling;
      await gauge.sample();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect((await maintenanceMeterLegacyAssets.get()).values).toEqual([]);
    },
  );
});
