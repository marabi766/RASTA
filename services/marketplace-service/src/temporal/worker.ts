import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Inject } from '@nestjs/common';
import { outboxShutdownBudgetMs } from '@rasta/config';
import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { MarketplaceEnv } from '../config/env';
import { OrderService } from '../order/order.service';
import { EconomicClient } from '../economic/economic.client';
import { createActivities } from './activities';
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
 */
@Injectable()
export class OrderSagaWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderSagaWorker.name);
  private worker?: Worker;
  private connection?: NativeConnection;
  private running?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    @Inject(ENV) private readonly env: MarketplaceEnv,
    private readonly orders: OrderService,
    private readonly economic: EconomicClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
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
        workflowsPath: require.resolve('./workflows'),
        activities: createActivities({ orders: this.orders, economic: this.economic }),
        // Without it the SDK waits for an activity that ignores cancellation
        // for as long as that activity lasts. The force time counts from
        // `shutdown()`, which `stop()` calls as the shared budget starts.
        shutdownForceTime: outboxShutdownBudgetMs(this.env),
      });

      // Not awaited: `run()` resolves only on shutdown, and awaiting it here
      // would block Nest's bootstrap forever.
      this.running = this.worker.run().catch((error: unknown) => {
        // Also what the SDK raises when the force time passes first.
        this.logger.warn({ err: error }, 'The order saga worker ended with an error');
      });
      this.logger.log(`Order saga worker polling ${this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE}`);
    } catch (error) {
      // A missing Temporal server must not take the API down: existing orders
      // are still readable and the failure is loud in the log.
      this.logger.error({ err: error }, 'Could not start the order saga worker');
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
    this.stopping ??= this.halt(
      options.deadlineAt ?? Date.now() + outboxShutdownBudgetMs(this.env),
    );
    return this.stopping;
  }

  private async halt(deadlineAt: number): Promise<void> {
    try {
      this.worker?.shutdown();
    } catch (error) {
      // Not running (it already ended); there is nothing to request.
      this.logger.warn({ err: error }, 'The order saga worker could not be asked to shut down');
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
        this.logger.warn({ err: error }, 'The Temporal connection did not close cleanly');
      });
      await withinDeadline(closing, deadlineAt - Date.now());
    }
  }
}
