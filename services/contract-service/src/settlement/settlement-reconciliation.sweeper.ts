import { Logger } from '@nestjs/common';
import {
  RastaError,
  createSystemContext,
  runWithContext,
  withinDeadline,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { sourceVerificationsTotal, statementSettlementsTotal } from '../observability/metrics';
import { confirmSettlement } from './obligation-confirm';
import type { ObligationSource } from './obligation-source.client';
import { SettlementRepository, type SettlementCandidate } from './settlement.repository';
import { StatementSettler } from './statement-settler';

export interface SettlementReconciliationOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
}

export interface SettlementReconciliationOutcome {
  /** APPROVED statements asked about in this pass. */
  asked: number;
  /** Settled here: economic-service had settled them and no event had reached this service. */
  settled: number;
  /** Settled meanwhile by the `SETTLEMENT_COMPLETED` consumer, or an earlier pass. */
  already: number;
  /** economic-service holds no settlement of them yet: nothing to do. */
  unpaid: number;
  /** economic-service's answer does not match the statement: nothing written, logged. */
  refused: number;
  /** economic-service could not be asked: nothing written; the next pass asks again. */
  unavailable: number;
}

/**
 * Settles the APPROVED statements economic-service has settled but whose `SETTLEMENT_COMPLETED`
 * never reached this service (review of #343 round 1, F1): published before the consumer group
 * existed and since past the topic's retention, or lost to an operator's offset reset. The consumer
 * reads from the oldest retained message on its first start; this covers what is older.
 *
 * Every `intervalMs`, one page of `batchSize` APPROVED statements of every organization, by id, the
 * page after the last one — wrapping to the first once a page comes back short — so every APPROVED
 * statement is asked about within (count / batchSize) passes, and the cost of a pass is bounded
 * whatever the number of statements. For each, in its own tenant's context:
 *
 *   - economic-service is asked for the statement's obligation exactly as the consumer asks it
 *     (`ObligationSource`, a service token signed for the employer, A-13). Unanswerable: nothing
 *     written, counted, asked again next time round.
 *   - Not SETTLED and fully settled, or no settlement named: unpaid — nothing to do.
 *   - Settled: held against the statement's own row by `confirmSettlement`, the consumer's own check,
 *     with the settlement economic names. Any difference: nothing written, logged and counted as a
 *     refusal — the same verdict the consumer would dead-letter.
 *   - Confirmed: settled through `StatementSettler`, the consumer's one write, recorded as
 *     `reconciliation:<pass>` — there is no event to name — and the contract with it when due. A
 *     consumer delivery that got there first leaves it `already`.
 *
 * Never on anything but economic's own answer: a statement is never settled by elapsed time, by a
 * count, or by the absence of an event.
 */
export class SettlementReconciliationSweeper {
  private readonly logger = new Logger(SettlementReconciliationSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopping?: Promise<void>;
  private stopped = false;
  private cursor: string | null = null;

  constructor(
    private readonly settler: StatementSettler,
    private readonly settlements: SettlementRepository,
    private readonly obligations: ObligationSource,
    private readonly options: SettlementReconciliationOptions,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      // Never overlaps with itself: a slow pass is followed by the next tick, not run beside it.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          this.logger.error(
            `Settlement reconciliation pass failed: ${error instanceof RastaError ? error.code : 'INTERNAL'}`,
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  /** An `OutboxShutdown` worker: stopped by the shutdown's one deadline (D-052). */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopping ??= this.halt(options.deadlineAt);
    return this.stopping;
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const current = this.inFlight;
    if (!current) return;
    if (deadlineAt === undefined) {
      await current;
      return;
    }
    if ((await withinDeadline(current, deadlineAt - Date.now())) === 'abandoned') {
      this.logger.warn(
        'Settlement reconciliation still running at the shutdown deadline; abandoned. A statement ' +
          'in flight rolls back and is asked about again on the next start',
      );
    }
  }

  /** One pass. Public so a test can drive it without the timer. */
  async runOnce(): Promise<SettlementReconciliationOutcome> {
    const pass = ulid();
    const page = await this.settlements.findApprovedPage(this.cursor, this.options.batchSize);
    this.cursor = page.length < this.options.batchSize ? null : (page.at(-1)?.id ?? null);

    const outcome: SettlementReconciliationOutcome = {
      asked: 0,
      settled: 0,
      already: 0,
      unpaid: 0,
      refused: 0,
      unavailable: 0,
    };
    for (const candidate of page) {
      if (this.stopped) break;
      outcome.asked += 1;
      const result = await runWithContext(
        createSystemContext({
          correlationId: pass,
          organizationId: candidate.organizationId,
          callerService: SERVICE_NAME,
        }),
        () => this.reconcile(candidate, pass),
      );
      outcome[result] += 1;
      if (result === 'settled' || result === 'refused' || result === 'unavailable') {
        statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: `reconcile_${result}` });
      }
    }
    if (outcome.settled > 0 || outcome.refused > 0) {
      this.logger.log(
        `Settlement reconciliation ${pass}: asked ${outcome.asked}, settled ${outcome.settled}, ` +
          `refused ${outcome.refused}, unavailable ${outcome.unavailable}`,
      );
    }
    return outcome;
  }

  private async reconcile(
    candidate: SettlementCandidate,
    pass: string,
  ): Promise<Exclude<keyof SettlementReconciliationOutcome, 'asked'>> {
    let fact;
    try {
      fact = await this.obligations.obligation(candidate.organizationId, candidate.id);
    } catch (error) {
      if (error instanceof RastaError) return 'unavailable';
      throw error;
    }
    if (fact === null || fact.status !== 'SETTLED' || !fact.fullySettled) return 'unpaid';
    if (fact.settlementId === null) return 'unpaid';

    const claim = { transactionId: fact.obligationId, settlementId: fact.settlementId };
    const verdict = confirmSettlement(
      {
        id: candidate.id,
        organizationId: candidate.organizationId,
        contractorOrganizationId: candidate.contract.contractorOrganizationId,
        netMinor: candidate.netMinor,
      },
      claim,
      fact,
    );
    if (!verdict.confirmed) {
      sourceVerificationsTotal.inc({
        service: SERVICE_NAME,
        consumer: 'settlement_reconciliation',
        outcome: verdict.mismatch,
      });
      this.logger.error(
        `Statement ${candidate.id}: economic-service's settlement does not confirm it ` +
          `(${verdict.mismatch}); nothing written`,
      );
      return 'refused';
    }
    const result = await this.settler.settle(candidate, claim, verdict.settlement, {
      reference: `reconciliation:${pass}`,
    });
    return result.outcome === 'already' ? 'already' : 'settled';
  }
}
