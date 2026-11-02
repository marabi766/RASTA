import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { expectNotDisclosed, instant, thisRun } from '@rasta/testing';
import { RfqEvidenceUnmappableError, genesisReceipt } from '../src/audit/rfq-evidence';
import { RfqEvidenceRepository } from '../src/audit/rfq-evidence.repository';
import { RfqGapMonitor } from '../src/audit/rfq-gap-monitor';
import { registry } from '@rasta/observability';
import { RfqEvidenceConsumer } from '../src/consumers/rfq-evidence.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { auditIngestionFailuresTotal } from '../src/observability/metrics';
import { cleanupRun, id, newMigratorPrisma, newPrisma } from './helpers';
import {
  auditor,
  internalToken,
  organizationAdmin,
  startApi,
  systemAdmin,
  type ApiHarness,
} from './api-helpers';

/**
 * The RFQ-evidence projection (ADR-070 § 4, ADR-066 § 2-3, COM-007 PR 7): the receipt
 * chain procurement-service opens quotations against, held where it cannot rewrite it —
 * against PostgreSQL, through the consumer, and the one internal read over HTTP.
 *
 * The suite mirrors `tender-evidence.int-spec.ts` case by case (the mapping is in the PR's
 * STATUS). `QUOTATION_*` events are not produced yet (plan PR 8): the events here are built
 * with the shape ADR-070 § 9 fixes, which `src/audit/rfq-evidence.spec.ts` pins.
 */

const DELIVERY = { topic: 'rasta.procurement.v1', partition: 0, offset: '0' } as EventDelivery;
const hash = (): string => createHash('sha256').update(randomBytes(16)).digest('hex');

