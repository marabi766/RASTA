import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { SERVICE_NAME, type InventoryEnv } from '../config/env';
import { commandTransactionTimeoutMs } from '../config/operation-budgets';
import { inventoryCommandsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ExpiryBacklog, ReservationExpiry } from '../reservation/expiry';
import { ENV } from '../tokens';
import { transactionNow } from './clock';
import { boundLockWaits, translateCommandError } from './command';
import type { ClaimFence } from './idempotency';

export type CommandName =
  | 'create_warehouse'
  | 'receive'
  | 'adjust'
  | 'reserve'
  | 'release'
  | 'issue'
  | 'create_shipment'
  | 'dispatch_shipment'
  | 'deliver_shipment';

/**
 * The one shape of a command's transaction (ADR-056 § 3):
 *
 *   hold the Idempotency-Key claim → bound every lock wait → read the transaction's instant →
 *   the work (lock, expire due, write balance, movement, reservation — or the warehouse — and
 *   outbox) → store the response on the claim
 *
 * — all in one transaction, so the change, its ledger, the event and the replayable answer
 * commit together or not at all. What the database refused is translated once, here
 * (`translateCommandError`): a pool with no connection to give, or a transaction past its
 * budget, is the same retryable 409 for every command, after its claim was taken as before.
 * Every outcome is counted. A command refused for an expiry backlog (`ExpiryBacklog`) leaves one
 * committed batch of it expired behind.
 */
@Injectable()
export class CommandRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expiry: ReservationExpiry,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  async run<T>(
    command: CommandName,
    fence: ClaimFence<T>,
    /** What a balance CHECK becomes; `null` for a command that writes no balance. */
    overdrawn: (() => RastaError) | null,
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
        { timeoutMs: commandTransactionTimeoutMs(lockTimeoutMs), maxWaitMs: lockTimeoutMs },
      );
      this.count(command, 'applied');
      return result;
    } catch (error) {
      // The rollback took the command's own expiry batch with it: commit one now, so the retry
      // the 409 asks for finds the backlog smaller even if no sweep runs in between.
      if (error instanceof ExpiryBacklog) {
        await this.expiry.workOff(error, getContext().correlationId);
      }
      const answered = translateCommandError(error, overdrawn);
      if (answered instanceof RastaError) {
        this.count(command, answered.code === 'CONFLICT' ? 'contended' : 'refused');
      }
      throw answered;
    }
  }

  private count(command: CommandName, outcome: 'applied' | 'refused' | 'contended'): void {
    inventoryCommandsTotal.inc({ service: SERVICE_NAME, command, outcome });
  }
}
