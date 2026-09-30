import { eventEnvelopeSchema } from '@rasta/contracts';
import { EventPublisher } from '../src/events/publisher';
import {
  PROJECT,
  approvedProject,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The tender lifecycle against PostgreSQL (ADR-065). Creating a tender locks
 * its project; every other command locks the tender row. Each change is a
 * compare-and-set on the tender's own version with its event in the same
 * transaction, keyed by the tender.
 */

const OPEN = '2026-11-01T08:00:00Z';
const CLOSE = '2026-11-30T20:30:00Z';
const TENDER = { title: 'Road resurfacing', scopeOfWork: 'Two kilometres of the main road' };

/** The event's own payload: an outbox row stores the whole validated envelope. */
const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

describe('tender lifecycle', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** An organization with an APPROVED project and one DRAFT tender. */
  const withTender = async (dto: Parameters<Wiring['tenders']['create']>[1] = TENDER) => {
    const a = org();
    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () => w.tenders.create(project.id, dto));
    return { a, project, tender };
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('create', () => {
    it('creates a DRAFT tender at version 1 and publishes TENDER_CREATED, keyed by the tender', async () => {
      const { a, project, tender } = await withTender();

      expect(tender).toMatchObject({
        organizationId: a,
        projectId: project.id,
        status: 'DRAFT',
        version: 1,
        title: TENDER.title,
        procurementNature: null,
        visibility: null,
        bidOpeningAt: null,
        bidClosingAt: null,
        statusReason: null,
        statusReasonCode: null,
      });
      expect(tender.id).toMatch(/^TND_/);

      const created = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'TENDER_CREATED',
      )!;
      expect(created).toMatchObject({
        aggregateType: 'Tender',
        aggregateId: tender.id,
        partitionKey: tender.id,
        topic: 'rasta.construction.v1',
        // The tender's own stream starts at 1: it shares none with its project.
        streamSeq: 1n,
      });
      expect(payloadOf(created)).toEqual({
        tenderId: tender.id,
        projectId: project.id,
        organizationId: a,
        procurementNature: null,
        createdBy: expect.any(String),
        createdAt: tender.createdAt,
      });
    });

    it('keeps the deadlines as UTC instants and hands them back with a Z', async () => {
      const { tender } = await withTender({
        ...TENDER,
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        bidOpeningAt: OPEN,
        bidClosingAt: CLOSE,
      });
      expect(tender).toMatchObject({
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        bidOpeningAt: '2026-11-01T08:00:00.000Z',
        bidClosingAt: '2026-11-30T20:30:00.000Z',
      });
    });

    it('refuses a project that is not APPROVED, and leaves no tender and no event', async () => {
      const a = org();
      const draft = await asAdmin(a, () => w.projects.create(PROJECT));

      await expect(asAdmin(a, () => w.tenders.create(draft.id, TENDER))).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      const page = await asAdmin(a, () => w.tenders.list({ limit: 25 }));
      expect(page.items).toEqual([]);
      expect((await outboxFor(w.prisma, a)).map((row) => row.eventName)).not.toContain(
        'TENDER_CREATED',
      );
    });

    it('answers 404 for a project that does not exist', async () => {
      const a = org();
      await expect(asAdmin(a, () => w.tenders.create('PRJ_missing', TENDER))).rejects.toMatchObject(
        { code: 'NOT_FOUND' },
      );
    });

    it('rolls the tender back when its event cannot be written', async () => {
      const a = org();
      const project = await approvedProject(w, a);
      const enqueue = jest
        .spyOn(EventPublisher.prototype, 'enqueue')
        .mockRejectedValueOnce(new Error('the outbox is unavailable'));
      try {
        await expect(asAdmin(a, () => w.tenders.create(project.id, TENDER))).rejects.toThrow(
          'the outbox is unavailable',
        );
      } finally {
        enqueue.mockRestore();
      }
      const page = await asAdmin(a, () => w.tenders.list({ limit: 25 }));
      expect(page.items).toEqual([]);
    });

    it('is idempotent: a retry returns the first tender; the same key on another project is refused', async () => {
      const a = org();
      const first = await approvedProject(w, a);
      const key = 'tender-create-key-1';

      const one = await asAdmin(a, () => w.tenders.create(first.id, TENDER, key));
      const again = await asAdmin(a, () => w.tenders.create(first.id, TENDER, key));
      expect(again.id).toBe(one.id);
      expect((await asAdmin(a, () => w.tenders.list({ limit: 25 }))).items).toHaveLength(1);
      expect(
        (await outboxFor(w.prisma, a)).filter((row) => row.eventName === 'TENDER_CREATED'),
      ).toHaveLength(1);

      await expect(
        asAdmin(a, () => w.tenders.create(first.id, { ...TENDER, title: 'Another' }, key)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });
  });

  describe('update', () => {
    it('changes what differs, bumps the version, and names only the changed fields', async () => {
      const { a, tender } = await withTender();

      const updated = await asAdmin(a, () =>
        w.tenders.update(tender.id, {
          expectedVersion: 1,
          title: 'Road resurfacing, phase 2',
          procurementNature: 'INQUIRY',
          bidOpeningAt: OPEN,
          bidClosingAt: CLOSE,
        }),
      );

      expect(updated).toMatchObject({
        version: 2,
        title: 'Road resurfacing, phase 2',
        procurementNature: 'INQUIRY',
        scopeOfWork: TENDER.scopeOfWork,
      });
      const event = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'TENDER_UPDATED',
      )!;
      expect(payloadOf(event)).toMatchObject({
        changedFields: ['bidClosingAt', 'bidOpeningAt', 'procurementNature', 'title'],
      });
      expect(JSON.stringify(event.payload)).not.toContain('phase 2');
    });

    it('commits and publishes nothing for an update that changes nothing', async () => {
      const { a, tender } = await withTender();
      const before = (await outboxFor(w.prisma, a)).length;

      const same = await asAdmin(a, () =>
        w.tenders.update(tender.id, { expectedVersion: 1, title: TENDER.title }),
      );

      expect(same.version).toBe(1);
      expect(await outboxFor(w.prisma, a)).toHaveLength(before);
    });

    it('clears the nature and the window with null', async () => {
      const { a, tender } = await withTender({
        ...TENDER,
        procurementNature: 'RFP',
        visibility: 'PUBLIC',
        bidOpeningAt: OPEN,
        bidClosingAt: CLOSE,
      });

      const cleared = await asAdmin(a, () =>
        w.tenders.update(tender.id, {
          expectedVersion: 1,
          procurementNature: null,
          bidOpeningAt: null,
          bidClosingAt: null,
        }),
      );

      expect(cleared).toMatchObject({
        procurementNature: null,
        visibility: 'PUBLIC',
        bidOpeningAt: null,
        bidClosingAt: null,
      });
    });

    it('refuses a stale version with OPTIMISTIC_LOCK_FAILED and changes nothing', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () => w.tenders.update(tender.id, { expectedVersion: 1, title: 'Second' }));

      await expect(
        asAdmin(a, () => w.tenders.update(tender.id, { expectedVersion: 1, title: 'Third' })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect((await asAdmin(a, () => w.tenders.get(tender.id))).title).toBe('Second');
    });

    it('refuses an edit once cancelled', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      await expect(
        asAdmin(a, () => w.tenders.update(tender.id, { expectedVersion: 2, title: 'Too late' })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });
  });

  describe('cancel', () => {
    it('cancels a DRAFT with its reason and publishes TENDER_CANCELLED with a closed code only', async () => {
      const { a, project, tender } = await withTender();

      const cancelled = await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        version: 2,
        statusReason: 'Funding was withdrawn',
        statusReasonCode: 'OWNER_REQUEST',
      });
      const event = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'TENDER_CANCELLED',
      )!;
      expect(event).toMatchObject({
        aggregateType: 'Tender',
        partitionKey: tender.id,
        streamSeq: 2n,
      });
      expect(payloadOf(event)).toMatchObject({
        tenderId: tender.id,
        projectId: project.id,
        from: 'DRAFT',
        reasonCode: 'OWNER_REQUEST',
      });
      expect(JSON.stringify(event.payload)).not.toContain('Funding');
    });

    it('is terminal: no second cancel', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      await expect(
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, { expectedVersion: 2, reason: 'Funding was withdrawn' }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('lets exactly one of two concurrent cancellations win', async () => {
      const { a, tender } = await withTender();

      const results = await Promise.allSettled([
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'First cancellation' }),
        ),
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Second cancellation' }),
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(
        (await outboxFor(w.prisma, a)).filter((row) => row.eventName === 'TENDER_CANCELLED'),
      ).toHaveLength(1);
    });

    it('serialises an edit with a concurrent cancellation: one applies, the other is refused', async () => {
      const { a, tender } = await withTender();

      const [update, cancel] = await Promise.allSettled([
        asAdmin(a, () => w.tenders.update(tender.id, { expectedVersion: 1, title: 'Edited' })),
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
        ),
      ]);

      expect([update.status, cancel.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      const final = await asAdmin(a, () => w.tenders.get(tender.id));
      expect(final.version).toBe(2);
      expect(final.status).toBe(cancel.status === 'fulfilled' ? 'CANCELLED' : 'DRAFT');
    });
  });

  describe('the project and its tenders', () => {
    it('cannot be cancelled while a tender is not finished, and can be once it is', async () => {
      const { a, project, tender } = await withTender();

      await expect(
        asAdmin(a, () =>
          w.projects.cancel(project.id, {
            expectedVersion: project.version,
            reason: 'Funding was withdrawn',
          }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect((await asAdmin(a, () => w.projects.get(project.id))).status).toBe('APPROVED');

      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );
      await expect(
        asAdmin(a, () =>
          w.projects.cancel(project.id, {
            expectedVersion: project.version,
            reason: 'Funding was withdrawn',
          }),
        ),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('never ends with a cancelled project and a tender still open, whichever wins the race', async () => {
      const a = org();
      const project = await approvedProject(w, a);

      const [create, cancel] = await Promise.allSettled([
        asAdmin(a, () => w.tenders.create(project.id, TENDER)),
        asAdmin(a, () =>
          w.projects.cancel(project.id, {
            expectedVersion: project.version,
            reason: 'Funding was withdrawn',
          }),
        ),
      ]);

      const projectNow = await asAdmin(a, () => w.projects.get(project.id));
      const tenders = await asAdmin(a, () => w.tenders.list({ limit: 25 }));
      if (create.status === 'fulfilled') {
        expect(cancel.status).toBe('rejected');
        expect(projectNow.status).toBe('APPROVED');
        expect(tenders.items).toHaveLength(1);
      } else {
        expect(cancel.status).toBe('fulfilled');
        expect(projectNow.status).toBe('CANCELLED');
        expect(tenders.items).toEqual([]);
      }
    });
  });

  describe('list', () => {
    it('pages newest first and filters by status and project', async () => {
      const a = org();
      const one = await approvedProject(w, a);
      const t1 = await asAdmin(a, () => w.tenders.create(one.id, { ...TENDER, title: 'One' }));
      const t2 = await asAdmin(a, () => w.tenders.create(one.id, { ...TENDER, title: 'Two' }));
      const t3 = await asAdmin(a, () => w.tenders.create(one.id, { ...TENDER, title: 'Three' }));
      await asAdmin(a, () =>
        w.tenders.cancel(t2.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      const page = await asAdmin(a, () => w.tenders.list({ limit: 2 }));
      expect(page.items.map((item) => item.id)).toEqual([t3.id, t2.id]);
      expect(page.hasMore).toBe(true);
      expect(page.items[0]).not.toHaveProperty('scopeOfWork');
      const rest = await asAdmin(a, () => w.tenders.list({ limit: 2, cursor: page.nextCursor! }));
      expect(rest.items.map((item) => item.id)).toEqual([t1.id]);

      const cancelled = await asAdmin(a, () => w.tenders.list({ limit: 25, status: 'CANCELLED' }));
      expect(cancelled.items.map((item) => item.id)).toEqual([t2.id]);
      const other = await asAdmin(a, () => w.tenders.list({ limit: 25, projectId: 'PRJ_none' }));
      expect(other.items).toEqual([]);
    });
  });
});
