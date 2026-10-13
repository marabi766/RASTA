import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { SERVICE_NAME, type InventoryEnv } from '../config/env';
import { inventoryCommandsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import { transactionNow } from './clock';
import { boundLockWaits, translateCommandError } from './command';
import type { ClaimFence } from './idempotency';

export type StockCommandName = 'receive' | 'adjust' | 'reserve' | 'release' | 'issue';

/**
 * The one shape of a stock command's transaction (ADR-056 § 3):
 *
 *   hold the Idempotency-Key claim → bound every lock wait → read the transaction's instant →
 *   the work (lock, expire due, write balance, movement, reservation, outbox) → store the
 *   response on the claim
 *
 * — all in one transaction, so the balance, its ledger, the event and the replayable answer
 * commit together or not at all. What the database refused is translated once, here
 * (`translateCommandError`), and every outcome is counted.
 */
@Injectable()
export class CommandRunner {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  async run<T>(
    command: StockCommandName,
    fence: ClaimFence<T>,
    overdrawn: () => RastaError,
    work: (tx: ExtendedPrismaClient, at: Date) => Promise<T>,
  ): Promise<T> {
    const lockTimeoutMs = this.env.INVENTORY_LOCK_TIMEOUT_MS;
    try {
      const result = await this.prisma.transaction(
        async (tx) => {
          await fence.hold(tx);
          await boundLockWaits(tx, lockTimeoutMs);
          const at = await transactionNow(tx);
          return fence.complete(tx, await work(tx, at));
        },
        // A command may wait on several items in turn, each bounded by lock_timeout; the whole
        // transaction is bounded too, and so is its wait for a pooled connection.
        { timeoutMs: lockTimeoutMs * 4 + 10_000, maxWaitMs: lockTimeoutMs },
      );
      this.count(command, 'applied');
      return result;
    } catch (error) {
      const answered = translateCommandError(error, overdrawn);
      if (answered instanceof RastaError) {
        this.count(command, answered.code === 'CONFLICT' ? 'contended' : 'refused');
      }
      throw answered;
    }
  }

  private count(command: StockCommandName, outcome: 'applied' | 'refused' | 'contended'): void {
    inventoryCommandsTotal.inc({ service: SERVICE_NAME, command, outcome });
  }
}
