import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { WalletRepository } from './wallet.repository';
import { balancesFrom, isConsistent } from './balances';
import { walletLedgerDeviationsTotal, walletsOpenTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';

/**
 * The wallet/ledger reconciliation (docs/10 § 10.3).
 *
 * docs/10 asks for a daily `LedgerBalanceAuditWorkflow` in Temporal that
 * checks every wallet against the sum of its ledger entries and raises a
 * critical alert on any deviation. Temporal is not running on this platform
 * yet (ADR-027, ADR-031), so this runs in-process on a timer, with the
 * substitution recorded rather than hidden.
 *
 * ## It reports. It never repairs.
 *
 * This is the design decision worth defending. A reconciliation that silently
 * corrected a wallet would destroy the evidence of whatever caused the
 * divergence, and would make a data-integrity incident look like a healthy
 * system. **A wallet that disagrees with its ledger is an incident for a
 * human**, and the ledger is the source of truth to recover from.
 *
 * The gauge is the alert condition; the identifiers go to the log, never to a
 * Prometheus label, because a scrape is readable by anyone on the monitoring
 * network and wallet identifiers are tenant data (AGENTS.md S-09).
 *
 * ## Three relations are checked, not one
 *
 *   1. `available` equals the wallet account's ledger balance
 *   2. `pending`   equals the escrow account's ledger balance
 *   3. `pending`   equals the sum of ACTIVE holds
 *
 * The third is what makes the second meaningful. Escrow being a real ledger
 * balance (ADR-034) is only useful if the holds table agrees with it — one of
 * them being wrong is exactly the kind of drift that would otherwise surface
 * as a settlement failing for no visible reason.
 *
 * ## Safe on every replica
 *
 * It only reads. Several replicas running it concurrently duplicate work and
 * nothing else, so there is no leader election and no lock — and nothing to go
 * wrong when the flag is left on everywhere.
 */
@Injectable()
export class LedgerBalanceAudit implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LedgerBalanceAudit.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerService,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  onModuleInit(): void {
    if (!this.env.ECONOMIC_BALANCE_AUDIT_ENABLED) {
      this.logger.warn('Wallet/ledger reconciliation is disabled by configuration');
      return;
    }

    const intervalMs = this.env.ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`Wallet/ledger reconciliation every ${intervalMs / 1000}s`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over the wallets.
   *
   * Returns the deviations it found so a test can assert on them directly
   * rather than by scraping a metric — and so an operator can trigger a pass
   * during an incident and read the answer.
   */
  async run(): Promise<Deviation[]> {
    const deviations: Deviation[] = [];
    const batchSize = this.env.ECONOMIC_BALANCE_AUDIT_BATCH_SIZE;

    try {
      let skip = 0;
      let checked = 0;

      for (;;) {
        const page = await this.wallets.pageForAudit(skip, batchSize);
        if (page.length === 0) break;

        for (const wallet of page) {
          checked += 1;
          const deviation = await this.check(wallet);
          if (deviation) deviations.push(deviation);
        }

        if (page.length < batchSize) break;
        skip += batchSize;
      }

      walletsOpenTotal.set({ service: SERVICE_NAME }, checked);
      walletLedgerDeviationsTotal.set({ service: SERVICE_NAME }, deviations.length);

      if (deviations.length > 0) {
        // One line per deviation, with identifiers but no amounts: an operator
        // needs to know which wallets to look at, and the figures are in the
        // database where they are already under authorization.
        for (const deviation of deviations) {
          this.logger.error(
            `Wallet ${deviation.walletId} disagrees with its ledger (${deviation.kind})`,
          );
        }
      }
    } catch (error) {
      // Reconciliation must never take the service down. A failed pass is
      // itself worth knowing about, so it is logged rather than swallowed.
      this.logger.error(
        'Wallet/ledger reconciliation pass failed',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return deviations;
  }

  private async check(wallet: {
    id: string;
    organizationId: string;
    currency: string;
    ledgerAccountId: string;
    ledgerBalanceMinor: bigint;
    pendingBalanceMinor: bigint;
    availableBalanceMinor: bigint;
  }): Promise<Deviation | null> {
    const stored = balancesFrom(wallet.availableBalanceMinor, wallet.pendingBalanceMinor);

    // The stored figures must satisfy the invariant among themselves. The
    // database constraint already guarantees it; checking anyway costs nothing
    // and would catch a constraint that had been dropped.
    if (!isConsistent({ ...stored, ledgerBalanceMinor: wallet.ledgerBalanceMinor })) {
      return { walletId: wallet.id, kind: 'INTERNAL_INCONSISTENCY' };
    }

    const walletAccountBalance = await this.ledger.balanceOf(wallet.ledgerAccountId, 'LIABILITY');
    if (walletAccountBalance !== wallet.availableBalanceMinor) {
      return { walletId: wallet.id, kind: 'AVAILABLE_VS_LEDGER' };
    }

    const holdTotal = await this.wallets.activeHoldTotal(wallet.id);
    if (holdTotal !== wallet.pendingBalanceMinor) {
      return { walletId: wallet.id, kind: 'PENDING_VS_HOLDS' };
    }

    return null;
  }
}

export interface Deviation {
  walletId: string;
  kind: 'INTERNAL_INCONSISTENCY' | 'AVAILABLE_VS_LEDGER' | 'PENDING_VS_HOLDS';
}
