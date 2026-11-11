import { Injectable } from '@nestjs/common';
import {
  WorkerBoundary,
  WorkerDrain,
  workerOperation,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import {
  outboxLeasesActive,
  outboxPendingAgeSeconds,
  outboxPendingTotal,
} from '@rasta/observability';
import { SERVICE_NAME } from '../config/env';
import { PrismaOutboxStore } from '../outbox/outbox.store';
import { IdempotencyStore } from '../shared/idempotency';
import { TransactionRepository } from '../transaction/transaction.repository';
import { WalletService } from '../wallet/wallet.service';
import { transactionsDisputed, transactionsPendingSettlement } from './metrics';

const SAMPLE_INTERVAL_MS = 15_000;

/** Operational counts and upkeep share the database coordinator's worker deadline. */
@Injectable()
export class EconomicGaugeSampler {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly worker = new WorkerBoundary(() => undefined);
  private readonly drain = new WorkerDrain(
    this.worker,
    { stop: (options) => this.wallets.stopSampling(options) },
    () => undefined,
  );

  constructor(
    private readonly store: PrismaOutboxStore,
    private readonly transactions: TransactionRepository,
    private readonly wallets: WalletService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.drain.stop(options);
  }

  /** Scheduled and direct calls are tracked, including concurrent samples. */
  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.worker.run(async () => {
      try {
        await this.publish(outboxPendingTotal, () => this.store.pendingCount());
        await this.publish(outboxLeasesActive, () => this.store.activeLeaseCount());
        await this.publish(outboxPendingAgeSeconds, () => this.store.oldestPendingAgeSeconds());
        // Operational counts span tenants; none is a sum of money or tenant-visible.
        await this.publish(transactionsPendingSettlement, () =>
          this.transactions.countByStatus('PENDING_SETTLEMENT'),
        );
        await this.publish(transactionsDisputed, () => this.transactions.countByStatus('DISPUTED'));
        await workerOperation(() => this.wallets.sampleGauges());
        await workerOperation(() => this.idempotency.purgeExpired());
      } catch {
        // Metrics/upkeep must never take the service down, including abandoned outcomes.
      }
    });
  }

  private async publish(
    gauge: { set(labels: { service: string }, value: number): void },
    read: () => PromiseLike<number>,
  ): Promise<void> {
    const count = await workerOperation(read);
    this.worker.assertActive();
    gauge.set({ service: SERVICE_NAME }, count);
  }
}
