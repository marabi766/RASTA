import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  BOW_TIE,
  PROJECT,
  SQUARE,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * The project lifecycle against PostgreSQL (ADR-063): every change is a
 * compare-and-set, every change writes its event in the same transaction, and
 * a refusal leaves neither a row change nor an event behind.
 */

describe('project lifecycle', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('create', () => {
    it('creates a DRAFT project at version 1 and publishes PROJECT_CREATED in the same transaction', async () => {
      const a = org();
      const project = await asAdmin(a, () =>
        w.projects.create({ ...PROJECT, estimatedCostMinor: '1500000000' }),
      );

      expect(project).toMatchObject({
        organizationId: a,
        status: 'DRAFT',
        version: 1,
        estimatedCostMinor: '1500000000',
        hasArea: false,
        area: null,
        needsSummary: { draft: 0, submitted: 0, withdrawn: 0 },
      });
      expect(project.id).toMatch(/^PRJ_[0-9A-HJKMNP-TV-Z]{26}$/);

      const rows = await outboxFor(w.prisma, a);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        eventName: 'PROJECT_CREATED',
        aggregateType: 'Project',
        aggregateId: project.id,
        partitionKey: project.id,
        topic: 'rasta.construction.v1',
        organizationId: a,
      });
      expect(row.streamSeq).toBe(1n);

      const envelope = eventEnvelopeSchema.parse(row.payload);
      expect(envelope.tenantId).toBe(a);
      expect(envelope.payload).toEqual({
        projectId: project.id,
        organizationId: a,
        title: PROJECT.title,
        operationType: PROJECT.operationType,
        estimatedCostMinor: '1500000000',
        hasArea: false,
        createdBy: project.createdBy,
        createdAt: project.createdAt,
      });
    });

    it('stores the operating area in PostGIS and reads it back as GeoJSON', async () => {
      const a = org();
      const project = await asAdmin(a, () => w.projects.create({ ...PROJECT, area: SQUARE }));

      expect(project.hasArea).toBe(true);
      expect(project.area).toEqual(SQUARE);
      const envelope = eventEnvelopeSchema.parse((await outboxFor(w.prisma, a))[0]!.payload);
      expect((envelope.payload as { hasArea: boolean }).hasArea).toBe(true);
      expect(JSON.stringify(envelope.payload)).not.toContain('coordinates');
    });

    it('refuses an invalid polygon as a 400 on area, and leaves no project and no event', async () => {
      const a = org();

      await expect(
        asAdmin(a, () => w.projects.create({ ...PROJECT, area: BOW_TIE })),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      const count = await asAdmin(a, async () => await w.prisma.client.project.count());
      expect(count).toBe(0);
      expect(await outboxFor(w.prisma, a)).toHaveLength(0);
    });

    it('keeps the largest storable estimate exact', async () => {
      const a = org();
      const project = await asAdmin(a, () =>
        w.projects.create({ ...PROJECT, estimatedCostMinor: '9223372036854775807' }),
      );
      expect(project.estimatedCostMinor).toBe('9223372036854775807');
    });

    it('refuses an operation type outside a configured list (Q-68)', async () => {
      const restricted = wire(testEnv({ CONSTRUCTION_OPERATION_TYPES: 'road,bridge' }));
      try {
        const a = org();
        await expect(
          asAdmin(a, () => restricted.projects.create({ ...PROJECT, operationType: 'canal' })),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        await expect(
          asAdmin(a, () => restricted.projects.create({ ...PROJECT, operationType: 'bridge' })),
        ).resolves.toMatchObject({ operationType: 'bridge' });
      } finally {
        await restricted.close();
      }
    });
  });

  describe('update', () => {
    it('changes what differs, bumps the version, and names only the changed fields', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      const updated = await asAdmin(a, () =>
        w.projects.update(created.id, {
          expectedVersion: 1,
          title: 'Road and drainage',
          operationType: PROJECT.operationType,
          estimatedCostMinor: '42',
        }),
      );

      expect(updated).toMatchObject({
        title: 'Road and drainage',
        version: 2,
        estimatedCostMinor: '42',
      });
      const rows = await outboxFor(w.prisma, a);
      expect(rows.map((row) => row.eventName)).toEqual(['PROJECT_CREATED', 'PROJECT_UPDATED']);
      const payload = eventEnvelopeSchema.parse(rows[1]!.payload).payload as {
        changedFields: string[];
      };
      expect(payload.changedFields).toEqual(['estimatedCostMinor', 'title']);
      expect(JSON.stringify(payload)).not.toContain('Road and drainage');
    });

    it('commits and publishes nothing for an update that changes nothing', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      const same = await asAdmin(a, () =>
        w.projects.update(created.id, { expectedVersion: 1, title: PROJECT.title }),
      );

      expect(same.version).toBe(1);
      expect(await outboxFor(w.prisma, a)).toHaveLength(1);
    });

    it('sets and clears the area', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      const withArea = await asAdmin(a, () =>
        w.projects.update(created.id, { expectedVersion: 1, area: SQUARE }),
      );
      expect(withArea.area).toEqual(SQUARE);

      const cleared = await asAdmin(a, () =>
        w.projects.update(created.id, { expectedVersion: 2, area: null, estimatedCostMinor: null }),
      );
      expect(cleared).toMatchObject({ area: null, hasArea: false, version: 3 });
    });

    it('refuses a stale version with OPTIMISTIC_LOCK_FAILED and changes nothing', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));
      await asAdmin(a, () =>
        w.projects.update(created.id, { expectedVersion: 1, title: 'First edit' }),
      );

      await expect(
        asAdmin(a, () =>
          w.projects.update(created.id, { expectedVersion: 1, title: 'Lost update' }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      const current = await asAdmin(a, () => w.projects.get(created.id));
      expect(current).toMatchObject({ title: 'First edit', version: 2 });
      expect(await outboxFor(w.prisma, a)).toHaveLength(2);
    });

    it('refuses an invalid polygon on update and rolls back the other fields with it', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      await expect(
        asAdmin(a, () =>
          w.projects.update(created.id, {
            expectedVersion: 1,
            title: 'Should not stick',
            area: BOW_TIE,
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const current = await asAdmin(a, () => w.projects.get(created.id));
      expect(current).toMatchObject({ title: PROJECT.title, version: 1 });
      expect(await outboxFor(w.prisma, a)).toHaveLength(1);
    });
  });

  describe('cancel', () => {
    it('cancels a DRAFT with its reason and publishes PROJECT_STATUS_CHANGED', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      const cancelled = await asAdmin(a, () =>
        w.projects.cancel(created.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        statusReason: 'Funding was withdrawn',
        version: 2,
      });
      const rows = await outboxFor(w.prisma, a);
      expect(rows.map((row) => row.eventName)).toEqual([
        'PROJECT_CREATED',
        'PROJECT_STATUS_CHANGED',
      ]);
      expect(rows[1]!.streamSeq).toBe(2n);
      expect(eventEnvelopeSchema.parse(rows[1]!.payload).payload).toMatchObject({
        from: 'DRAFT',
        to: 'CANCELLED',
        reason: 'Funding was withdrawn',
      });
    });

    it('is terminal: no edit and no second cancel', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));
      await asAdmin(a, () =>
        w.projects.cancel(created.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
      );

      await expect(
        asAdmin(a, () => w.projects.update(created.id, { expectedVersion: 2, title: 'Too late' })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      await expect(
        asAdmin(a, () =>
          w.projects.cancel(created.id, { expectedVersion: 2, reason: 'Twice over now' }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(await outboxFor(w.prisma, a)).toHaveLength(2);
    });

    it('lets exactly one of two concurrent cancellations win', async () => {
      const a = org();
      const created = await asAdmin(a, () => w.projects.create(PROJECT));

      const results = await Promise.allSettled([
        asAdmin(a, () =>
          w.projects.cancel(created.id, { expectedVersion: 1, reason: 'First reason given' }),
        ),
        asAdmin(a, () =>
          w.projects.cancel(created.id, { expectedVersion: 1, reason: 'Second reason given' }),
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      const rows = await outboxFor(w.prisma, a);
      expect(rows.filter((row) => row.eventName === 'PROJECT_STATUS_CHANGED')).toHaveLength(1);
    });

    it('is refused from a state the deployment removed (CONSTRUCTION_CANCELLABLE_STATES)', async () => {
      const narrowed = wire(testEnv({ CONSTRUCTION_CANCELLABLE_STATES: 'APPROVED' }));
      try {
        const a = org();
        const created = await asAdmin(a, () => narrowed.projects.create(PROJECT));
        await expect(
          asAdmin(a, () =>
            narrowed.projects.cancel(created.id, {
              expectedVersion: 1,
              reason: 'Funding was withdrawn',
            }),
          ),
        ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      } finally {
        await narrowed.close();
      }
    });
  });

  describe('list', () => {
    it('pages newest first and filters by status', async () => {
      const a = org();
      const first = await asAdmin(a, () => w.projects.create({ ...PROJECT, title: 'First' }));
      const second = await asAdmin(a, () =>
        w.projects.create({ ...PROJECT, title: 'Second', area: SQUARE }),
      );
      const third = await asAdmin(a, () => w.projects.create({ ...PROJECT, title: 'Third' }));
      await asAdmin(a, () =>
        w.projects.cancel(first.id, { expectedVersion: 1, reason: 'Merged elsewhere' }),
      );

      const page1 = await asAdmin(a, () => w.projects.list({ limit: 2 }));
      expect(page1.items.map((item) => item.id)).toEqual([third.id, second.id]);
      expect(page1).toMatchObject({ hasMore: true, nextCursor: second.id });
      expect(page1.items[1]).toMatchObject({ hasArea: true });
      expect((page1.items[1] as Record<string, unknown>).area).toBeUndefined();

      const page2 = await asAdmin(a, () =>
        w.projects.list({ limit: 2, cursor: page1.nextCursor! }),
      );
      expect(page2.items.map((item) => item.id)).toEqual([first.id]);
      expect(page2).toMatchObject({ hasMore: false, nextCursor: null });

      const cancelled = await asAdmin(a, () => w.projects.list({ limit: 25, status: 'CANCELLED' }));
      expect(cancelled.items.map((item) => item.id)).toEqual([first.id]);
    });
  });

  describe('idempotent creation (docs/06 § 6.8)', () => {
    it('returns the first response for a retry with the same key and body, creating one project', async () => {
      const a = org();
      const first = await asAdmin(a, () => w.projects.create(PROJECT, 'key-create-1'));
      const retry = await asAdmin(a, () => w.projects.create(PROJECT, 'key-create-1'));

      expect(retry).toEqual(first);
      expect(await asAdmin(a, async () => await w.prisma.client.project.count())).toBe(1);
      expect(await outboxFor(w.prisma, a)).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const a = org();
      await asAdmin(a, () => w.projects.create(PROJECT, 'key-create-2'));

      await expect(
        asAdmin(a, () =>
          w.projects.create({ ...PROJECT, title: 'Something else' }, 'key-create-2'),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('keeps one organization’s key from colliding with another’s', async () => {
      const a = org();
      const b = org();
      const inA = await asAdmin(a, () => w.projects.create(PROJECT, 'shared-key'));
      const inB = await asAdmin(b, () => w.projects.create(PROJECT, 'shared-key'));

      expect(inB.id).not.toBe(inA.id);
      expect(inB.organizationId).toBe(b);
    });

    it('releases the key when the work fails, so a corrected retry succeeds', async () => {
      const a = org();
      await expect(
        asAdmin(a, () => w.projects.create({ ...PROJECT, area: BOW_TIE }, 'key-create-3')),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const keys = await runUnscoped('inspect the idempotency store', () =>
        w.prisma.client.idempotencyKey.findMany({ where: { organizationId: a } }),
      );
      expect(keys).toHaveLength(0);
    });
  });
});
