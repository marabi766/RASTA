import { type OutboxStopOptions } from '@rasta/nest-common';
import { bindLegacyMeterCollector, maintenanceMeterLegacyAssets } from '../observability/metrics';
import type { MaintenanceRepository } from './maintenance.repository';

/** Scrape-time read, owned by the shutdown coordinator; unknown is an absent series. */
export class LegacyMeterGauge {
  private stopped = false;
  private stopping?: Promise<void>;
  private deadlineAt?: number;
  private rearm?: () => void;
  private readonly inFlight = new Set<Promise<void>>();
  constructor(private readonly repository: MaintenanceRepository) {
    maintenanceMeterLegacyAssets.remove();
    bindLegacyMeterCollector(() => this.sample());
  }
  async sample(): Promise<void> {
    if (this.stopped) return;
    const pass = this.read();
    this.inFlight.add(pass);
    try {
      await pass;
    } finally {
      this.inFlight.delete(pass);
    }
  }
  private async read(): Promise<void> {
    try {
      const count = await this.repository.countLegacyMeterAssetsAcrossTenants();
      if (!this.stopped) maintenanceMeterLegacyAssets.set(count);
    } catch {
      if (!this.stopped) maintenanceMeterLegacyAssets.remove();
    }
  }
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopped = true;
    maintenanceMeterLegacyAssets.remove();
    if (
      options.deadlineAt !== undefined &&
      (this.deadlineAt === undefined || options.deadlineAt < this.deadlineAt)
    ) {
      this.deadlineAt = options.deadlineAt;
      this.rearm?.();
    }
    this.stopping ??= new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        this.rearm = undefined;
        resolve();
      };
      this.rearm = () => {
        clearTimeout(timer);
        if (this.deadlineAt === undefined) return;
        const remaining = this.deadlineAt - Date.now();
        if (remaining <= 0) finish();
        else {
          timer = setTimeout(finish, remaining);
          timer.unref?.();
        }
      };
      Promise.allSettled([...this.inFlight]).then(finish);
      this.rearm();
    });
    return this.stopping;
  }
}
