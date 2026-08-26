import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';

/**
 * Database access for organization-service.
 *
 * Unlike every other service, this one does **not** install the tenant-guard
 * extension. The reason is structural rather than an oversight:
 *
 *   Everywhere else, `organizationId` marks a row as belonging to a tenant, so
 *   scoping every query by it is exactly right. Here, an Organization row *is*
 *   a tenant. Filtering the tenant registry by the caller's own tenant would
 *   make the hierarchy unreadable — a county could never list the dehyaris
 *   beneath it, and the union could never see anything but itself.
 *
 * Access control is therefore explicit and subtree-based, enforced in
 * OrganizationService via `assertCanRead` / `assertCanWrite`. Those two methods
 * are the entire tenant boundary for this service, which is why they are short
 * and heavily commented rather than spread across the repository.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` in a transaction.
   *
   * Exposed because the outbox pattern requires the state change and the
   * outbox insert to share one transaction (ADR-021).
   */
  transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx));
  }
}

/** The client shape available inside a transaction. */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
