import { withUtcSession } from '@rasta/config';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { ContractRepository } from '../src/contract/contract.repository';
import { TenderAwardedConsumer } from '../src/events/tender-awarded.consumer';
import type { AwardSource } from '../src/award/award-source.client';
import type { AwardFact } from '../src/award/award-confirm';
import { loadContractEnv, type ContractEnv } from '../src/config/env';

/**
 * Scaffolding for the integration suites.
 *
 * Everything asserted under `test/` is a property only PostgreSQL has: the unique
 * index that decides a race between two deliveries, the CHECK constraints and the
 * origin-immutability trigger, the tenant guard against real rows, and the
 * transactional coupling of a draft with its outbox row. None of it is visible to
 * a unit test, so the helpers are thin and touch the real database.
 *
 * Needs `DATABASE_URL_CONTRACT` (the runtime role of `rasta_contract`) with this
 * service's migration applied (`pnpm --filter @rasta/contract-service db:migrate`).
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_CONTRACT;
  if (!url) {
    throw new Error(
      'DATABASE_URL_CONTRACT is not set. These tests run against a real PostgreSQL; start it ' +
        "with `pnpm infra:up` and apply this service's migration first.",
    );
  }
  return withUtcSession(url);
}

/**
 * The owner connection the suites' cleanup alone may use to lift a trigger
 * (`DATABASE_URL_CONTRACT_MIGRATOR`, `rasta_contract_migrator`). **Required, with no
 * fallback** to the runtime URL: since D-045 the runtime role owns nothing and cannot
 * lift a trigger, and a suite that fell back would fail for a reason that hides the real
 * one — a missing variable.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_CONTRACT_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_CONTRACT_MIGRATOR is not set. The suites lift an integrity trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export function testEnv(overrides: Record<string, string> = {}): ContractEnv {
  return loadContractEnv({
    ...process.env,
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // Never used by these suites: they call the consumer and the service with an
    // explicit context. Throwaway values the schema demands.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI:
      process.env.OIDC_JWKS_URI ??
      'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE ?? 'rasta-api',
    INTERNAL_TOKEN_SECRET:
      process.env.INTERNAL_TOKEN_SECRET ?? 'integration_suite_unused_secret_32_chars',
    ...overrides,
  });
}

export const newOrganizationId = (): string => `ORG_${ulid()}`;

/** What construction-service answers for an award, unless a test says otherwise. */
export interface AwardFixture {
  readonly tenderId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly winningBidId: string;
  readonly winnerOrganizationId: string;
  readonly amountMinor: string;
  readonly matrixDigest: string;
  readonly awardedBy: string;
  readonly awardedAt: string;
}

export function newAward(
  organizationId: string,
  overrides: Partial<AwardFixture> = {},
): AwardFixture {
  return {
    tenderId: `TND_${ulid()}`,
    organizationId,
    projectId: `PRJ_${ulid()}`,
    winningBidId: `BID_${ulid()}`,
    winnerOrganizationId: newOrganizationId(),
    amountMinor: '4500000000',
    matrixDigest: 'a'.repeat(64),
    awardedBy: `USR_${ulid()}`,
    awardedAt: '2026-10-03T09:30:00.000Z',
    ...overrides,
  };
}

/** The `TENDER_AWARDED` envelope as construction-service publishes it: no amount. */
export function tenderAwarded(
  award: AwardFixture,
  overrides: { tenantId?: string | undefined; eventId?: string } = {},
): EventEnvelope {
  const tenantId = 'tenantId' in overrides ? overrides.tenantId : award.organizationId;
  return eventEnvelopeSchema.parse({
    eventId: overrides.eventId ?? ulid(),
    eventName: 'TENDER_AWARDED',
    occurredAt: new Date().toISOString(),
    producer: 'construction-service',
    aggregateType: 'Tender',
    aggregateId: award.tenderId,
    ...(tenantId === undefined ? {} : { tenantId }),
    correlationId: ulid(),
    payload: {
      tenderId: award.tenderId,
      projectId: award.projectId,
      organizationId: award.organizationId,
      winningBidId: award.winningBidId,
      winnerOrganizationId: award.winnerOrganizationId,
      matrixDigest: award.matrixDigest,
      awardedBy: award.awardedBy,
      awardedAt: award.awardedAt,
    },
  }) as EventEnvelope;
}

/**
 * construction-service as the consumer sees it: awards by (organization, tender), a
 * count of the questions asked, and a switch for an owner that cannot be asked. The
 * real HTTP client is proven against its contract in `award-source.client.int-spec.ts`.
 */
export class FakeAwards implements AwardSource {
  readonly asked: { organizationId: string; tenderId: string }[] = [];
  private readonly facts = new Map<string, AwardFact>();
  /** When set, every question fails with this error, as an owner that is down would. */
  failWith: Error | undefined;

  serve(award: AwardFixture, overrides: Partial<AwardFact> = {}): void {
    this.facts.set(`${award.organizationId}|${award.tenderId}`, {
      tenderId: award.tenderId,
      status: 'AWARDED',
      bidId: award.winningBidId,
      bidderOrganizationId: award.winnerOrganizationId,
      amountMinor: award.amountMinor,
      matrixDigest: award.matrixDigest,
      awardedAt: award.awardedAt,
      awardedBy: award.awardedBy,
      ...overrides,
    });
  }

  async award(organizationId: string, tenderId: string): Promise<AwardFact | null> {
    this.asked.push({ organizationId, tenderId });
    if (this.failWith) throw this.failWith;
    return this.facts.get(`${organizationId}|${tenderId}`) ?? null;
  }
}

export interface Wiring {
  prisma: PrismaService;
  env: ContractEnv;
  contracts: ContractRepository;
  awards: FakeAwards;
  /** The consumer's handler, without a broker: `consumer.handle(envelope)`. */
  consumer: TenderAwardedConsumer;
  close(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

export function wire(env: ContractEnv = testEnv()): Wiring {
  const prisma = new PrismaService(databaseUrl());
  const contracts = new ContractRepository(prisma);
  const awards = new FakeAwards();
  const consumer = new TenderAwardedConsumer(
    () => {
      throw new Error('these suites drive handle(); nothing subscribes');
    },
    prisma,
    contracts,
    new EventPublisher(env),
    awards,
    silent,
  );
  return {
    prisma,
    env,
    contracts,
    awards,
    consumer,
    close: () => prisma.onModuleDestroy(),
  };
}

/**
 * Removes everything the given organizations wrote. A contract is never deleted by the
 * service (`tg_contract_guard`), so the suite's own removal goes through the **owner**
 * connection and lifts the trigger for the length of one transaction — never through the
 * runtime `PrismaService` under test, or the suites would teach the code to do it.
 */
export async function cleanup(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "contract" DISABLE TRIGGER "tg_contract_guard"');
      await tx.contract.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await tx.$executeRawUnsafe('ALTER TABLE "contract" ENABLE TRIGGER "tg_contract_guard"');
    });
    await owner.outboxMessage.deleteMany({ where: { organizationId: { in: organizationIds } } });
  } finally {
    await owner.$disconnect();
  }
}
