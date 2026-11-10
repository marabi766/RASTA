import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import {
  type EventConsumer,
  type HandlerOutcome,
  runUnscoped,
  WorkerAbandonedError,
} from '@rasta/nest-common';
import { StatementSettlementConsumer } from '../src/consumers/statement-settlement.consumer';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import type { ExtendedPrismaClient, PrismaService } from '../src/prisma/prisma.service';
import { transactionsCreatedTotal } from '../src/observability/metrics';
import { cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

// Real transactions: hold the callback before COMMIT or the response after COMMIT.
// The registered handler and direct entry both inherit the same database boundary.
describe.each(['statement', 'maintenance'] as const)('%s obligation abandonment', (family) => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();
  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    wiring = wire(prisma);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.stop();
  });

  it.each(['direct', 'framework'] as const)('%s entry gates both late outcomes', async (entry) => {
    for (const phase of ['precommit', 'committed', 'rejected'] as const) {
      const sources = new FakeSourceFacts();
      const reference = `SRC_${ulid()}`;
      const instant = new Date().toISOString();
      const payload =
        family === 'statement'
          ? {
              statementId: reference,
              contractId: `CTR_${ulid()}`,
              statementNumber: 1,
              organizationId: org.a,
              contractorOrganizationId: org.b,
              approvedAt: instant,
            }
          : {
              requestId: reference,
              assetId: `AST_${ulid()}`,
              organizationId: org.a,
              workshopOrganizationId: org.b,
              approvedBy: 'USR-APPROVER',
              approvedAt: instant,
              totalCostMinor: '450000',
              currency: 'IRR',
            };
      if (family === 'statement')
        sources.statements.set(reference, {
          statementId: reference,
          contractId: String(payload.contractId),
          status: 'APPROVED',
          netMinor: '450000',
          currency: 'IRR',
          payerOrganizationId: org.a,
          beneficiaryOrganizationId: org.b,
          approvedAt: instant,
        });
      else sources.approved(payload as Parameters<FakeSourceFacts['approved']>[0]);
      const event = {
        eventId: ulid(),
        eventName: family === 'statement' ? 'STATEMENT_APPROVED' : 'MAINTENANCE_APPROVED',
        eventVersion: 1,
        occurredAt: instant,
        producer: family === 'statement' ? 'contract-service' : 'maintenance-service',
        producerVersion: '0.1.0',
        aggregateType: family === 'statement' ? 'Contract' : 'MaintenanceRequest',
        aggregateId: reference,
        tenantId: org.a,
        correlationId: ulid(),
        payload,
      } as EventEnvelope;
      let framework!: (envelope: EventEnvelope) => Promise<HandlerOutcome>;
      const build = (handler: typeof framework): EventConsumer => {
        framework = handler;
        return { stop: async () => undefined } as unknown as EventConsumer;
      };
      const make = () =>
        family === 'statement'
          ? new StatementSettlementConsumer(build, prisma, wiring.transactions, sources, null)
          : new SettlementAuthorityConsumer(build, prisma, wiring.transactions, sources);
      const consumer = make();
      const deliver = () => (entry === 'direct' ? consumer.handle(event) : framework(event));
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = async <T>(result: T): Promise<T> => {
        entered();
        await held;
        if (phase === 'rejected') throw new Error('late response lost');
        return result;
      };
      const original = prisma.transaction.bind(prisma);
      jest
        .spyOn(prisma, 'transaction')
        .mockImplementationOnce(
          async <T>(work: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> =>
            phase === 'precommit'
              ? original(async (tx) => wait(await work(tx)))
              : wait(await original(work)),
        );
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const counter = jest.spyOn(transactionsCreatedTotal, 'inc');
      const outcome = deliver();
      const refused = expect(outcome).rejects.toBeInstanceOf(WorkerAbandonedError);
      await started;
      await consumer.stop({ deadlineAt: Date.now() - 1 });
      await consumer.onApplicationShutdown();
      release();
      await refused;
      expect(log).not.toHaveBeenCalled();
      expect(counter).not.toHaveBeenCalled();
      expect(warns).toHaveBeenCalledWith(expect.stringMatching(/ABANDONED.*UNCONFIRMED/));
      await expect(consumer.handle(event)).rejects.toBeInstanceOf(WorkerAbandonedError);
      jest.restoreAllMocks();
      const committed = phase !== 'precommit';
      await runUnscoped('inspect this source before recovery', async () => {
        expect(
          await prisma.client.transaction.count({ where: { sourceReference: reference } }),
        ).toBe(committed ? 1 : 0);
      });
      const recovered = jest.spyOn(transactionsCreatedTotal, 'inc');
      const recoveredLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      // The new instance reconciles durable markers, including a committed-but-lost response.
      await make().handle(event);
      await make().handle({ ...event, eventId: ulid() });
      expect(recovered).toHaveBeenCalledTimes(committed ? 0 : 1);
      expect(recoveredLog).toHaveBeenCalledTimes(committed ? 0 : 1);
      await runUnscoped(
        'verify this isolated source across tenants and its transactional event',
        async () => {
          const rows = await prisma.client.transaction.findMany({
            where: { sourceReference: reference },
          });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            organizationId: org.a,
            counterpartyOrganizationId: org.b,
          });
          expect(
            await prisma.client.outboxMessage.count({ where: { aggregateId: rows[0]!.id } }),
          ).toBe(1);
          expect(
            await prisma.client.processedEvent.count({ where: { eventId: event.eventId } }),
          ).toBe(1);
        },
      );
      jest.restoreAllMocks();
    }
  });
});
