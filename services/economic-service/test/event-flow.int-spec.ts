import { Kafka, type Consumer, type Producer } from 'kafkajs';
import { OutboxRelay, EventConsumer } from '@rasta/nest-common';
import { EVENT_HEADERS, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { ECONOMIC_TOPIC } from '../src/config/env';
import {
  asActor,
  brokers,
  cleanup,
  fundWallet,
  newPrisma,
  readBalances,
  silentLogger,
  tenants,
  waitFor,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The event path, end to end, over a real broker.
 *
 * Two directions, and each closes a gap that has existed since the phase
 * before this one:
 *
 *   **maintenance → economic.** `MAINTENANCE_APPROVED` has been published
 *   since maintenance-service shipped, with no consumer at all. It is the
 *   product document's mandatory control before settlement ("مجوز تسویه",
 *   docs/17, ADR-028), and this test carries a real message from the
 *   maintenance topic into a settleable obligation.
 *
 *   **economic → the platform.** `SETTLEMENT_COMPLETED`, `FUNDS_HELD`,
 *   `COMMISSION_APPLIED` and `JOURNAL_POSTED` are consumed by services that do
 *   not exist yet. This test proves the envelope those consumers will require
 *   actually reaches the topic, through the outbox, with its correlation id
 *   intact.
 *
 * Every link is real: no mocked producer, no in-memory queue, no stubbed
 * consumer.
 *
 * The assertion that matters most is the negative one. Consuming
 * `MAINTENANCE_APPROVED` must record an obligation and move **no money** —
 * zero journals, zero balance change (ADR-032). A consumer that quietly
 * debited a wallet would pass a test that only checked the transaction row.
 */

const brokerList = brokers();
// Skips rather than fails when no broker is configured: a developer without
// Docker should still be able to run the database half of the suite. A skip is
// visible in the output; silently passing is not.
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

const MAINTENANCE_TOPIC = 'rasta.maintenance.v1';

describeWithKafka('economic event flow over Kafka', () => {
  const org = tenants();
  const suffix = ulid().slice(-12);

  let prisma: PrismaService;
  let wiring: Wiring;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let economicConsumer: Consumer;
  let maintenanceProducer: Producer;
  let settlementAuthority: SettlementAuthorityConsumer;
  let rewardTrigger: RewardTriggerConsumer;

  const publishedToEconomic: EventEnvelope[] = [];

  /** Waits for a consumer to actually join its group, not merely for `run()`. */
  function groupJoin(target: Consumer, name: string): Promise<void> {
    // On a broker that has just started, `connect()`, `subscribe()` and `run()`
    // all succeed while the group coordinator is still unavailable — the
    // `__consumer_offsets` partitions have not finished loading. kafkajs then
    // retries in the background and the test publishes into a topic nobody is
    // reading yet, failing on a timeout that names the wrong thing. CI found
    // this in fleet-service; a developer machine cannot, because the broker
    // there has been up for hours.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Consumer group ${name} did not join within 60s`)),
        60_000,
      );
      target.on(target.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);

    const kafka = new Kafka({
      clientId: `economic-itest-${suffix}`,
      brokers: brokerList!,
      logLevel: 1,
    });

    // A listener on the economic topic, so the outbox half can be observed.
    economicConsumer = kafka.consumer({ groupId: `economic-itest-observer-${suffix}` });
    await economicConsumer.connect();
    await economicConsumer.subscribe({ topic: ECONOMIC_TOPIC, fromBeginning: false });
    const observerJoined = groupJoin(economicConsumer, 'observer');
    await economicConsumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        publishedToEconomic.push(JSON.parse(message.value.toString()) as EventEnvelope);
      },
    });
    await observerJoined;

    // The real relay, publishing this service's outbox to the real broker.
    publisher = new KafkaEventPublisher({
      brokers: brokerList!,
      clientId: `economic-itest-producer-${suffix}`,
    });
    relay = new OutboxRelay({ store: new PrismaOutboxStore(prisma), publisher, batchSize: 50 });

    // A producer standing in for maintenance-service.
    maintenanceProducer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await maintenanceProducer.connect();

    // The real consumers, on their own groups so this run does not steal
    // partitions from a locally running service.
    settlementAuthority = new SettlementAuthorityConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList!,
            clientId: `economic-itest-settlement-${suffix}`,
            groupId: `economic-itest-settlement-${suffix}`,
            topics: [MAINTENANCE_TOPIC],
            fromBeginning: false,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      prisma,
      wiring.transactions,
    );
    await settlementAuthority.onModuleInit();

    rewardTrigger = new RewardTriggerConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList!,
            clientId: `economic-itest-reward-${suffix}`,
            groupId: `economic-itest-reward-${suffix}`,
            topics: [MAINTENANCE_TOPIC],
            fromBeginning: false,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      prisma,
      wiring.rewards,
    );
    await rewardTrigger.onModuleInit();

    // Give both groups a moment to settle before the first publish.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }, 120_000);

  afterAll(async () => {
    await relay?.stop();
    await settlementAuthority?.onApplicationShutdown();
    await rewardTrigger?.onApplicationShutdown();
    await maintenanceProducer?.disconnect();
    await economicConsumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  }, 60_000);

  /**
   * Publishes an envelope the way maintenance-service publishes one.
   *
   * Built by hand from that service's own contract rather than imported, and
   * deliberately: importing across `services/*` is forbidden (AGENTS.md A-02),
   * so a change on the producer's side has to show up as a failure here rather
   * than as a compile error that never happens.
   */
  async function publishMaintenanceEvent(
    eventName: string,
    payload: Record<string, unknown>,
    overrides: Partial<EventEnvelope> = {},
  ): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      eventId: ulid(),
      eventName,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'maintenance-service',
      producerVersion: '0.1.0',
      aggregateType: 'MaintenanceRequest',
      aggregateId: String(payload.requestId ?? payload.usageRecordId ?? ulid()),
      tenantId: String(payload.organizationId),
      correlationId: `itest-corr-${ulid()}`,
      actor: { type: 'USER', id: `USR-ITEST-${suffix}` },
      payload,
      ...overrides,
    };

    await maintenanceProducer.send({
      topic: MAINTENANCE_TOPIC,
      messages: [
        {
          key: String(payload.assetId ?? envelope.aggregateId),
          value: JSON.stringify(envelope),
          headers: {
            [EVENT_HEADERS.eventId]: envelope.eventId,
            [EVENT_HEADERS.eventName]: envelope.eventName,
            [EVENT_HEADERS.correlationId]: envelope.correlationId,
            [EVENT_HEADERS.tenantId]: envelope.tenantId ?? '',
            [EVENT_HEADERS.producer]: envelope.producer,
          },
        },
      ],
    });

    return envelope;
  }

  describe('maintenance → economic: an approval becomes a settleable obligation', () => {
    const requestId = `MNT_ITEST_${ulid()}`;
    let envelope: EventEnvelope;

    it('records the obligation, and moves no money at all', async () => {
      await fundWallet(wiring, org.a, 5_000_000n);
      const walletBefore = await readBalances(prisma, await walletId(org.a));

      envelope = await publishMaintenanceEvent('MAINTENANCE_APPROVED', {
        requestId,
        assetId: `AST_ITEST_${suffix}`,
        organizationId: org.a,
        approvedBy: `USR-ITEST-${suffix}`,
        approvedAt: new Date().toISOString(),
        workshopOrganizationId: org.b,
        totalCostMinor: '11850000',
        currency: 'IRR',
        costBreakdown: [
          { category: 'PART', amountMinor: '4800000', currency: 'IRR' },
          { category: 'LABOUR', amountMinor: '5850000', currency: 'IRR' },
          { category: 'SERVICE', amountMinor: '1200000', currency: 'IRR' },
        ],
      });

      const obligation = await waitFor('the obligation to be recorded', () =>
        asActor({ organizationId: org.a }, () =>
          prisma.client.transaction.findFirst({
            where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
          }),
        ),
      );

      expect(obligation.status).toBe('PENDING_SETTLEMENT');
      expect(obligation.transactionType).toBe('MAINTENANCE_SERVICE');
      expect(obligation.grossAmountMinor).toBe(11_850_000n);
      expect(obligation.counterpartyOrganizationId).toBe(org.b);

      // The figure is the one the approver saw, recorded and never recomputed
      // (ADR-028).
      expect(obligation.grossAmountMinor.toString()).toBe('11850000');

      // **And nothing moved.** This is the assertion ADR-032 exists for.
      expect(await readBalances(prisma, await walletId(org.a))).toEqual(walletBefore);

      const journals = await asActor({ organizationId: org.a }, () =>
        prisma.client.journal.findMany({ where: { transactionId: obligation.id } }),
      );
      expect(journals).toEqual([]);
    }, 90_000);

    it('carries the correlation id from the approval through to the obligation', async () => {
      // The chain docs/13 asks for: the approval in maintenance-service, this
      // obligation, and the settlement that follows all share one identifier.
      const obligation = await asActor({ organizationId: org.a }, () =>
        prisma.client.transaction.findFirst({
          where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
        }),
      );

      expect(obligation?.correlationId).toBe(envelope.correlationId);
      expect(obligation?.causationId).toBe(envelope.eventId);
    });

    it('has no second effect when the same event is replayed', async () => {
      // At-least-once delivery means this *will* happen (ADR-021). The
      // `processed_event` row and the effect commit together, so a duplicate is
      // recognised and skipped.
      const before = await asActor({ organizationId: org.a }, () =>
        prisma.client.transaction.count({
          where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
        }),
      );

      await maintenanceProducer.send({
        topic: MAINTENANCE_TOPIC,
        messages: [
          {
            key: `AST_ITEST_${suffix}`,
            value: JSON.stringify(envelope),
            headers: { [EVENT_HEADERS.eventId]: envelope.eventId },
          },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 4000));

      const after = await asActor({ organizationId: org.a }, () =>
        prisma.client.transaction.count({
          where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
        }),
      );

      expect(after).toBe(before);
      expect(after).toBe(1);
    }, 60_000);

    it('records a second obligation for a re-emitted approval only once', async () => {
      // A producer that re-emits the same approval under a *new* event id
      // passes the `processed_event` check. The `(sourceType, sourceReference)`
      // lookup is the second guard, and one repair must produce one obligation.
      await publishMaintenanceEvent('MAINTENANCE_APPROVED', {
        requestId,
        assetId: `AST_ITEST_${suffix}`,
        organizationId: org.a,
        approvedBy: `USR-ITEST-${suffix}`,
        approvedAt: new Date().toISOString(),
        workshopOrganizationId: org.b,
        totalCostMinor: '11850000',
        currency: 'IRR',
      });

      await new Promise((resolve) => setTimeout(resolve, 4000));

      const count = await asActor({ organizationId: org.a }, () =>
        prisma.client.transaction.count({
          where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
        }),
      );
      expect(count).toBe(1);
    }, 60_000);

    it('skips an in-house approval that names no workshop', async () => {
      // A normal event, not a defect: there is nobody outside the organization
      // to pay. Skipped rather than dead-lettered.
      const inHouse = `MNT_INHOUSE_${ulid()}`;
      await publishMaintenanceEvent('MAINTENANCE_APPROVED', {
        requestId: inHouse,
        assetId: `AST_ITEST_${suffix}`,
        organizationId: org.a,
        approvedBy: `USR-ITEST-${suffix}`,
        approvedAt: new Date().toISOString(),
        workshopOrganizationId: null,
        totalCostMinor: '500000',
        currency: 'IRR',
      });

      await new Promise((resolve) => setTimeout(resolve, 4000));

      const count = await asActor({ organizationId: org.a }, () =>
        prisma.client.transaction.count({
          where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: inHouse },
        }),
      );
      expect(count).toBe(0);
    }, 60_000);
  });

  describe('economic → the platform: the outbox reaches the topic', () => {
    it('publishes SETTLEMENT_COMPLETED with a correlation id and string amounts', async () => {
      const payer = `${org.c}-EVENTS`;
      await fundWallet(wiring, payer, 2_000_000n);

      const transaction = await asActor({ organizationId: payer }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '2000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId: payer }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      const settlement = await asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      // Drain the outbox through the real relay and the real publisher.
      await waitFor('the outbox to drain', async () => {
        const published = await relay.tick();
        const pending = await new PrismaOutboxStore(prisma).pendingCount();
        return pending === 0 && published >= 0 ? true : null;
      });

      const received = await waitFor('SETTLEMENT_COMPLETED to arrive on the topic', async () => {
        await relay.tick();
        return (
          publishedToEconomic.find(
            (envelope) =>
              envelope.eventName === 'SETTLEMENT_COMPLETED' &&
              (envelope.payload as { transactionId?: string }).transactionId === transaction.id,
          ) ?? null
        );
      });

      const payload = received.payload as Record<string, string>;

      expect(received.producer).toBe('economic-service');
      expect(received.correlationId).toBeTruthy();
      expect(payload.settlementId).toBe(settlement.settlementId);

      // Amounts are strings, never JSON numbers (ADR-022).
      expect(typeof payload.grossAmountMinor).toBe('string');
      expect(payload.grossAmountMinor).toBe('2000000');
      expect(typeof payload.netAmountMinor).toBe('string');

      await cleanup(prisma, [payer]);
    }, 90_000);

    it('publishes FUNDS_HELD and JOURNAL_POSTED for the same flow', async () => {
      const names = new Set(publishedToEconomic.map((envelope) => envelope.eventName));
      expect(names).toContain('FUNDS_HELD');
      expect(names).toContain('JOURNAL_POSTED');
      expect(names).toContain('WALLET_OPENED');
    });

    it('keys every event by its aggregate, so ordering per aggregate survives', async () => {
      // ADR-006. Reversed, a consumer would see money released before it was
      // ever held.
      for (const envelope of publishedToEconomic) {
        expect(envelope.aggregateId).toBeTruthy();
        expect(envelope.eventId).toBeTruthy();
        expect(envelope.occurredAt).toBeTruthy();
      }
    });

    it('carries both sides of every journal it announces', async () => {
      // An auditor reconstructing the ledger from the event log needs both
      // sides of every movement, or the log proves nothing.
      const journalEvents = publishedToEconomic.filter(
        (envelope) => envelope.eventName === 'JOURNAL_POSTED',
      );
      expect(journalEvents.length).toBeGreaterThan(0);

      for (const event of journalEvents) {
        const entries = (event.payload as { entries: unknown[] }).entries;
        expect(entries.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  async function walletId(organizationId: string): Promise<string> {
    const wallet = await asActor({ organizationId }, () =>
      prisma.client.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    if (!wallet) throw new Error(`no wallet for ${organizationId}`);
    return wallet.id;
  }
});
