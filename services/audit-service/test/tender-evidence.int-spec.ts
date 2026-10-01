import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import {
  TenderEvidenceContinuityError,
  TenderEvidenceUnmappableError,
  genesisReceipt,
} from '../src/audit/tender-evidence';
import { TenderEvidenceRepository } from '../src/audit/tender-evidence.repository';
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

  const envelope = (eventName: string, tenderId: string, payload: object): EventEnvelope =>
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
    }) as EventEnvelope;

  const receipt = (
    eventName: 'BID_SUBMITTED' | 'BID_REVISED',
    tenderId: string,
    previousReceipt: string,
    overrides: object = {},
  ) => {
    const next = hash();
    return {
      event: envelope(eventName, tenderId, {
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
      }),
      receipt: next,
    };
  };

  const chainOf = async (tenderId: string) => {
    const response = await request(api.app.getHttpServer())
      .get(`/v1/internal/tender-evidence/${tenderId}/chain`)
      .set('x-internal-token', await internalToken('construction-service'));
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

    it('refuses a first link that does not start at the genesis, and records nothing', async () => {
      const tenderId = id('TND');
      const before = await failures('tender_chain_gap');
      const stray = receipt('BID_SUBMITTED', tenderId, hash());

      await expect(consumer.handle(stray.event, DELIVERY)).rejects.toMatchObject({
        name: 'TenderEvidenceContinuityError',
        reason: 'GAP',
      });

      expect((await chainOf(tenderId)).links).toEqual([]);
      expect(await failures('tender_chain_gap')).toBe(before + 1);
    });

    it('treats an out-of-order delivery as a gap that resolves when its predecessor arrives', async () => {
      const tenderId = id('TND');
      const first = receipt('BID_SUBMITTED', tenderId, genesisReceipt(tenderId));
      const second = receipt('BID_SUBMITTED', tenderId, first.receipt);

      await expect(consumer.handle(second.event, DELIVERY)).rejects.toBeInstanceOf(
        TenderEvidenceContinuityError,
      );
      await consumer.handle(first.event, DELIVERY);
      // The retry the shared consumer makes.
      await consumer.handle(second.event, DELIVERY);

      expect((await chainOf(tenderId)).head).toBe(second.receipt);
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

  describe('the one read: construction-service, platform-wide, nobody else', () => {
    it('refuses everybody else', async () => {
      const path = `/v1/internal/tender-evidence/${id('TND')}/chain`;
      const server = request(api.app.getHttpServer());

      expect((await server.get(path)).status).toBe(401);
      expect((await server.get(path).set('Authorization', `Bearer ${systemAdmin()}`)).status).toBe(
        403,
      );
      for (const token of [
        await internalToken('identity-service'),
        await internalToken('marketplace-service'),
        // construction-service, but acting for a tenant: this is a platform-wide read.
        await internalToken('construction-service', 'SERVICE', OWNER),
      ]) {
        expect((await server.get(path).set('x-internal-token', token)).status).toBe(403);
      }
      const relay = await internalToken('construction-service', 'RELAY');
      expect((await server.get(path).set('x-internal-token', relay)).status).toBe(401);
    });
  });
});