describe('the RFQ-evidence projection', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let api: ApiHarness;
  let consumer: RfqEvidenceConsumer;

  const BUYER = id('ORG-BUYER');
  const SUPPLIER = id('ORG-SUPPLIER');

  const failures = (reason: string): Promise<number> =>
    auditIngestionFailuresTotal
      .get()
      .then((metric) => metric.values.find((v) => v.labels.reason === reason)?.value ?? 0);

  const envelope = (
    eventName: string,
    rfqId: string,
    payload: object,
    overrides: object = {},
  ): EventEnvelope =>
    eventEnvelopeSchema.parse({
      eventId: id('EVT'),
      eventName,
      occurredAt: new Date().toISOString(),
      producer: 'procurement-service',
      aggregateType: 'Rfq',
      aggregateId: rfqId,
      tenantId: BUYER,
      correlationId: ulid(),
      payload,
      ...overrides,
    }) as EventEnvelope;

  const receipt = (
    eventName: 'QUOTATION_SUBMITTED' | 'QUOTATION_REVISED',
    rfqId: string,
    previousReceipt: string,
    overrides: object = {},
    envelopeOverrides: object = {},
  ) => {
    const next = hash();
    return {
      event: envelope(
        eventName,
        rfqId,
        {
          quotationId: id('QUO'),
          rfqId,
          organizationId: BUYER,
          supplierOrganizationId: SUPPLIER,
          revision: 1,
          receivedAt: new Date().toISOString(),
          contentCommitment: hash(),
          ciphertextSha256: hash(),
          previousReceipt,
          receipt: next,
          submittedBy: 'USR_1',
          ...overrides,
        },
        envelopeOverrides,
      ),
      receipt: next,
    };
  };

  const heldFor = async (rfqId: string): Promise<number> => {
    const [{ count }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM rfq_receipt_pending WHERE rfq_id = $1`,
      rfqId,
    );
    return Number(count);
  };

  /** The chain as procurement-service reads it: a token signed for the buyer. */
  const chainOf = async (rfqId: string, organizationId: string = BUYER) => {
    const response = await request(api.app.getHttpServer())
      .get(`/v1/internal/rfq-evidence/${rfqId}/chain`)
      .set(
        'x-internal-token',
        await internalToken('procurement-service', 'SERVICE', organizationId),
      );
    expect(response.status).toBe(200);
    return response.body as {
      genesis: string;
      head: string;
      links: { seq: number; receipt: string; previousReceipt: string }[];
    };
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();
    api = await startApi();
    consumer = new RfqEvidenceConsumer(
      () => {
        throw new Error('the suite calls handle() and never subscribes');
      },
      new RfqEvidenceRepository(prisma),
      {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as never,
    );
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  describe('the receipt chain', () => {
    it('holds an RFQ’s links in order and answers the head, from the genesis', async () => {
      const rfqId = id('RFQ');
      const genesis = genesisReceipt(rfqId);
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesis);
      const second = receipt('QUOTATION_SUBMITTED', rfqId, first.receipt);
      const third = receipt('QUOTATION_REVISED', rfqId, second.receipt, { revision: 2 });

      for (const link of [first, second, third]) await consumer.handle(link.event, DELIVERY);

      const chain = await chainOf(rfqId);
      expect(chain.genesis).toBe(genesis);
      expect(chain.head).toBe(third.receipt);
      expect(chain.links.map((l) => [l.seq, l.receipt, l.previousReceipt])).toEqual([
        [1, first.receipt, genesis],
        [2, second.receipt, first.receipt],
        [3, third.receipt, second.receipt],
      ]);
    });

    it('answers an empty chain whose head is the genesis for an RFQ nothing was announced for', async () => {
      const rfqId = id('RFQ');
      const chain = await chainOf(rfqId);
      expect(chain.links).toEqual([]);
      expect(chain.head).toBe(chain.genesis);
      expect(chain.genesis).toBe(genesisReceipt(rfqId));
    });

    it('is idempotent: the same event twice is one link', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));

      await consumer.handle(first.event, DELIVERY);
      await consumer.handle(first.event, DELIVERY);

      expect((await chainOf(rfqId)).links).toHaveLength(1);
    });

    it('holds a link whose predecessor has not arrived — it is not dead-lettered, not in the chain, not lost', async () => {
      const rfqId = id('RFQ');
      const stray = receipt('QUOTATION_SUBMITTED', rfqId, hash());

      await expect(consumer.handle(stray.event, DELIVERY)).resolves.toBeUndefined();

      const chain = await chainOf(rfqId);
      expect(chain.links).toEqual([]);
      expect(chain.head).toBe(chain.genesis);
      expect(await heldFor(rfqId)).toBe(1);
      // A redelivery of the held event is a duplicate, not a second held row.
      await consumer.handle(stray.event, DELIVERY);
      expect(await heldFor(rfqId)).toBe(1);
    });

    it('places a successor delivered first as soon as its predecessor arrives, in the same step', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      const second = receipt('QUOTATION_SUBMITTED', rfqId, first.receipt);

      // The real out-of-order delivery: the later receipt reaches the consumer first.
      await consumer.handle(second.event, DELIVERY);
      expect((await chainOf(rfqId)).links).toEqual([]);
      await consumer.handle(first.event, DELIVERY);

      const chain = await chainOf(rfqId);
      expect(chain.head).toBe(second.receipt);
      expect(chain.links.map((l) => [l.seq, l.receipt])).toEqual([
        [1, first.receipt],
        [2, second.receipt],
      ]);
      expect(await heldFor(rfqId)).toBe(0);
    });

    it('drains a whole run held behind one missing link, in order, whatever order they came in', async () => {
      const rfqId = id('RFQ');
      const links = [receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId))];
      for (let i = 1; i < 5; i += 1) {
        links.push(receipt('QUOTATION_REVISED', rfqId, links[i - 1]!.receipt, { revision: i }));
      }

      // Newest first, the first link last.
      for (const link of [links[3]!, links[1]!, links[4]!, links[2]!]) {
        await consumer.handle(link.event, DELIVERY);
      }
      expect((await chainOf(rfqId)).links).toEqual([]);
      expect(await heldFor(rfqId)).toBe(4);

      await consumer.handle(links[0]!.event, DELIVERY);

      const chain = await chainOf(rfqId);
      expect(chain.links.map((l) => l.receipt)).toEqual(links.map((l) => l.receipt));
      expect(chain.links.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(chain.head).toBe(links[4]!.receipt);
      expect(await heldFor(rfqId)).toBe(0);
    });

    it('counts a gap that stays open past the configured time, once, and clears when it closes', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      const second = receipt('QUOTATION_SUBMITTED', rfqId, first.receipt);
      const repository = new RfqEvidenceRepository(prisma);
      const monitor = new RfqGapMonitor(repository, {
        AUDIT_RFQ_GAP_ALERT_SECONDS: 60,
      } as never);
      const gauge = async (name: string): Promise<number> =>
        (await registry.getSingleMetric(name)!.get()).values[0]?.value ?? 0;

      await consumer.handle(second.event, DELIVERY);
      const before = await failures('rfq_chain_gap_overdue');
      await monitor.sample();
      // Held, but not for long enough yet: no alert.
      expect(await failures('rfq_chain_gap_overdue')).toBe(before);
      expect(await gauge('rasta_audit_rfq_pending_links')).toBeGreaterThanOrEqual(1);

      // The owner role may backdate it; the runtime role cannot (no UPDATE grant).
      await migrator.client.$executeRawUnsafe(
        `UPDATE rfq_receipt_pending SET held_at = now() - interval '10 minutes' WHERE rfq_id = $1`,
        rfqId,
      );
      await monitor.sample();
      await monitor.sample();
      expect(await failures('rfq_chain_gap_overdue')).toBe(before + 1);
      expect(await gauge('rasta_audit_rfq_pending_oldest_age_seconds')).toBeGreaterThanOrEqual(600);

      // The counter announced the gap once; the overdue gauge stays up on every sample.
      expect(await gauge('rasta_audit_rfq_overdue_links')).toBeGreaterThanOrEqual(1);

      await consumer.handle(first.event, DELIVERY);
      await monitor.sample();
      expect(await heldFor(rfqId)).toBe(0);
      expect(await failures('rfq_chain_gap_overdue')).toBe(before + 1);
    });

    it('counts overdue gaps over every held row, not a bounded sample', async () => {
      const repository = new RfqEvidenceRepository(prisma);
      const baseline = await repository.pendingSummary(60);
      const rfqId = id('RFQ');
      await consumer.handle(receipt('QUOTATION_SUBMITTED', rfqId, hash()).event, DELIVERY);
      await migrator.client.$executeRawUnsafe(
        `INSERT INTO rfq_receipt_pending (source_event_id, rfq_id, organization_id,
           supplier_organization_id, quotation_id, revision, received_at, ciphertext_sha256,
           content_commitment, previous_receipt, receipt, held_at)
         SELECT 'EVT_BULK_' || g || '_' || $1, $1, $2, $3, 'QUO_BULK', 1, now(), $4, $4,
                md5(g::text || $1) || md5($1 || g::text), md5(g::text || $1 || 'r') || md5($1 || 'r' || g::text),
                now() - interval '1 hour'
           FROM generate_series(1, 1100) g`,
        rfqId,
        BUYER,
        SUPPLIER,
        hash(),
      );

      const summary = await repository.pendingSummary(60);

      expect(summary.overdueCount - baseline.overdueCount).toBe(1100);
      expect(summary.held - baseline.held).toBe(1101);
      expect(summary.oldestAgeSeconds).toBeGreaterThanOrEqual(3600);
      expect(summary.newlyOverdue.length).toBeLessThanOrEqual(1000);
    });

    it('refuses two held successors of one missing predecessor: a fork, even while it is unseen', async () => {
      const rfqId = id('RFQ');
      const missing = hash();
      await consumer.handle(receipt('QUOTATION_SUBMITTED', rfqId, missing).event, DELIVERY);

      await expect(
        consumer.handle(receipt('QUOTATION_SUBMITTED', rfqId, missing).event, DELIVERY),
      ).rejects.toMatchObject({ name: 'RfqEvidenceContinuityError', reason: 'FORK' });
      expect(await heldFor(rfqId)).toBe(1);
    });

    it('refuses a fork: a second successor of one link, and a receipt recorded again under another event', async () => {
      const rfqId = id('RFQ');
      const genesis = genesisReceipt(rfqId);
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesis);
      const second = receipt('QUOTATION_SUBMITTED', rfqId, first.receipt);
      await consumer.handle(first.event, DELIVERY);
      await consumer.handle(second.event, DELIVERY);
      const before = await failures('rfq_chain_fork');

      // A second successor of the first link, and a second first link.
      await expect(
        consumer.handle(receipt('QUOTATION_SUBMITTED', rfqId, first.receipt).event, DELIVERY),
      ).rejects.toMatchObject({ reason: 'FORK' });
      await expect(
        consumer.handle(receipt('QUOTATION_SUBMITTED', rfqId, genesis).event, DELIVERY),
      ).rejects.toMatchObject({ reason: 'FORK' });
      // The same receipt announced again under a different event id.
      await expect(
        consumer.handle(
          receipt('QUOTATION_SUBMITTED', rfqId, second.receipt, { receipt: first.receipt }).event,
          DELIVERY,
        ),
      ).rejects.toMatchObject({ name: 'RfqEvidenceContinuityError', reason: 'FORK' });
      // And a link that names itself as its own predecessor is not a link at all.
      await expect(
        consumer.handle(
          receipt('QUOTATION_SUBMITTED', rfqId, second.receipt, { receipt: second.receipt }).event,
          DELIVERY,
        ),
      ).rejects.toBeInstanceOf(RfqEvidenceUnmappableError);

      const chain = await chainOf(rfqId);
      expect(chain.links.map((l) => l.receipt)).toEqual([first.receipt, second.receipt]);
      expect(await failures('rfq_chain_fork')).toBeGreaterThanOrEqual(before + 2);
    });

    it('lets exactly one of two concurrent links naming the same head through', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      await consumer.handle(first.event, DELIVERY);
      const racers = [
        receipt('QUOTATION_SUBMITTED', rfqId, first.receipt),
        receipt('QUOTATION_SUBMITTED', rfqId, first.receipt),
      ];

      const results = await Promise.allSettled(
        racers.map((r) => consumer.handle(r.event, DELIVERY)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await chainOf(rfqId)).links).toHaveLength(2);
    });

    it('treats concurrent redeliveries of the same event as duplicates, never a fork: in order and held', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      const second = receipt('QUOTATION_SUBMITTED', rfqId, first.receipt);
      const stray = receipt('QUOTATION_SUBMITTED', rfqId, hash());

      // The same in-order event, and the same held one, each delivered three times at once.
      const fresh = await Promise.allSettled(
        [1, 2, 3].map(() => consumer.handle(first.event, DELIVERY)),
      );
      const held = await Promise.allSettled(
        [1, 2, 3].map(() => consumer.handle(stray.event, DELIVERY)),
      );
      expect([...fresh, ...held].filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await chainOf(rfqId)).links.map((l) => l.receipt)).toEqual([first.receipt]);
      expect(await heldFor(rfqId)).toBe(1);

      // A successor and its predecessor, each duplicated, launched in either order.
      const orders = [
        [second.event, second.event, first.event, first.event],
        [first.event, first.event, second.event, second.event],
      ];
      for (const [index, events] of orders.entries()) {
        const other = id('RFQ');
        const a = receipt('QUOTATION_SUBMITTED', other, genesisReceipt(other));
        const b = receipt('QUOTATION_SUBMITTED', other, a.receipt);
        const pick = (e: EventEnvelope): EventEnvelope => (e === first.event ? a.event : b.event);
        const results = await Promise.allSettled(
          events.map((e) => consumer.handle(pick(e), DELIVERY)),
        );
        expect({ order: index, rejected: results.filter((r) => r.status === 'rejected') }).toEqual({
          order: index,
          rejected: [],
        });
        expect((await chainOf(other)).links.map((l) => l.receipt)).toEqual([a.receipt, b.receipt]);
        expect(await heldFor(other)).toBe(0);
      }
    });

    it('refuses a payload that is not the contract, and a receipt that is not a digest', async () => {
      const rfqId = id('RFQ');
      const bad = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId), {
        receipt: 'not-a-digest',
      });
      await expect(consumer.handle(bad.event, DELIVERY)).rejects.toBeInstanceOf(
        RfqEvidenceUnmappableError,
      );
      expect((await chainOf(rfqId)).links).toEqual([]);
    });

    it('refuses a receipt whose envelope and payload disagree about the tenant or the RFQ, and stores nothing', async () => {
      const rfqId = id('RFQ');
      const genesis = genesisReceipt(rfqId);
      const before = await failures('rfq_evidence_mismatch');

      for (const envelopeOverrides of [
        { tenantId: SUPPLIER },
        { tenantId: undefined },
        { aggregateId: id('RFQ-OTHER') },
        // Only the service that owns RFQs may extend an RFQ's chain.
        { producer: 'construction-service' },
      ]) {
        const wrong = receipt('QUOTATION_SUBMITTED', rfqId, genesis, {}, envelopeOverrides);
        await expect(consumer.handle(wrong.event, DELIVERY)).rejects.toMatchObject({
          name: 'RfqEvidenceIdentityError',
        });
      }

      expect((await chainOf(rfqId)).links).toEqual([]);
      expect(await heldFor(rfqId)).toBe(0);
      expect(await failures('rfq_evidence_mismatch')).toBe(before + 4);
    });

    it('refuses a receipt for an RFQ whose chain belongs to another organization', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      await consumer.handle(first.event, DELIVERY);

      // Consistent with itself (envelope and payload agree) but not with the chain.
      const intruder = receipt(
        'QUOTATION_SUBMITTED',
        rfqId,
        first.receipt,
        { organizationId: SUPPLIER },
        { tenantId: SUPPLIER },
      );
      await expect(consumer.handle(intruder.event, DELIVERY)).rejects.toMatchObject({
        name: 'RfqEvidenceIdentityError',
      });
      // …and the same for one that would only be held.
      const stray = receipt(
        'QUOTATION_SUBMITTED',
        rfqId,
        hash(),
        { organizationId: SUPPLIER },
        { tenantId: SUPPLIER },
      );
      await expect(consumer.handle(stray.event, DELIVERY)).rejects.toMatchObject({
        name: 'RfqEvidenceIdentityError',
      });

      expect((await chainOf(rfqId)).links.map((l) => l.receipt)).toEqual([first.receipt]);
      expect(await heldFor(rfqId)).toBe(0);
    });

    it('ignores the events it does not read: nothing else on the topic extends or touches a chain', async () => {
      const rfqId = id('RFQ');
      // A withdrawal extends no chain; an access, an issue, a close and an opening are other
      // streams' business (the domain projector records them as audit rows).
      for (const name of [
        'RFQ_ISSUED',
        'RFQ_CLOSED',
        'QUOTATION_WITHDRAWN',
        'QUOTATION_ACCESSED',
        'QUOTATIONS_OPENED',
      ]) {
        await expect(
          consumer.handle(envelope(name, rfqId, { rfqId }), DELIVERY),
        ).resolves.toBeUndefined();
      }
      expect((await chainOf(rfqId)).links).toEqual([]);
      expect(await heldFor(rfqId)).toBe(0);
    });

    it('stores digests and identifiers only, never a price, content or ciphertext', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId), {
        priceMinor: '1250000000',
        content: { note: 'secret' },
        ciphertext: 'ciphertext-must-not-leak',
      });
      await consumer.handle(first.event, DELIVERY);

      const rows = await migrator.client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM rfq_receipt_link WHERE rfq_id = $1`,
        rfqId,
      );
      // The price, the note and the ciphertext are in the event, not in the row. Every column the
      // run generated is verified against the event first and set aside (#452).
      const sent = first.event.payload as Record<string, string>;
      expectNotDisclosed(rows, [/1250000000|secret|ciphertext-must-not-leak/], {
        metadata: {
          '0.quotation_id': sent.quotationId!,
          '0.rfq_id': rfqId,
          '0.organization_id': BUYER,
          '0.supplier_organization_id': SUPPLIER,
          '0.source_event_id': first.event.eventId,
          '0.receipt': first.receipt,
          '0.previous_receipt': sent.previousReceipt!,
          '0.content_commitment': sent.contentCommitment!,
          '0.ciphertext_sha256': sent.ciphertextSha256!,
          '0.received_at': sent.receivedAt!,
          '0.recorded_at': instant(thisRun()),
        },
        input: first.event,
      });
      expect(Object.keys(rows[0]!).sort()).toEqual(
        [
          'quotation_id',
          'supplier_organization_id',
          'ciphertext_sha256',
          'content_commitment',
          'organization_id',
          'previous_receipt',
          'received_at',
          'receipt',
          'recorded_at',
          'revision',
          'seq',
          'source_event_id',
          'rfq_id',
        ].sort(),
      );
    });
  });

  describe('append-only, for everybody', () => {
    it('refuses the runtime role any update or delete, and the owner too while the trigger stands', async () => {
      const rfqId = id('RFQ');
      await consumer.handle(
        receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId)).event,
        DELIVERY,
      );

      for (const sql of [
        `UPDATE rfq_receipt_link SET receipt = '${'0'.repeat(64)}' WHERE rfq_id = '${rfqId}'`,
        `DELETE FROM rfq_receipt_link WHERE rfq_id = '${rfqId}'`,
        // The work queue is drained (DELETE) but never edited.
        `UPDATE rfq_receipt_pending SET receipt = '${'0'.repeat(64)}' WHERE rfq_id = '${rfqId}'`,
        'TRUNCATE rfq_receipt_link',
      ]) {
        // The runtime role holds SELECT and INSERT only (and DELETE on the work queue): the
        // privilege split refuses it.
        await expect(prisma.client.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/);
      }
      // The schema owner is stopped by the trigger itself.
      await expect(
        migrator.client.$executeRawUnsafe(
          `UPDATE rfq_receipt_link SET revision = 9 WHERE rfq_id = '${rfqId}'`,
        ),
      ).rejects.toThrow(/ck_rfq_evidence_append_only/);
      await expect(migrator.client.$executeRawUnsafe('TRUNCATE rfq_receipt_link')).rejects.toThrow(
        /ck_rfq_evidence_append_only/,
      );
    });
  });

  describe('the one read: procurement-service, for the buyer’s organization, nobody else', () => {
    it('refuses everybody else', async () => {
      const path = `/v1/internal/rfq-evidence/${id('RFQ')}/chain`;
      const server = request(api.app.getHttpServer());

      expect((await server.get(path)).status).toBe(401);
      expect((await server.get(path).set('Authorization', `Bearer ${systemAdmin()}`)).status).toBe(
        403,
      );
      for (const token of [
        await internalToken('identity-service', 'SERVICE', BUYER),
        await internalToken('marketplace-service', 'SERVICE', BUYER),
        // The tender chain's reader is a different service with a different chain: it is
        // refused here even with the same tenant.
        await internalToken('construction-service', 'SERVICE', BUYER),
        await internalToken('supplier-service', 'SERVICE', BUYER),
        await internalToken('economic-service', 'SERVICE', BUYER),
        // procurement-service, but signed for no tenant: the read is scoped by organization.
        await internalToken('procurement-service'),
      ]) {
        expect((await server.get(path).set('x-internal-token', token)).status).toBe(403);
      }
      // A person is refused whatever the role — the buyer's own administrator and an auditor too.
      for (const person of [organizationAdmin(BUYER), auditor(BUYER)]) {
        expect((await server.get(path).set('Authorization', `Bearer ${person}`)).status).toBe(403);
      }
      const relay = await internalToken('procurement-service', 'RELAY', BUYER);
      expect((await server.get(path).set('x-internal-token', relay)).status).toBe(401);
    });

    it('is scoped by organization and RFQ: another organization sees nothing of this chain', async () => {
      const rfqId = id('RFQ');
      const first = receipt('QUOTATION_SUBMITTED', rfqId, genesisReceipt(rfqId));
      await consumer.handle(first.event, DELIVERY);

      expect((await chainOf(rfqId, BUYER)).head).toBe(first.receipt);
      // The same RFQ id asked for under another organization: as if nothing was
      // announced — no link, no head, and no way to tell that the RFQ exists.
      const other = await chainOf(rfqId, SUPPLIER);
      expect(other.links).toEqual([]);
      expect(other.head).toBe(other.genesis);
      expect(JSON.stringify(other)).not.toContain(first.receipt);
    });

    it('never mixes two organizations’ chains: each reads only its own, and an RFQ id is not a way in', async () => {
      const mine = id('RFQ');
      const theirs = id('RFQ');
      const SECOND_BUYER = id('ORG-BUYER2');
      const a = receipt('QUOTATION_SUBMITTED', mine, genesisReceipt(mine));
      const b = receipt(
        'QUOTATION_SUBMITTED',
        theirs,
        genesisReceipt(theirs),
        { organizationId: SECOND_BUYER },
        { tenantId: SECOND_BUYER },
      );
      await consumer.handle(a.event, DELIVERY);
      await consumer.handle(b.event, DELIVERY);

      expect((await chainOf(mine, BUYER)).links.map((l) => l.receipt)).toEqual([a.receipt]);
      expect((await chainOf(theirs, SECOND_BUYER)).links.map((l) => l.receipt)).toEqual([
        b.receipt,
      ]);
      // Guessing the other's RFQ id under one's own token answers as an unknown RFQ.
      for (const [rfq, caller, foreign] of [
        [theirs, BUYER, b.receipt],
        [mine, SECOND_BUYER, a.receipt],
      ] as const) {
        const answer = await chainOf(rfq, caller);
        expect(answer.links).toEqual([]);
        expect(answer.head).toBe(answer.genesis);
        expect(JSON.stringify(answer)).not.toContain(foreign);
      }
    });

    it('answers the same for a chain held in the work queue only: nothing announced yet is nothing', async () => {
      const rfqId = id('RFQ');
      const stray = receipt('QUOTATION_SUBMITTED', rfqId, hash());
      await consumer.handle(stray.event, DELIVERY);

      const answer = await chainOf(rfqId, BUYER);
      expect(answer.links).toEqual([]);
      expect(JSON.stringify(answer)).not.toContain(stray.receipt);
      expect(JSON.stringify(await chainOf(rfqId, SUPPLIER))).not.toContain(stray.receipt);
    });
  });
});
