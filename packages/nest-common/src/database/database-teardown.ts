import type { Logger } from '@nestjs/common';
import { withinDeadline, type OutboxStopOptions } from '../outbox/outbox';
import { closePrismaAdmission } from './safe-prisma-client';

export interface DatabaseCloseReport {
  drained: boolean;
}

/** One close per pool; a timed-out disconnect may still finish or fail later. */
export class DatabaseTeardown {
  private stopping?: Promise<DatabaseCloseReport>;

  constructor(
    private readonly client: { $disconnect(): PromiseLike<void> },
    private readonly logger: Pick<Logger, 'error'>,
  ) {}

  stop(options: OutboxStopOptions = {}): Promise<DatabaseCloseReport> {
    if (!this.stopping) {
      closePrismaAdmission(this.client);
      this.stopping = this.close(options.deadlineAt);
    }
    return this.stopping;
  }

  private async close(deadlineAt: number | undefined): Promise<DatabaseCloseReport> {
    const disconnected = Promise.resolve()
      .then(() => this.client.$disconnect())
      .then(
        () => true,
        () => {
          this.logger.error('Database disconnect failed; close UNCONFIRMED');
          return false;
        },
      );
    if (
      deadlineAt !== undefined &&
      (await withinDeadline(
        disconnected,
        Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 0,
      )) === 'abandoned'
    ) {
      this.logger.error('Database close ABANDONED at shutdown deadline; close UNCONFIRMED');
      return { drained: false };
    }
    return { drained: await disconnected };
  }
}
