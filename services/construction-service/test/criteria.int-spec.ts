import { eventEnvelopeSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
import { EventPublisher } from '../src/events/publisher';
import type { CriterionInput } from '../src/tender/criteria.dto';
import {
  approvedProject,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Criteria templates and a tender's criteria against PostgreSQL (ADR-067 § 1):
 * versioned immutable templates, a replace-whole command that is a
 * compare-and-set on the tender, and the freeze the database enforces after
 * publication whatever write path tries.
 */

const PRICE: CriterionInput = {
  code: 'PRICE',
  label: 'Price',
  weightBp: 4000,
  scoringMethod: 'MANUAL_SCORE',
  maxScore: 100,
};
const TECH: CriterionInput = {
  code: 'TECH',
  label: 'Technical merit',
  weightBp: 4000,
  scoringMethod: 'MANUAL_SCORE',
  maxScore: 100,
};
const LICENCE: CriterionInput = {
  code: 'LICENCE',
  label: 'Holds the licence',
  weightBp: 2000,
  scoringMethod: 'PASS_FAIL',
  maxScore: 1,
};
const WHOLE = [PRICE, TECH, LICENCE];

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

describe('evaluation criteria', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const withTender = async () => {
    const a = org();
    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, { title: 'Road resurfacing', scopeOfWork: 'Two kilometres' }),
    );
    return { a, tender };
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('templates', () => {
    it('are versioned per label: the same label again is the next version, never an edit', async () => {
      const a = org();
      const one = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Roads', criteria: WHOLE }),
      );
      const two = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Roads', criteria: [PRICE, TECH] }),
      );
      const other = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Bridges', criteria: [PRICE] }),
      );

      expect([one.version, two.version, other.version]).toEqual([1, 2, 1]);
      expect(one.id).toMatch(/^CTP_/);
      expect(one).toMatchObject({ organizationId: a, totalWeightBp: 10_000 });
      expect((await asAdmin(a, () => w.criteria.getTemplate(one.id))).criteria).toHaveLength(3);
      expect(two.totalWeightBp).toBe(8000);
    });

    it('publish CRITERIA_TEMPLATE_CREATED with counts only', async () => {
      const a = org();
      const template = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Secret label', criteria: WHOLE }),
      );

      const event = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'CRITERIA_TEMPLATE_CREATED',
      )!;
      expect(event).toMatchObject({
        aggregateType: 'CriteriaTemplate',
        aggregateId: template.id,
        partitionKey: `${a}/${template.id}`,
      });
      expect(payloadOf(event)).toEqual({
        templateId: template.id,
        organizationId: a,
        version: 1,
        criteriaCount: 3,
        totalWeightBp: 10_000,
        createdBy: expect.any(String),
        createdAt: template.createdAt,
      });
      expect(JSON.stringify(event.payload)).not.toContain('Secret label');
      expect(JSON.stringify(event.payload)).not.toContain('PRICE');
    });

    it('give two simultaneous versions of one label distinct numbers, or ask one caller to retry', async () => {
      const a = org();
      const results = await Promise.allSettled([
        asAdmin(a, () => w.criteria.createTemplate({ label: 'Race', criteria: [PRICE] })),
        asAdmin(a, () => w.criteria.createTemplate({ label: 'Race', criteria: [TECH] })),
      ]);

      const created = results.filter((r) => r.status === 'fulfilled');
      expect(created.length).toBeGreaterThanOrEqual(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
      }
      const versions = (
        await asAdmin(a, () => w.criteria.listTemplates({ limit: 25, label: 'Race' }))
      ).items.map((item) => item.version);
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions).toHaveLength(created.length);
    });

    it('are idempotent: a retry returns the first, another body under the key is refused', async () => {
      const a = org();
      const key = 'template-key-1';
      const first = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Idem', criteria: WHOLE }, key),
      );
      const again = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Idem', criteria: WHOLE }, key),
      );
      expect(again.id).toBe(first.id);
      expect(
        (await asAdmin(a, () => w.criteria.listTemplates({ limit: 25, label: 'Idem' }))).items,
      ).toHaveLength(1);
      await expect(
        asAdmin(a, () => w.criteria.createTemplate({ label: 'Idem', criteria: [PRICE] }, key)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('page newest first and filter by label', async () => {
      const a = org();
      const t1 = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'A', criteria: [PRICE] }),
      );
      const t2 = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'B', criteria: [PRICE] }),
      );
      const t3 = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'A', criteria: [TECH] }),
      );

      const page = await asAdmin(a, () => w.criteria.listTemplates({ limit: 2 }));
      expect(page.items.map((i) => i.id)).toEqual([t3.id, t2.id]);
      const rest = await asAdmin(a, () =>
        w.criteria.listTemplates({ limit: 2, cursor: page.nextCursor! }),
      );
      expect(rest.items.map((i) => i.id)).toEqual([t1.id]);
      const onlyA = await asAdmin(a, () => w.criteria.listTemplates({ limit: 25, label: 'A' }));
      expect(onlyA.items.map((i) => i.version)).toEqual([2, 1]);
    });
  });

  describe('a tender’s criteria', () => {
    it('are written out, replaced whole, and reported with their total', async () => {
      const { a, tender } = await withTender();

      const first = await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE, TECH] }),
      );
      expect(first).toMatchObject({ totalWeightBp: 8000, complete: false, version: 2 });
      expect(first.items.map((item) => [item.position, item.code])).toEqual([
        [1, 'PRICE'],
        [2, 'TECH'],
      ]);
      expect(first.items.every((item) => item.templateId === null)).toBe(true);

      const second = await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: WHOLE }),
      );
      expect(second).toMatchObject({ totalWeightBp: 10_000, complete: true, version: 3 });
      expect(second.items.map((item) => item.code)).toEqual(['PRICE', 'TECH', 'LICENCE']);
      expect(await asAdmin(a, () => w.criteria.getCriteria(tender.id))).toEqual(second);
      expect((await asAdmin(a, () => w.tenders.get(tender.id))).version).toBe(3);
    });

    it('are copied from a template, which is remembered as provenance', async () => {
      const { a, tender } = await withTender();
      const template = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Roads', criteria: WHOLE }),
      );

      const set = await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, templateId: template.id }),
      );

      expect(set).toMatchObject({ complete: true });
      expect(set.items.map((item) => item.templateId)).toEqual([
        template.id,
        template.id,
        template.id,
      ]);
      const event = (await outboxFor(w.prisma, a)).find(
        (r) => r.eventName === 'TENDER_CRITERIA_SET',
      )!;
      expect(payloadOf(event)).toMatchObject({
        tenderId: tender.id,
        criteriaCount: 3,
        totalWeightBp: 10_000,
        templateId: template.id,
      });
      expect(event).toMatchObject({ aggregateType: 'Tender', partitionKey: tender.id });
    });

    it('keep the tender’s copy when the template later gets a new version', async () => {
      const { a, tender } = await withTender();
      const v1 = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Roads', criteria: WHOLE }),
      );
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, templateId: v1.id }),
      );
      await asAdmin(a, () => w.criteria.createTemplate({ label: 'Roads', criteria: [PRICE] }));

      const now = await asAdmin(a, () => w.criteria.getCriteria(tender.id));
      expect(now.items).toHaveLength(3);
      expect(now.totalWeightBp).toBe(10_000);
    });

    it('refuse a stale version and change nothing', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE] }),
      );

      await expect(
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect((await asAdmin(a, () => w.criteria.getCriteria(tender.id))).items).toHaveLength(1);
    });

    it('refuse an unknown template and a template that is not this organization’s', async () => {
      const { a, tender } = await withTender();
      const b = org();
      const foreign = await asAdmin(b, () =>
        w.criteria.createTemplate({ label: 'B', criteria: WHOLE }),
      );

      for (const templateId of ['CTP_missing', foreign.id]) {
        await expect(
          asAdmin(a, () => w.criteria.setCriteria(tender.id, { expectedVersion: 1, templateId })),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect((await asAdmin(a, () => w.tenders.get(tender.id))).version).toBe(1);
    });

    it('cannot be set on a cancelled tender', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      await expect(
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: WHOLE }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('roll back with their event when the outbox fails', async () => {
      const { a, tender } = await withTender();
      const spy = jest
        .spyOn(EventPublisher.prototype, 'enqueue')
        .mockRejectedValueOnce(new Error('the outbox is unavailable'));
      try {
        await expect(
          asAdmin(a, () =>
            w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
          ),
        ).rejects.toThrow('the outbox is unavailable');
      } finally {
        spy.mockRestore();
      }
      expect((await asAdmin(a, () => w.criteria.getCriteria(tender.id))).items).toEqual([]);
      expect((await asAdmin(a, () => w.tenders.get(tender.id))).version).toBe(1);
    });

    it('answers with the state its own change produced, even when a second set follows at once', async () => {
      // The class of defect Codex found in #162: an answer read after the commit
      // can report the next change's state. Set A is held right after its write
      // (row lock still held); set B queues behind that lock; A is released.
      const { a, tender } = await withTender();
      let release!: () => void;
      let atGate!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (atGate = resolve));
      const original = EventPublisher.prototype.enqueue;
      const spy = jest
        .spyOn(EventPublisher.prototype, 'enqueue')
        .mockImplementationOnce(async function (
          this: EventPublisher,
          ...args: Parameters<EventPublisher['enqueue']>
        ) {
          await original.apply(this, args);
          atGate();
          await gate;
        } as unknown as EventPublisher['enqueue']);
      try {
        const setA = asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE] }),
        );
        await reached;
        const setB = asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: WHOLE }),
        );
        // Not assumed: set B is shown to be waiting on the row lock set A holds.
        await untilASessionWaitsOnALock(w.prisma);
        release();
        const [first, second] = await Promise.all([setA, setB]);

        expect(first).toMatchObject({ version: 2, totalWeightBp: 4000 });
        expect(first.items.map((item) => item.code)).toEqual(['PRICE']);
        expect(second).toMatchObject({ version: 3, totalWeightBp: 10_000 });
        expect(second.items).toHaveLength(3);
      } finally {
        spy.mockRestore();
      }
    });

    it('lets exactly one of two concurrent sets win', async () => {
      const { a, tender } = await withTender();

      const results = await Promise.allSettled([
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE] }),
        ),
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [TECH] }),
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      const now = await asAdmin(a, () => w.criteria.getCriteria(tender.id));
      expect(now.items).toHaveLength(1);
      expect(now.version).toBe(2);
    });

    it('serialise with a cancellation: either the set lands on a live draft or it is refused', async () => {
      const { a, tender } = await withTender();

      const [set, cancel] = await Promise.allSettled([
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
        ),
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
        ),
      ]);

      expect([set.status, cancel.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      const now = await asAdmin(a, () => w.criteria.getCriteria(tender.id));
      expect(now.items).toHaveLength(set.status === 'fulfilled' ? 3 : 0);
    });
  });

  describe('the freeze after publication (threat C3), whatever the write path', () => {
    /** Publishing arrives in PR 4b; this moves a tender past DRAFT the way it will, with the row complete. */
    async function publishRaw(tenderId: string) {
      await w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "status" = 'PUBLISHED', "procurement_nature" = 'FORMAL_TENDER',
           "visibility" = 'PUBLIC', "bid_opening_at" = '2026-11-01T08:00:00Z',
           "bid_closing_at" = '2026-11-30T20:30:00Z' WHERE "id" = '${tenderId}'`,
      );
    }
    it('refuses an insert, an update and a delete on a published tender’s criteria', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
      );
      await publishRaw(tender.id);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `INSERT INTO "tender_criterion" ("id", "organization_id", "tender_id", "position", "code",
             "label", "weight_bp", "scoring_method", "max_score", "created_at", "created_by")
           VALUES ('CRT_${ulid()}', '${a}', '${tender.id}', 9, 'LATE', 'Late', 1, 'MANUAL_SCORE', 10,
             now(), 'USR_1')`,
        ),
      ).rejects.toThrow(/ck_tender_criteria_frozen/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender_criterion" SET "weight_bp" = 9999 WHERE "tender_id" = '${tender.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_criteria_frozen/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `DELETE FROM "tender_criterion" WHERE "tender_id" = '${tender.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_criteria_frozen/);
      await expect(
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: [PRICE] }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect((await asAdmin(a, () => w.criteria.getCriteria(tender.id))).totalWeightBp).toBe(
        10_000,
      );
    });

    it('still lets a DRAFT tender’s criteria change', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
      );
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender_criterion" SET "label" = 'Renamed' WHERE "tender_id" = '${tender.id}'`,
        ),
      ).resolves.toBeGreaterThan(0);
    });
  });

  describe('the database judges both tenders a criteria write touches, and waits for a publication', () => {
    const publishSql = (tenderId: string) =>
      `UPDATE "tender" SET "status" = 'PUBLISHED', "procurement_nature" = 'FORMAL_TENDER',
         "visibility" = 'PUBLIC', "bid_opening_at" = '2026-11-01T08:00:00Z',
         "bid_closing_at" = '2026-11-30T20:30:00Z' WHERE "id" = '${tenderId}'`;

    it('refuses to move a published tender’s criterion to a draft tender (OLD is judged, not only NEW)', async () => {
      const a = org();
      const project = await approvedProject(w, a);
      const published = await asAdmin(a, () =>
        w.tenders.create(project.id, { title: 'First', scopeOfWork: 'One' }),
      );
      const draft = await asAdmin(a, () =>
        w.tenders.create(project.id, { title: 'Second', scopeOfWork: 'Two' }),
      );
      await asAdmin(a, () =>
        w.criteria.setCriteria(published.id, { expectedVersion: 1, criteria: WHOLE }),
      );
      await w.prisma.client.$executeRawUnsafe(publishSql(published.id));

      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender_criterion" SET "tender_id" = '${draft.id}' WHERE "tender_id" = '${published.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_criteria_frozen/);
      expect((await asAdmin(a, () => w.criteria.getCriteria(draft.id))).items).toEqual([]);
    });

    it('makes a criteria write wait for a publication in flight, then refuses it', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
      );

      let commit!: () => void;
      let held!: () => void;
      const mayCommit = new Promise<void>((resolve) => (commit = resolve));
      const holding = new Promise<void>((resolve) => (held = resolve));
      const publishing = w.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(publishSql(tender.id));
        held();
        await mayCommit;
      });
      await holding;

      const write = w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender_criterion" SET "label" = 'Late edit' WHERE "tender_id" = '${tender.id}'`,
      );
      const outcome = expect(write).rejects.toThrow(/ck_tender_criteria_frozen/);
      // Not assumed: the writer is shown to be waiting on the publication's row.
      await untilASessionWaitsOnALock(w.prisma);
      commit();
      await publishing;
      await outcome;
    });

    it('refuses a direct status update that publishes without a complete set of criteria', async () => {
      const { a, tender } = await withTender();
      await expect(w.prisma.client.$executeRawUnsafe(publishSql(tender.id))).rejects.toThrow(
        /ck_tender_publish_criteria/,
      );

      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE, TECH] }),
      );
      await expect(w.prisma.client.$executeRawUnsafe(publishSql(tender.id))).rejects.toThrow(
        /ck_tender_publish_criteria/,
      );

      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: WHOLE }),
      );
      await expect(w.prisma.client.$executeRawUnsafe(publishSql(tender.id))).resolves.toBe(1);
    });
  });

  describe('the database allows only the documented tender status edges', () => {
    const publishSql = (tenderId: string) =>
      `UPDATE "tender" SET "status" = 'PUBLISHED', "procurement_nature" = 'FORMAL_TENDER',
         "visibility" = 'PUBLIC', "bid_opening_at" = '2026-11-01T08:00:00Z',
         "bid_closing_at" = '2026-11-30T20:30:00Z' WHERE "id" = '${tenderId}'`;
    const setStatus = (tenderId: string, status: string) =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "status" = '${status}'::"TenderStatus" WHERE "id" = '${tenderId}'`,
      );

    it('refuses a return to DRAFT once published, so a published tender’s criteria stay frozen', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
      );
      await w.prisma.client.$executeRawUnsafe(publishSql(tender.id));

      await expect(setStatus(tender.id, 'DRAFT')).rejects.toThrow(/ck_tender_status_transition/);
      // Still published, so the edit that a return to DRAFT would have allowed is refused.
      await expect(
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: [PRICE] }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses an edge the state machine does not have, and leaves a terminal state terminal', async () => {
      const { a, tender } = await withTender();
      await expect(setStatus(tender.id, 'CLOSED')).rejects.toThrow(/ck_tender_status_transition/);
      await expect(setStatus(tender.id, 'AWARDED')).rejects.toThrow(/ck_tender_status_transition/);

      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );
      await expect(setStatus(tender.id, 'DRAFT')).rejects.toThrow(/ck_tender_status_transition/);
      // Refused by whichever guard fires first: this tender also has no criteria.
      await expect(setStatus(tender.id, 'PUBLISHED')).rejects.toThrow(
        /ck_tender_(status_transition|publish_criteria)/,
      );
    });

    it('allows the documented forward edges', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
      );
      await w.prisma.client.$executeRawUnsafe(publishSql(tender.id));
      for (const next of ['CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED']) {
        await expect(setStatus(tender.id, next)).resolves.toBe(1);
      }
      await expect(setStatus(tender.id, 'CANCELLED')).rejects.toThrow(
        /ck_tender_status_transition/,
      );
    });
  });

  describe('a criteria template is append-only in the database', () => {
    it('refuses an update, a delete and a truncate, whatever the write path', async () => {
      const a = org();
      const template = await asAdmin(a, () =>
        w.criteria.createTemplate({ label: 'Frozen label', criteria: WHOLE }),
      );

      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "criteria_template" SET "label" = 'Renamed' WHERE "id" = '${template.id}'`,
        ),
      ).rejects.toThrow(/ck_criteria_template_immutable/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `DELETE FROM "criteria_template" WHERE "id" = '${template.id}'`,
        ),
      ).rejects.toThrow(/ck_criteria_template_immutable/);
      await expect(
        w.prisma.client.$executeRawUnsafe('TRUNCATE "criteria_template"'),
      ).rejects.toThrow(/ck_criteria_template_immutable/);
      expect((await asAdmin(a, () => w.criteria.getTemplate(template.id))).label).toBe(
        'Frozen label',
      );
    });
  });

  describe('reading a tender’s criteria', () => {
    it('answers from one snapshot: the version and the rows are from the same moment', async () => {
      const { a, tender } = await withTender();
      await asAdmin(a, () =>
        w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: [PRICE] }),
      );

      // The read is held between its two queries; a second set commits meanwhile.
      let release!: () => void;
      let atGate!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (atGate = resolve));
      const original = w.criteriaRepository.listCriteria.bind(w.criteriaRepository);
      const spy = jest
        .spyOn(w.criteriaRepository, 'listCriteria')
        .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
          atGate();
          await gate;
          return original(...args);
        });
      try {
        const read = asAdmin(a, () => w.criteria.getCriteria(tender.id));
        await reached;
        await asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: 2, criteria: WHOLE }),
        );
        release();
        const seen = await read;

        // Version 2 with one criterion (the state before the second set), never
        // version 2 with three rows, nor version 3 with one.
        expect(seen.version).toBe(2);
        expect(seen.items.map((item) => item.code)).toEqual(['PRICE']);
      } finally {
        spy.mockRestore();
      }
      const after = await asAdmin(a, () => w.criteria.getCriteria(tender.id));
      expect([after.version, after.items.length]).toEqual([3, 3]);
    });
  });

  describe('database invariants', () => {
    async function insertCriterion(a: string, tenderId: string, overrides: Record<string, string>) {
      const columns: Record<string, string> = {
        id: `'CRT_${ulid()}'`,
        organization_id: `'${a}'`,
        tender_id: `'${tenderId}'`,
        position: '1',
        code: `'C'`,
        label: `'Criterion'`,
        weight_bp: '1000',
        scoring_method: `'MANUAL_SCORE'`,
        max_score: '10',
        created_at: 'now()',
        created_by: `'USR_1'`,
        ...overrides,
      };
      await w.prisma.client.$executeRawUnsafe(
        `INSERT INTO "tender_criterion" (${Object.keys(columns)
          .map((c) => `"${c}"`)
          .join(', ')})
         VALUES (${Object.values(columns).join(', ')})`,
      );
    }

    it.each([
      ['a zero weight', { weight_bp: '0' }, 'ck_criterion_weight_range'],
      ['a weight above the whole', { weight_bp: '10001' }, 'ck_criterion_weight_range'],
      ['a zero maximum', { max_score: '0' }, 'ck_criterion_max_score'],
      [
        'a PASS_FAIL criterion scored out of ten',
        { scoring_method: `'PASS_FAIL'`, max_score: '10' },
        'ck_criterion_max_score',
      ],
      ['a blank label', { label: `'  '` }, 'ck_criterion_text_not_blank'],
      ['position zero', { position: '0' }, 'ck_criterion_position_positive'],
      ['a blank actor', { created_by: `' '` }, 'ck_criterion_actor_recorded'],
    ])('refuses %s', async (_label, overrides, constraint) => {
      const { a, tender } = await withTender();
      await expect(insertCriterion(a, tender.id, overrides)).rejects.toThrow(
        new RegExp(constraint),
      );
    });

    it('refuses a repeated code or position within one tender, and a criterion of another organization', async () => {
      const { a, tender } = await withTender();
      const b = org();
      await insertCriterion(a, tender.id, {});
      // PostgreSQL names the key's columns in a unique violation, not the index.
      await expect(insertCriterion(a, tender.id, { position: '2' })).rejects.toThrow(
        /\(organization_id, tender_id, code\)/,
      );
      await expect(insertCriterion(a, tender.id, { code: `'D'` })).rejects.toThrow(
        /\(organization_id, tender_id, \\?"position\\?"\)/,
      );
      await expect(insertCriterion(b, tender.id, { code: `'E'`, position: '5' })).rejects.toThrow(
        /tender_criterion_organization_id_tender_id_fkey/,
      );
    });

    it('refuses a template that is not a non-empty array, has no version, or a blank label', async () => {
      const a = org();
      const insert = (criteria: string, version = '1', label = `'L'`) =>
        w.prisma.client.$executeRawUnsafe(
          `INSERT INTO "criteria_template" ("id", "organization_id", "label", "version", "criteria",
             "created_at", "created_by", "created_correlation_id")
           VALUES ('CTP_${ulid()}', '${a}', ${label}, ${version}, '${criteria}'::jsonb, now(), 'USR_1', 'c')`,
        );
      await expect(insert('{}')).rejects.toThrow(/ck_criteria_template_is_array/);
      await expect(insert('[]')).rejects.toThrow(/ck_criteria_template_is_array/);
      await expect(insert('[{}]', '0')).rejects.toThrow(/ck_criteria_template_version_positive/);
      await expect(insert('[{}]', '1', `'  '`)).rejects.toThrow(
        /ck_criteria_template_text_not_blank/,
      );
    });
  });
});
