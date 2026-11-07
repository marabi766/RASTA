import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Inject } from '@nestjs/common';
import { outboxShutdownBudgetMs } from '@rasta/config';
import { fatalShutdown, withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { sagaWorkerUp } from '../observability/metrics';
import { OrderService } from '../order/order.service';
import { EconomicClient } from '../economic/economic.client';
import { createActivities } from './activities';
import { foreignFailure } from './foreign-failure';
import { installTemporalRuntimeLogger } from './runtime-logger';

/**
 * The worker that runs `OrderSagaWorkflow`.
 *
 * Started in the service process rather than as a separate deployment: there
 * is one workflow, its activities call this service's own domain code
 * directly, and splitting them would mean serialising every state transition
 * over HTTP to reach the same database.
 *
 * ## Why it can be turned off
 *
 * `MARKETPLACE_TEMPORAL_ENABLED=false` starts the API without a worker. Orders
 * are then created and stay `PENDING`, which is a **visible** state rather
 * than a silent failure — a developer running the service without a Temporal
 * server gets an API that works and a saga that plainly is not running,
 * instead of requests that hang.
 *
 * ## Workflow bundling
 *
 * `workflowsPath` points at the source module. Temporal bundles it into an
 * isolated V8 context with no access to Node's I/O, which is what makes the
 * determinism rules in `workflows.ts` enforceable rather than merely stated:
 * a `fetch` or a `Date.now()` in there fails at runtime rather than silently
 * producing a replay that disagrees with the original run.
 *
 * ## Liveness (FU-104)
 *
 * A log line is not an alert. `rasta_marketplace_saga_worker_up` is 1 only
 * while the SDK reports the worker RUNNING **and** Temporal lists this
 * worker's own identity among the pollers of both the workflow and the
 * activity task queue; every other case — disabled, never started, `run()`
 * ended, stopping, a probe that failed or timed out — is 0. The server's list
 * is what catches a worker that says RUNNING but no longer polls: Temporal
 * drops a poller about five minutes after its last poll.
 *
 * ## A run that ends by itself ends the process (#769 r2 ruling)
 *
 * Nothing in the process would ever start the worker again, so a `run()` that
 * resolves or rejects without `stop()` asking for it requests the service's
 * fatal shutdown (non-zero exit, the way a terminal consumer crash does): the
 * restart is the retry. Until the process is gone, the gauge reads 0.
 */
/** Well inside Temporal's ~5 min poller expiry, so expiry dominates the detection time. */
export const LIVENESS_PROBE_INTERVAL_MS = 15_000;
const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

@Injectable()
export class OrderSagaWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderSagaWorker.name);
  private worker?: Worker;
  private connection?: NativeConnection;
  private running?: Promise<void>;
  private stopping?: Promise<void>;
  /** Unique per process, so the server's poller list can be matched to this worker alone. */
  private readonly identity = `marketplace-saga@${hostname()}/${process.pid}/${randomUUID()}`;
  private probeTimer?: NodeJS.Timeout;
  private probing?: Promise<boolean>;
  private ended = false;
  private stopRequested = false;

  constructor(
    @Inject(ENV) private readonly env: MarketplaceEnv,
    private readonly orders: OrderService,
    private readonly economic: EconomicClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Down until proven up: disabled, or failing to start, it stays 0.
    sagaWorkerUp.set({ service: SERVICE_NAME }, 0);
    if (!this.env.MARKETPLACE_TEMPORAL_ENABLED) {
      this.logger.warn(
        'Temporal is disabled; orders will be created but will not advance past PENDING',
      );
      return;
    }

    try {
      // Before the first connection: the SDK's runtime is built on first use,
      // with a raw stderr logger, and cannot be given another afterwards.
      installTemporalRuntimeLogger(this.env);
      this.connection = await NativeConnection.connect({ address: this.env.TEMPORAL_ADDRESS });

      this.worker = await Worker.create({
        connection: this.connection,
        namespace: this.env.TEMPORAL_NAMESPACE,
        taskQueue: this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE,
        identity: this.identity,
        workflowsPath: require.resolve('./workflows'),
        activities: createActivities({ orders: this.orders, economic: this.economic }),
        maxHeartbeatThrottleInterval: '1 second',
        defaultHeartbeatThrottleInterval: '1 second',
        // Without it the SDK waits for an activity that ignores cancellation
        // for as long as that activity lasts. The force time counts from
        // `shutdown()`, which `stop()` calls as the shared budget starts.
        shutdownForceTime: outboxShutdownBudgetMs(this.env),
      });

      // Not awaited: `run()` resolves only on shutdown, and awaiting it here
      // would block Nest's bootstrap forever.
      this.running = this.worker.run().then(
        () => this.end(),
        (error: unknown) => this.end(error),
      );
      this.logger.log('Order saga worker polling (MARKETPLACE_TEMPORAL_TASK_QUEUE)');
      if (!this.ended) {
        void this.probeLiveness();
        this.probeTimer = setInterval(() => this.everyInterval(), LIVENESS_PROBE_INTERVAL_MS);
        this.probeTimer.unref();
      }
    } catch (error) {
      // A missing Temporal server must not take the API down: existing orders
      // are still readable and the failure is loud in the log.
      this.logger.error(
        { failure: foreignFailure(error) },
        'Could not start the order saga worker',
      );
    }
  }

  /**
   * Nest's destroy phase. `OutboxShutdown` (D-052) normally gets there first
   * and stops this worker by the shared deadline; if it did not, this stops it
   * by the same budget, started now. Either way the wait is bounded.
   */
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /**
   * Sets the liveness gauge from one look and answers it. Joins a look in
   * flight; decides after the server answers, so a run that ended meanwhile
   * still reads 0.
   */
  probeLiveness(): Promise<boolean> {
    this.probing ??= this.look().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  /**
   * A look still unanswered a whole interval later (its RPC deadline is a
   * third of that) is unknown: down until it answers, never its last value.
   */
  private everyInterval(): void {
    if (this.probing) sagaWorkerUp.set({ service: SERVICE_NAME }, 0);
    void this.probeLiveness();
  }

  private async look(): Promise<boolean> {
    let listed = false;
    try {
      listed = await this.listedAsPoller();
    } catch (error) {
      this.logger.warn(
        { failure: foreignFailure(error) },
        'Could not ask Temporal whether the order saga worker polls; reported down',
      );
    }
    const up = listed && this.polling();
    sagaWorkerUp.set({ service: SERVICE_NAME }, up ? 1 : 0);
    return up;
  }

  private polling(): boolean {
    return (
      this.worker !== undefined &&
      !this.ended &&
      this.stopping === undefined &&
      this.worker.getState() === 'RUNNING'
    );
  }

  /** Both queues: a worker that takes workflow tasks but no activities moves no money either. */
  private async listedAsPoller(): Promise<boolean> {
    const connection = this.connection;
    if (!connection || !this.polling()) return false;
    const ask = (taskQueueType: 1 | 2) =>
      connection.withDeadline(Date.now() + LIVENESS_PROBE_TIMEOUT_MS, () =>
        connection.workflowService.describeTaskQueue({
          namespace: this.env.TEMPORAL_NAMESPACE,
          taskQueue: { name: this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE },
          taskQueueType,
        }),
      );
    // TASK_QUEUE_TYPE_WORKFLOW = 1, TASK_QUEUE_TYPE_ACTIVITY = 2.
    const answers = await Promise.all([ask(1), ask(2)]);
    return answers.every(
      (answer) => answer.pollers?.some((poller) => poller.identity === this.identity) === true,
    );
  }

  /**
   * The run is over, by error or not: down at once, and nothing probes any more.
   * Asked to by `stop()`, that is the shutdown; otherwise the process exits.
   */
  private end(error?: unknown): void {
    this.ended = true;
    if (this.probeTimer) clearInterval(this.probeTimer);
    sagaWorkerUp.set({ service: SERVICE_NAME }, 0);
    if (this.stopRequested) {
      // Also what the SDK raises when the force time passes first.
      if (error !== undefined) {
        this.logger.warn(
          { failure: foreignFailure(error) },
          'The order saga worker ended with an error',
        );
      }
      return;
    }
    this.logger.error(
      { failure: error === undefined ? undefined : foreignFailure(error) },
      'The order saga worker stopped by itself; exiting so that it is restarted',
    );
    fatalShutdown.request();
  }

  /**
   * Stops polling, waits for the tasks in flight — at most until `deadlineAt`,
   * the shutdown's shared deadline — and closes the connection. One stop: a
   * later call joins it.
   *
   * Past the deadline the worker is abandoned, not waited for. That is safe for
   * the saga because an activity ignores cancellation and may be cut off
   * anywhere, so each is written to be re-run (see `createActivities`): every
   * call to economic-service carries an idempotency key derived from the order,
   * and every local transition returns quietly when the order is already in the
   * target state. Temporal records no result for an attempt that never
   * completed, so the activity is retried when a worker polls again.
   *
   * `shutdownForceTime` (set in `onApplicationBootstrap`) is the SDK's own
   * bound for the same moment; this deadline is the one that holds if the SDK
   * does not return.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopRequested = true;
    this.stopping ??= this.halt(
      options.deadlineAt ?? Date.now() + outboxShutdownBudgetMs(this.env),
    );
    return this.stopping;
  }

  private async halt(deadlineAt: number): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer);
    sagaWorkerUp.set({ service: SERVICE_NAME }, 0);
    try {
      this.worker?.shutdown();
    } catch (error) {
      // Not running (it already ended); there is nothing to request.
      this.logger.warn(
        { failure: foreignFailure(error) },
        'The order saga worker could not be asked to shut down',
      );
    }

    if (this.running) {
      if ((await withinDeadline(this.running, deadlineAt - Date.now())) === 'abandoned') {
        this.logger.warn(
          'The order saga worker still had work in flight at the shutdown deadline; abandoned. ' +
            'Its activities are idempotent and are retried by the next worker',
        );
        return;
      }
    }

    if (this.connection) {
      const closing = this.connection.close().catch((error: unknown) => {
        this.logger.warn(
          { failure: foreignFailure(error) },
          'The Temporal connection did not close cleanly',
        );
      });
      await withinDeadline(closing, deadlineAt - Date.now());
    }
  }
}
