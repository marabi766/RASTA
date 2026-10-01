import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { TenderEvidenceUnmappableError, genesisReceipt } from '../src/audit/tender-evidence';
import { TenderEvidenceRepository } from '../src/audit/tender-evidence.repository';
import { TenderGapMonitor } from '../src/audit/tender-gap-monitor';
import { registry } from '@rasta/observability';
import { TenderEvidenceConsumer } from '../src/consumers/tender-evidence.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { auditIngestionFailuresTotal } from '../src/observability/metrics';
import { cleanupRun, id, newMigratorPrisma, newPrisma } from './helpers';
import { internalToken, startApi, systemAdmin, type ApiHarness } from './api-helpers';

/**
 * The tender-evidence projection (ADR-066 § 2-3, § 5, CON-002 PR 6): the receipt
 * chain construction-service opens bids against, held where it cannot rewrite it, and
 * the record of every read of a bid — against PostgreSQL, through the consumer, and
 * the one internal read over HTTP.
 */

const DELIVERY = { topic: 'rasta.construction.v1', partition: 0, offset: '0' } as EventDelivery;
const hash = (): string => createHash('sha256').update(randomBytes(16)).digest('hex');

describe('the tender-evidence projection', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let api: ApiHarness;
  let consumer: TenderEvidenceConsumer;

  const OWNER = id('ORG-OWNER');
  const BIDDER = id('ORG-BIDDER');

  const failures = (reason: string): Promise<number> =>
    auditIngestionFailuresTotal
      .get()
      .then((metric) => metric.values.find((v) => v.labels.reason === reason)?.value ?? 0);

  const envelope = (
    eventName: string,
    tenderId: string,
    payload: object,
    overrides: object = {},
  ): EventEnvelope =>
    eventEnvelopeSchema.parse({
      eventId: id('EVT'),
      eventName,
      occurredAt: new Date().toISOString(),
      producer: 'construction-service',
      aggregateType: 'Tender',
      aggregateId: tenderId,
      tenantId: OWNER,
      correlationId: ulid(),
      payload,
      ...overrides,
    }) as EventEnvelope;

  const receipt = (
    eventName: 'BID_SUBMITTED' | 'BID_REVISED',
    tenderId: string,
    previousReceipt: string,
    overrides: object = {},
    envelopeOverrides: object = {},
  ) => {
    const next = hash();
    return {
      event: envelope(
        eventName,
        tenderId,
        {
          bidId: id('BID'),
          tenderId,
          organizationId: OWNER,
          bidderOrganizationId: BIDDER,
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

  const heldFor = async (tenderId: string): Promise<number> => {
    const [{ count }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM tender_receipt_pending WHERE tender_id = $1`,
      tenderId,
    );
    return Number(count);
  };

  /** The chain as construction-service reads it: a token signed for the tender owner. */
  const chainOf = async (tenderId: string, organizationId: string = OWNER) => {
    const response = await request(api.app.getHttpServer())
      .get(`/v1/internal/tender-evidence/${tenderId}/chain`)
      .set(
        'x-internal-token',
        await internalToken('construction-service', 'SERVICE', organizationId),
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
    consumer = new TenderEvidenceConsumer(
      () => {
        throw new Error('the suite calls handle() and never subscribes');
      },
      new TenderEvidenceRepository(prisma),
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
    it('holds a tender’s links in order and answers the head, from the genesis', async () => {
      const tenderId = id('TND');
      const genesis = genesisReceipt(tenderId);
      const first = receipt('BID_SUBMITTED', tenderId, genesis);
      const second = receipt('BID_SUBMITTED', tenderId, first.receipt);
      const third = receipt('BID_REVISED', tenderId, second.receipt, { revision: 2 });

      for (const link of [first, second, third]) await consumer.handle(link.event, DELIVERY);

      const chain = await chainOf(tenderId);
      expect(chain.genesis).toBe(genesis);
      expect(chain.head).toBe(third.receipt);
      expect(chain.links.map((l) => [l.seq, l.receipt, l.previousReceipt])).toEqual([
        [1, first.receipt, genesis],
        [2, second.receipt, first.receipt],
        [3, third.receipt, second.receipt],
      ]);
    });

    it('answers an empty chain whose head is the genesis for a tender nothing was announced for', async () => {
      const tenderId = id('TND');
      const chain = await chainOf(tenderId);
      expect(chain.links).toEqual([]);
      expect(chain.head).toBe(chain.genesis);
      expect(chain.genesis).toBe(genesisReceipt(tenderId));
    });

    it('is idempotent: the same event twice is one link', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));

      await consumer.handle(first.event, DELIVERY);
      await consumer.handle(first.event, DELIVERY);

      expect((await chainOf(tenderId)).links).toHaveLength(1);
    });

    it('holds a link whose predecessor has not arrived — it is not dead-lettered, not in the chain, not lost', async () => {
      const tenderId = id('TND');
      const stray = receipt('BID_SUBMITTED', tenderId, hash());

      await expect(consumer.handle(stray.event, DELIVERY)).resolves.toBeUndefined();

      const chain = await chainOf(tenderId);
      expect(chain.links).toEqual([]);
      expect(chain.head).toBe(chain.genesis);
      expect(await heldFor(tenderId)).toBe(1);
      // A redelivery of the held event is a duplicate, not a second held row.
      await consumer.handle(stray.event, DELIVERY);
      expect(await heldFor(tenderId)).toBe(1);
    });

    it('places a successor delivered first as soon as its predecessor arrives, in the same step', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      const second = receipt('BID_SUBMITTED', tenderId, first.receipt);

      // The real out-of-order delivery: the later receipt reaches the consumer first.
      await consumer.handle(second.event, DELIVERY);
      expect((await chainOf(tenderId)).links).toEqual([]);
      await consumer.handle(first.event, DELIVERY);

      const chain = await chainOf(tenderId);
      expect(chain.head).toBe(second.receipt);
      expect(chain.links.map((l) => [l.seq, l.receipt])).toEqual([
        [1, first.receipt],
        [2, second.receipt],
      ]);
      expect(await heldFor(tenderId)).toBe(0);
    });

    it('drains a whole run held behind one missing link, in order, whatever order they came in', async () => {
      const tenderId = id('TND');
      const links = [receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId))];
      for (let i = 1; i < 5; i += 1) {
        links.push(receipt('BID_REVISED', tenderId, links[i - 1]!.receipt, { revision: i }));
      }

      // Newest first, the first link last.
      for (const link of [links[3]!, links[1]!, links[4]!, links[2]!]) {
        await consumer.handle(link.event, DELIVERY);
      }
      expect((await chainOf(tenderId)).links).toEqual([]);
      expect(await heldFor(tenderId)).toBe(4);

      await consumer.handle(links[0]!.event, DELIVERY);

      const chain = await chainOf(tenderId);
      expect(chain.links.map((l) => l.receipt)).toEqual(links.map((l) => l.receipt));
      expect(chain.links.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(chain.head).toBe(links[4]!.receipt);
      expect(await heldFor(tenderId)).toBe(0);
    });

    it('counts a gap that stays open past the configured time, once, and clears when it closes', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      const second = receipt('BID_SUBMITTED', tenderId, first.receipt);
      const repository = new TenderEvidenceRepository(prisma);
      const monitor = new TenderGapMonitor(repository, {
        AUDIT_TENDER_GAP_ALERT_SECONDS: 60,
      } as never);
      const gauge = async (name: string): Promise<number> =>
        (await registry.getSingleMetric(name)!.get()).values[0]?.value ?? 0;

      await consumer.handle(second.event, DELIVERY);
      const before = await failures('tender_chain_gap_overdue');
      await monitor.sample();
      // Held, but not for long enough yet: no alert.
      expect(await failures('tender_chain_gap_overdue')).toBe(before);
      expect(await gauge('rasta_audit_tender_pending_links')).toBeGreaterThanOrEqual(1);

      // The owner role may backdate it; the runtime role cannot (no UPDATE grant).
      await migrator.client.$executeRawUnsafe(
        `UPDATE tender_receipt_pending SET held_at = now() - interval '10 minutes' WHERE tender_id = $1`,
        tenderId,
      );
      await monitor.sample();
      await monitor.sample();
      expect(await failures('tender_chain_gap_overdue')).toBe(before + 1);
      expect(await gauge('rasta_audit_tender_pending_oldest_age_seconds')).toBeGreaterThanOrEqual(
        600,
      );

      await consumer.handle(first.event, DELIVERY);
      await monitor.sample();
      expect(await heldFor(tenderId)).toBe(0);
      expect(await failures('tender_chain_gap_overdue')).toBe(before + 1);
    });

    it('refuses two held successors of one missing predecessor: a fork, even while it is unseen', async () => {
      const tenderId = id('TND');
      const missing = hash();
      await consumer.handle(receipt('BID_SUBMITTED', tenderId, missing).event, DELIVERY);

      await expect(
        consumer.handle(receipt('BID_SUBMITTED', tenderId, missing).event, DELIVERY),
      ).rejects.toMatchObject({ name: 'TenderEvidenceContinuityError', reason: 'FORK' });
      expect(await heldFor(tenderId)).toBe(1);
    });

    it('refuses a fork: a second successor of one link, and a receipt recorded again under another event', async () => {
      const tenderId = id('TND');
      const genesis = genesisReceipt(tenderId);
      const first = receipt('BID_SUBMITTED', tenderId, genesis);
      const second = receipt('BID_SUBMITTED', tenderId, first.receipt);
      await consumer.handle(first.event, DELIVERY);
      await consumer.handle(second.event, DELIVERY);
      const before = await failures('tender_chain_fork');

      // A second successor of the first link, and a second first link.
      await expect(
        consumer.handle(receipt('BID_SUBMITTED', tenderId, first.receipt).event, DELIVERY),
      ).rejects.toMatchObject({ reason: 'FORK' });
      await expect(
        consumer.handle(receipt('BID_SUBMITTED', tenderId, genesis).event, DELIVERY),
      ).rejects.toMatchObject({ reason: 'FORK' });
      // The same receipt announced again under a different event id.
      await expect(
        consumer.handle(
          receipt('BID_SUBMITTED', tenderId, second.receipt, { receipt: first.receipt }).event,
          DELIVERY,
        ),
      ).rejects.toMatchObject({ name: 'TenderEvidenceContinuityError', reason: 'FORK' });
      // And a link that names itself as its own predecessor is not a link at all.
      await expect(
        consumer.handle(
          receipt('BID_SUBMITTED', tenderId, second.receipt, { receipt: second.receipt }).event,
          DELIVERY,
        ),
      ).rejects.toBeInstanceOf(TenderEvidenceUnmappableError);

      const chain = await chainOf(tenderId);
      expect(chain.links.map((l) => l.receipt)).toEqual([first.receipt, second.receipt]);
      expect(await failures('tender_chain_fork')).toBeGreaterThanOrEqual(before + 2);
    });

    it('lets exactly one of two concurrent links naming the same head through', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      await consumer.handle(first.event, DELIVERY);
      const racers = [
        receipt('BID_SUBMITTED', tenderId, first.receipt),
        receipt('BID_SUBMITTED', tenderId, first.receipt),
      ];

      const results = await Promise.allSettled(
        racers.map((r) => consumer.handle(r.event, DELIVERY)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await chainOf(tenderId)).links).toHaveLength(2);
    });

    it('refuses a payload that is not the contract, and a receipt that is not a digest', async () => {
      const tenderId = id('TND');
      const bad = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId), {
        receipt: 'not-a-digest',
      });
      await expect(consumer.handle(bad.event, DELIVERY)).rejects.toBeInstanceOf(
        TenderEvidenceUnmappableError,
      );
      expect((await chainOf(tenderId)).links).toEqual([]);
    });

    it('refuses a receipt whose envelope and payload disagree about the tenant or the tender, and stores nothing', async () => {
      const tenderId = id('TND');
      const genesis = genesisReceipt(tenderId);
      const before = await failures('tender_evidence_mismatch');

      for (const envelopeOverrides of [
        { tenantId: BIDDER },
        { tenantId: undefined },
        { aggregateId: id('TND-OTHER') },
      ]) {
        const wrong = receipt('BID_SUBMITTED', tenderId, genesis, {}, envelopeOverrides);
        await expect(consumer.handle(wrong.event, DELIVERY)).rejects.toMatchObject({
          name: 'TenderEvidenceIdentityError',
        });
      }

      expect((await chainOf(tenderId)).links).toEqual([]);
      expect(await heldFor(tenderId)).toBe(0);
      expect(await failures('tender_evidence_mismatch')).toBe(before + 3);
    });

    it('refuses a receipt for a tender whose chain belongs to another organization', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      await consumer.handle(first.event, DELIVERY);

      // Consistent with itself (envelope and payload agree) but not with the chain.
      const intruder = receipt(
        'BID_SUBMITTED',
        tenderId,
        first.receipt,
        { organizationId: BIDDER },
        { tenantId: BIDDER },
      );
      await expect(consumer.handle(intruder.event, DELIVERY)).rejects.toMatchObject({
        name: 'TenderEvidenceIdentityError',
      });
      // …and the same for one that would only be held.
      const stray = receipt(
        'BID_SUBMITTED',
        tenderId,
        hash(),
        { organizationId: BIDDER },
        { tenantId: BIDDER },
      );
      await expect(consumer.handle(stray.event, DELIVERY)).rejects.toMatchObject({
        name: 'TenderEvidenceIdentityError',
      });

      expect((await chainOf(tenderId)).links.map((l) => l.receipt)).toEqual([first.receipt]);
      expect(await heldFor(tenderId)).toBe(0);
    });

    it('ignores the events it does not read', async () => {
      const tenderId = id('TND');
      await expect(
        consumer.handle(envelope('TENDER_PUBLISHED', tenderId, { tenderId }), DELIVERY),
      ).resolves.toBeUndefined();
    });

    it('stores digests and identifiers only, never a price, content or ciphertext', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId), {
        priceMinor: '1250000000',
        content: { note: 'secret' },
        ciphertext: 'AAAA',
      });
      await consumer.handle(first.event, DELIVERY);

      const rows = await migrator.client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM tender_receipt_link WHERE tender_id = $1`,
        tenderId,
      );
      expect(JSON.stringify(rows)).not.toMatch(/1250000000|secret|AAAA/);
      expect(Object.keys(rows[0]!).sort()).toEqual(
        [
          'bid_id',
          'bidder_organization_id',
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
          'tender_id',
        ].sort(),
      );
    });
  });

  describe('every read of a bid', () => {
    const access = (tenderId: string, outcome: 'GRANTED' | 'REFUSED', bidId: string | null) =>
      envelope('BID_ACCESSED', tenderId, {
        bidId,
        tenderId,
        organizationId: OWNER,
        accessorOrganizationId: BIDDER,
        accessedBy: 'USR_9',
        purpose: 'OWN_BID_RECEIPT',
        outcome,
        accessedAt: new Date().toISOString(),
      });

    it('is stored with the identifier-only fields and the real outcome, granted or refused', async () => {
      const tenderId = id('TND');
      const bidId = id('BID');
      await consumer.handle(access(tenderId, 'GRANTED', bidId), DELIVERY);
      await consumer.handle(access(tenderId, 'REFUSED', null), DELIVERY);

      const rows = await migrator.client.$queryRawUnsafe<
        { bid_id: string | null; outcome: string; purpose: string; accessed_by: string }[]
      >(
        `SELECT bid_id, outcome, purpose, accessed_by FROM bid_access_evidence
          WHERE tender_id = $1 ORDER BY outcome`,
        tenderId,
      );
      expect(rows).toEqual([
        { bid_id: bidId, outcome: 'GRANTED', purpose: 'OWN_BID_RECEIPT', accessed_by: 'USR_9' },
        { bid_id: null, outcome: 'REFUSED', purpose: 'OWN_BID_RECEIPT', accessed_by: 'USR_9' },
      ]);
    });

    it('is recorded once however often the event is delivered', async () => {
      const tenderId = id('TND');
      const event = access(tenderId, 'REFUSED', null);
      await consumer.handle(event, DELIVERY);
      await consumer.handle(event, DELIVERY);

      const [{ count }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM bid_access_evidence WHERE tender_id = $1`,
        tenderId,
      );
      expect(Number(count)).toBe(1);
    });

    it('refuses a read whose envelope and payload disagree about the tenant or the tender', async () => {
      const tenderId = id('TND');
      const payload = {
        bidId: null,
        tenderId,
        organizationId: OWNER,
        accessorOrganizationId: BIDDER,
        accessedBy: 'USR_9',
        purpose: 'OWN_BID_RECEIPT',
        outcome: 'REFUSED',
        accessedAt: new Date().toISOString(),
      };
      for (const overrides of [{ tenantId: BIDDER }, { aggregateId: id('TND-OTHER') }]) {
        await expect(
          consumer.handle(envelope('BID_ACCESSED', tenderId, payload, overrides), DELIVERY),
        ).rejects.toMatchObject({ name: 'TenderEvidenceIdentityError' });
      }

      const [{ count }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM bid_access_evidence WHERE tender_id = $1`,
        tenderId,
      );
      expect(Number(count)).toBe(0);
    });

    it('refuses an outcome that is neither granted nor refused', async () => {
      const tenderId = id('TND');
      const bad = envelope('BID_ACCESSED', tenderId, {
        bidId: null,
        tenderId,
        organizationId: OWNER,
        accessorOrganizationId: BIDDER,
        accessedBy: 'USR_9',
        purpose: 'OWN_BID_RECEIPT',
        outcome: 'SUCCESS',
        accessedAt: new Date().toISOString(),
      });
      await expect(consumer.handle(bad, DELIVERY)).rejects.toBeInstanceOf(
        TenderEvidenceUnmappableError,
      );
    });
  });

  describe('append-only, for everybody', () => {
    it('refuses the runtime role any update or delete, and the owner too while the trigger stands', async () => {
      const tenderId = id('TND');
      await consumer.handle(
        receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId)).event,
        DELIVERY,
      );

      for (const sql of [
        `UPDATE tender_receipt_link SET receipt = '${'0'.repeat(64)}' WHERE tender_id = '${tenderId}'`,
        `DELETE FROM tender_receipt_link WHERE tender_id = '${tenderId}'`,
        `DELETE FROM bid_access_evidence WHERE tender_id = '${tenderId}'`,
        'TRUNCATE tender_receipt_link',
      ]) {
        // The runtime role holds SELECT and INSERT only: the privilege split refuses it.
        await expect(prisma.client.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/);
      }
      // The schema owner is stopped by the trigger itself.
      await expect(
        migrator.client.$executeRawUnsafe(
          `UPDATE tender_receipt_link SET revision = 9 WHERE tender_id = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_tender_evidence_append_only/);
      await expect(
        migrator.client.$executeRawUnsafe('TRUNCATE tender_receipt_link'),
      ).rejects.toThrow(/ck_tender_evidence_append_only/);
    });
  });

  describe('the one read: construction-service, for the tender owner’s organization, nobody else', () => {
    it('refuses everybody else', async () => {
      const path = `/v1/internal/tender-evidence/${id('TND')}/chain`;
      const server = request(api.app.getHttpServer());

      expect((await server.get(path)).status).toBe(401);
      expect((await server.get(path).set('Authorization', `Bearer ${systemAdmin()}`)).status).toBe(
        403,
      );
      for (const token of [
        await internalToken('identity-service', 'SERVICE', OWNER),
        await internalToken('marketplace-service', 'SERVICE', OWNER),
        // construction-service, but signed for no tenant: the read is scoped by organization.
        await internalToken('construction-service'),
      ]) {
        expect((await server.get(path).set('x-internal-token', token)).status).toBe(403);
      }
      const relay = await internalToken('construction-service', 'RELAY', OWNER);
      expect((await server.get(path).set('x-internal-token', relay)).status).toBe(401);
    });

    it('is scoped by organization and tender: another organization sees nothing of this chain', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      await consumer.handle(first.event, DELIVERY);

      expect((await chainOf(tenderId, OWNER)).head).toBe(first.receipt);
      // The same tender id asked for under another organization: as if nothing was
      // announced — no link, no head, and no way to tell that the tender exists.
      const other = await chainOf(tenderId, BIDDER);
      expect(other.links).toEqual([]);
      expect(other.head).toBe(other.genesis);
      expect(JSON.stringify(other)).not.toContain(first.receipt);
    });
  });
});
