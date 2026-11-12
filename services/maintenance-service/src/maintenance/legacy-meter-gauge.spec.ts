import { registry } from '@rasta/observability';
import { LegacyMeterGauge } from './legacy-meter-gauge';
import type { MaintenanceRepository } from './maintenance.repository';
import { maintenanceMeterLegacyAssets } from '../observability/metrics';

function deferred() {
  let resolve!: (value: number) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('legacy meter gauge lifecycle', () => {
  it('scrapes the shared registry and removes failed reads instead of serving stale zero', async () => {
    const read = jest.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('unavailable'));
    const gauge = new LegacyMeterGauge({
      countLegacyMeterAssetsAcrossTenants: read,
    } as unknown as MaintenanceRepository);
    expect(await registry.getSingleMetricAsString('maintenance_meter_legacy_assets')).toContain(
      'maintenance_meter_legacy_assets 3',
    );
    expect(await registry.getSingleMetricAsString('maintenance_meter_legacy_assets')).not.toMatch(
      /^maintenance_meter_legacy_assets /m,
    );
    await gauge.stop();
  });
  it.each(['resolve', 'reject'] as const)(
    'abandons a late %s without a metric and starts no query after stop',
    async (settle) => {
      const d = deferred();
      const read = jest.fn(() => d.promise);
      const gauge = new LegacyMeterGauge({
        countLegacyMeterAssetsAcrossTenants: read,
      } as unknown as MaintenanceRepository);
      const sample = gauge.sample();
      const firstStop = gauge.stop();
      await gauge.stop({ deadlineAt: Date.now() - 1 });
      const set = jest.spyOn(maintenanceMeterLegacyAssets, 'set');
      expect(
        await Promise.race([
          firstStop.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 100)),
        ]),
      ).toBe(true);
      if (settle === 'resolve') d.resolve(0);
      else d.reject(new Error('late'));
      await sample;
      await firstStop;
      await gauge.sample();
      expect(read).toHaveBeenCalledTimes(1);
      expect(set).not.toHaveBeenCalled();
      expect((await maintenanceMeterLegacyAssets.get()).values).toEqual([]);
      set.mockRestore();
    },
  );
});
