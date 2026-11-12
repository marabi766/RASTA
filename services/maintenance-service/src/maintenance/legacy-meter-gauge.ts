import { type OnModuleInit } from '@nestjs/common';
import { type OutboxStopOptions } from '@rasta/nest-common';
import {
  bindLegacyMeterCollector,
  maintenanceMeterLegacyAssets,
  maintenanceMeterLegacySampleAge,
} from '../observability/metrics';
import type { MaintenanceRepository } from './maintenance.repository';

const SAMPLE_INTERVAL_MS = 30_000;
const SAMPLE_DEADLINE_MS = 5_000;

/** Background-only single flight; the collector reads a cached, monotonic-age snapshot. */
export class LegacyMeterGauge implements OnModuleInit {
  private stopped = false;
  private stopping?: Promise<void>;
  private deadlineAt?: number;
  private rearm?: () => void;
  private inFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readTimeout?: NodeJS.Timeout;
  private invalidate?: () => void;
  private snapshot?: { count: number; at: number };
  constructor(private readonly repository: MaintenanceRepository) {
    this.clear();
    bindLegacyMeterCollector(
      () =>
        this.snapshot && {
          count: this.snapshot.count,
          ageSeconds: (performance.now() - this.snapshot.at) / 1000,
        },
    );
  }
  onModuleInit(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
    void this.sample();
  }
  async sample(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    let valid = true;
    this.invalidate = () => {
      valid = false;
      this.clear();
    };
    const deadline = performance.now() + SAMPLE_DEADLINE_MS;
    const timeout = (this.readTimeout = setTimeout(this.invalidate, SAMPLE_DEADLINE_MS));
    timeout.unref?.();
    // Retain the slot even after timeout until the underlying read settles.
    const pass = this.repository.countLegacyMeterAssetsAcrossTenants().then(
      (count) => {
        if (valid && !this.stopped && performance.now() < deadline) {
          this.snapshot = { count, at: performance.now() };
        } else if (valid && !this.stopped) this.clear();
      },
      () => {
        if (valid && !this.stopped) this.clear();
      },
    );
    this.inFlight = pass;
    try {
      await pass;
    } finally {
      clearTimeout(timeout);
      this.invalidate = undefined;
      this.inFlight = undefined;
    }
  }
  private clear(): void {
    this.snapshot = undefined;
    maintenanceMeterLegacyAssets.remove();
    maintenanceMeterLegacySampleAge.remove();
  }
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.readTimeout);
    this.invalidate?.();
    this.clear();
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
      Promise.allSettled(this.inFlight ? [this.inFlight] : []).then(finish);
      this.rearm();
    });
    return this.stopping;
  }
}
