import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Inject } from '@nestjs/common';
import { ENV } from '../tokens';
import type { MarketplaceEnv } from '../config/env';
import { OrderService } from '../order/order.service';
import { EconomicClient } from '../economic/economic.client';
import { createActivities } from './activities';

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
      this.connection = await NativeConnection.connect({ address: this.env.TEMPORAL_ADDRESS });

      this.worker = await Worker.create({
        connection: this.connection,
        namespace: this.env.TEMPORAL_NAMESPACE,
        taskQueue: this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE,
        workflowsPath: require.resolve('./workflows'),
        activities: createActivities({ orders: this.orders, economic: this.economic }),
      });

      // Not awaited: `run()` resolves only on shutdown, and awaiting it here
      // would block Nest's bootstrap forever.
      this.running = this.worker.run();
      this.logger.log(`Order saga worker polling ${this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE}`);
    } catch (error) {
      // A missing Temporal server must not take the API down: existing orders
      // are still readable and the failure is loud in the log.
      this.logger.error({ err: error }, 'Could not start the order saga worker');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.worker?.shutdown();
    await this.running?.catch(() => undefined);
    await this.connection?.close();
  }
}
