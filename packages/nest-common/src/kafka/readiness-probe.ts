import type { Admin } from 'kafkajs';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, outboxShutdownBudgetMs } from '@rasta/config';
import { boundedDisconnect } from './bounded-disconnect';
import type { KafkaConnectionOptions } from './connection';

/**
 * A publisher's readiness probe of the broker, held to a bound and to the
 * shutdown (D-052 phase 4b, Codex r1 on #293, F2).
 *
 * The probe is a short-lived admin client: connect, list the topics, close.
 * kafkajs bounds none of the three by anything shorter than its retries and
 * its `requestTimeout`, and each publisher awaited them inside `/health/ready`.
 * The HTTP server's close waits for the requests it is still answering, so a
 * probe in flight while the broker had stopped answering held `app.close()`
 * past SHUTDOWN_TIMEOUT_MS — as an unbounded producer close did before
 * `boundedDisconnect`.
 *
 * So a probe answers within `timeoutMs`, well under the shutdown budget
 * (`kafkaProbeTimeoutMs`): one that has not finished by then answers "not
 * healthy". Its client is closed when it answers, on every path — one that
 * failed half-way has still opened a socket — and the answer does not wait for
 * that close, which `boundedDisconnect` abandons if the broker holds it. And
 * once the shutdown has begun (`close()`, from the publisher's
 * `onModuleDestroy`, the first hook of `app.close()`), no probe starts, and one
 * in flight answers "not healthy" at once rather than at its bound, so the HTTP
 * server has no probe to wait for. Kafka is a degradation in every readiness
 * answer, never the verdict, so "not healthy" here only marks it degraded.
 *
 * Utility only (ADR-018).
 */

/** What this needs of a kafkajs client: an admin client per probe. */
export interface AdminFactory {
  admin(): Pick<Admin, 'connect' | 'listTopics' | 'disconnect'>;
}

/** Where the probe's notes go: debug only, a broker outage is not news per probe. */
export interface ProbeLogger {
  debug(message: string): void;
}

export interface KafkaReadinessProbeOptions {
  /** How long one probe may take to answer (`kafkaProbeTimeoutMs`). */
  timeoutMs: number;
  logger: ProbeLogger;
  /** Test seam. Default: `Date.now`. */
  now?: () => number;
}

/** The longest a probe may take, whatever the budget: a probe is a quick question. */
export const KAFKA_PROBE_MAX_TIMEOUT_MS = 2_000;

/**
 * A probe's bound for this connection: a quarter of the shutdown budget, and no
 * more than {@link KAFKA_PROBE_MAX_TIMEOUT_MS}. With the default
 * SHUTDOWN_TIMEOUT_MS that is 2 s of a 23 s budget.
 */
export function kafkaProbeTimeoutMs(
  connection: Pick<KafkaConnectionOptions, 'shutdownBudgetMs'>,
): number {
  const budgetMs =
    connection.shutdownBudgetMs ??
    outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS: DEFAULT_SHUTDOWN_TIMEOUT_MS });
  return Math.max(1, Math.min(KAFKA_PROBE_MAX_TIMEOUT_MS, Math.floor(budgetMs / 4)));
}

export class KafkaReadinessProbe {
  private closed = false;
  /** The answer of every probe in flight, so `close()` can give it now. */
  private readonly inFlight = new Set<(healthy: boolean) => void>();
  private readonly now: () => number;

  constructor(
    private readonly kafka: AdminFactory,
    private readonly options: KafkaReadinessProbeOptions,
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error(
        `KafkaReadinessProbe: timeoutMs must be a positive integer, received ${options.timeoutMs}`,
      );
    }
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether the broker answers: `true` only when an admin client connected and
   * listed the topics within the bound. Never rejects; after `close()`,
   * `false` without opening anything.
   */
  check(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let admin: ReturnType<AdminFactory['admin']> | undefined;
      let settled = false;
      const answer = (healthy: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(answer);
        resolve(healthy);
        // Closed now, on every path, and not awaited: a close the broker holds
        // must not hold the readiness response, nor the HTTP server's close
        // behind it. Abandoned, quietly, if it has not finished one bound later.
        if (admin) {
          void boundedDisconnect(admin, {
            deadlineAt: this.now() + this.options.timeoutMs,
            label: 'Kafka readiness probe',
            logger: { warn: (message) => this.options.logger.debug(message) },
            now: this.now,
          });
        }
      };
      const timer = setTimeout(() => {
        this.options.logger.debug(
          `Kafka readiness probe: no answer within ${this.options.timeoutMs} ms`,
        );
        answer(false);
      }, this.options.timeoutMs);
      this.inFlight.add(answer);

      try {
        admin = this.kafka.admin();
      } catch {
        answer(false);
        return;
      }
      const client = admin;
      // `then(...)` so a synchronous throw is a failed probe, not an exception here.
      Promise.resolve()
        .then(async () => {
          // Answered already (`close()` in the same tick): its close has begun,
          // and a connect after it would open what nothing closes.
          if (settled) return;
          await client.connect();
          if (settled) return;
          await client.listTopics();
        })
        .then(
          () => answer(true),
          () => answer(false),
        );
    });
  }

  /**
   * The shutdown has begun: no probe starts after this, and every probe still
   * in flight answers "not healthy" now. Idempotent.
   */
  close(): void {
    this.closed = true;
    for (const answer of [...this.inFlight]) answer(false);
  }
}
