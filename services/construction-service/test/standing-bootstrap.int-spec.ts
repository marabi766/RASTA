import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  FakeSnapshot,
  bootstrapOf,
  cleanup,
  forgetBootstrap,
  loadStanding,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

/**
 * The bootstrap of the contractor standing (CON-002 PR 5, ADR-061 § 4): the
 * consumer group starts at the end of a seven-day log, so what predates it is read
 * from supplier-service's snapshot — and until that has happened nobody is
 * eligible. Against PostgreSQL, with the snapshot handed in page by page.
 */

const AT = '2026-10-01T09:00:00.000Z';

describe('the contractor standing is bootstrapped from supplier-service', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const item = (
    organizationId: string,
    contractingApprovedAt: string | null,
    suspensions: { suspensionId: string; suspendedAt: string; reinstatedAt: string | null }[] = [],
  ) => ({ organizationId, contractingApprovedAt, suspensions });

  const live = (eventName: string, organizationId: string, payload: object): EventEnvelope =>
    eventEnvelopeSchema.parse({
      eventId: ulid(),
      eventName,
      occurredAt: new Date().toISOString(),
      producer: 'supplier-service',
      aggregateType: 'Supplier',
      aggregateId: ulid(),
      tenantId: organizationId,
      correlationId: ulid(),
      payload: { organizationId, ...payload },
    }) as EventEnvelope;

  const verdict = (organizationId: string) => w.standing.eligibility(organizationId);

  const marker = () =>
    runUnscoped('the suite reads the marker', () =>
      w.prisma.client.standingBootstrap.findUnique({ where: { id: 1 } }),
    );

  const standingRows = (ids: string[]) =>
    runUnscoped('the suite reads what it wrote', async () => ({
      standing: await w.prisma.client.contractorStanding.findMany({
        where: { organizationId: { in: ids } },
        orderBy: { organizationId: 'asc' },
        select: { organizationId: true, contractingQualifiedAt: true },
      }),
      episodes: await w.prisma.client.contractorSuspension.findMany({
        where: { organizationId: { in: ids } },
        orderBy: { suspensionId: 'asc' },
        select: {
          suspensionId: true,
          organizationId: true,
          suspendedAt: true,
          reinstatedAt: true,
        },
      }),
    }));

  beforeAll(() => {
    w = wire();
  });

  beforeEach(async () => {
    await forgetBootstrap();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    // Leave the standing loaded, as a running service would: the other suites ask about eligibility.
    await loadStanding(w);
    await w.close();
  });

  describe('before it has run', () => {
    it('answers “not loaded” for everybody, even a contractor the events already told it about', async () => {
      const heard = org();
      const stranger = org();
      await w.supplierEvents.handle(
        live('SUPPLIER_QUALIFIED', heard, { qualifiedFor: ['CONTRACTING'], decidedAt: AT }),
      );

      expect(await verdict(heard)).toBe('STANDING_NOT_LOADED');
      expect(await verdict(stranger)).toBe('STANDING_NOT_LOADED');
      expect(await w.standing.isEligible(heard)).toBe(false);
      expect(await marker()).toBeNull();
    });

    it('stays closed while the bootstrap is half-done, and when supplier-service cannot be reached', async () => {
      const first = org();
      const second = org();
      const source = new FakeSnapshot([
        { items: [item(first, '2026-08-01T00:00:00.000Z')], snapshotAt: AT },
        { items: [item(second, '2026-08-02T00:00:00.000Z')], snapshotAt: AT },
      ]);
      source.failOnFetch = 2;

      await expect(bootstrapOf(w, source).runOnce()).rejects.toThrow(
        'supplier-service is unavailable',
      );

      // Page one is in and the marker says where to resume, but the standing is not loaded.
      expect(await marker()).toMatchObject({ cursor: '1', suppliersLoaded: 1, completedAt: null });
      expect(await verdict(first)).toBe('STANDING_NOT_LOADED');
      expect(await verdict(second)).toBe('STANDING_NOT_LOADED');
    });
  });

  describe('what predates the consumer group', () => {
    it('makes a contractor qualified long before the deployment eligible, and a stranger not', async () => {
      const veteran = org();
      const stranger = org();
      await bootstrapOf(
        w,
        new FakeSnapshot([{ items: [item(veteran, '2025-03-01T00:00:00.000Z')], snapshotAt: AT }]),
      ).runOnce();

      expect(await verdict(veteran)).toBe('ELIGIBLE');
      expect(await verdict(stranger)).toBe('NOT_QUALIFIED');
    });

    it('keeps a supplier suspended before the deployment suspended when it is approved for CONTRACTING afterwards', async () => {
      const suspended = org();
      await bootstrapOf(
        w,
        new FakeSnapshot([
          {
            items: [
              item(suspended, null, [
                {
                  suspensionId: `${suspended}-s1`,
                  suspendedAt: '2026-08-10T00:00:00.000Z',
                  reinstatedAt: null,
                },
              ]),
            ],
            snapshotAt: AT,
          },
        ]),
      ).runOnce();

      // The one event the log still holds: an approval. Without the snapshot this is "eligible".
      await w.supplierEvents.handle(
        live('SUPPLIER_QUALIFIED', suspended, {
          qualifiedFor: ['CONTRACTING'],
          decidedAt: '2026-10-01T10:00:00.000Z',
        }),
      );
      expect(await verdict(suspended)).toBe('SUSPENDED');

      await w.supplierEvents.handle(
        live('SUPPLIER_REINSTATED', suspended, {
          suspensionId: `${suspended}-s1`,
          reinstatedAt: '2026-10-01T11:00:00.000Z',
        }),
      );
      expect(await verdict(suspended)).toBe('ELIGIBLE');
    });

    it('lets a late old SUPPLIER_SUSPENDED meet the lift the snapshot already carries', async () => {
      const o = org();
      const id = `${o}-old`;
      await bootstrapOf(
        w,
        new FakeSnapshot([
          {
            items: [
              item(o, '2026-01-01T00:00:00.000Z', [
                {
                  suspensionId: id,
                  suspendedAt: '2026-02-01T00:00:00.000Z',
                  reinstatedAt: '2026-02-05T00:00:00.000Z',
                },
              ]),
            ],
            snapshotAt: AT,
          },
        ]),
      ).runOnce();
      expect(await verdict(o)).toBe('ELIGIBLE');

      // A redelivery of the suspension from before the snapshot must not reopen the closed episode.
      await w.supplierEvents.handle(
        live('SUPPLIER_SUSPENDED', o, {
          suspensionId: id,
          suspendedAt: '2026-02-01T00:00:00.000Z',
        }),
      );
      expect(await verdict(o)).toBe('ELIGIBLE');
    });
  });

  describe('the snapshot and the live events are idempotent with each other', () => {
    it('keeps an event that arrives while a page is in flight, whichever way it falls', async () => {
      const lifted = org();
      const fresh = org();
      const newer = org();
      const liftedId = `${lifted}-s1`;
      const source = new FakeSnapshot([
        {
          items: [
            // The snapshot read the episode open and the approval at its old instant…
            item(lifted, '2026-05-01T00:00:00.000Z', [
              {
                suspensionId: liftedId,
                suspendedAt: '2026-09-01T00:00:00.000Z',
                reinstatedAt: null,
              },
            ]),
            item(newer, '2026-05-01T00:00:00.000Z'),
          ],
          snapshotAt: AT,
        },
      ]);
      // …and meanwhile the lift, a brand-new approval and a newer approval are delivered live.
      source.afterFetch = async () => {
        await w.supplierEvents.handle(
          live('SUPPLIER_REINSTATED', lifted, {
            suspensionId: liftedId,
            reinstatedAt: '2026-10-01T09:30:00.000Z',
          }),
        );
        await w.supplierEvents.handle(
          live('SUPPLIER_QUALIFIED', fresh, {
            qualifiedFor: ['CONTRACTING'],
            decidedAt: '2026-10-01T09:31:00.000Z',
          }),
        );
        await w.supplierEvents.handle(
          live('SUPPLIER_QUALIFIED', newer, {
            qualifiedFor: ['CONTRACTING'],
            decidedAt: '2026-09-30T00:00:00.000Z',
          }),
        );
      };

      await bootstrapOf(w, source).runOnce();

      expect(await verdict(lifted)).toBe('ELIGIBLE');
      expect(await verdict(fresh)).toBe('ELIGIBLE');
      const rows = await standingRows([newer]);
      // The greater instant wins whichever of snapshot and event came last.
      expect(rows.standing[0]!.contractingQualifiedAt!.toISOString()).toBe(
        '2026-09-30T00:00:00.000Z',
      );
    });

    it('is the same on the second run, and after a rebuild from a forgotten marker', async () => {
      const a = org();
      const b = org();
      const pages = [
        {
          items: [
            item(a, '2026-03-01T00:00:00.000Z', [
              {
                suspensionId: `${a}-s1`,
                suspendedAt: '2026-04-01T00:00:00.000Z',
                reinstatedAt: '2026-04-02T00:00:00.000Z',
              },
            ]),
          ],
          snapshotAt: AT,
        },
        {
          items: [
            item(b, '2026-03-02T00:00:00.000Z', [
              {
                suspensionId: `${b}-s1`,
                suspendedAt: '2026-05-01T00:00:00.000Z',
                reinstatedAt: null,
              },
            ]),
          ],
          snapshotAt: AT,
        },
      ];
      expect(await bootstrapOf(w, new FakeSnapshot(pages)).runOnce()).toBe('LOADED');
      const once = await standingRows([a, b]);
      const completed = (await marker())!.completedAt;

      // Done is done: a second run asks for nothing and changes nothing.
      const idle = new FakeSnapshot(pages);
      expect(await bootstrapOf(w, idle).runOnce()).toBe('ALREADY_LOADED');
      expect(idle.fetched).toEqual([]);
      expect((await marker())!.completedAt).toEqual(completed);

      // The rebuild path (the runbook): no marker, load again — the same rows come out.
      await forgetBootstrap();
      expect(await bootstrapOf(w, new FakeSnapshot(pages)).runOnce()).toBe('LOADED');
      expect(await standingRows([a, b])).toEqual(once);
      expect(await verdict(a)).toBe('ELIGIBLE');
      expect(await verdict(b)).toBe('SUSPENDED');
    });
  });

  describe('the marker', () => {
    it('records the cursor, how many suppliers it loaded and the newest snapshot instant, and completes on the last page', async () => {
      const ids = [org(), org(), org()];
      const source = new FakeSnapshot([
        {
          items: [item(ids[0]!, '2026-01-01T00:00:00.000Z')],
          snapshotAt: '2026-10-01T09:00:00.000Z',
        },
        {
          items: [item(ids[1]!, '2026-01-02T00:00:00.000Z')],
          snapshotAt: '2026-10-01T09:00:02.000Z',
        },
        {
          items: [item(ids[2]!, '2026-01-03T00:00:00.000Z')],
          snapshotAt: '2026-10-01T09:00:01.000Z',
        },
      ]);

      expect(await bootstrapOf(w, source).runOnce()).toBe('LOADED');

      expect(source.fetched).toEqual([null, '1', '2']);
      const state = (await marker())!;
      expect(state).toMatchObject({ suppliersLoaded: 3, cursor: '2' });
      expect(state.sourceSnapshotAt!.toISOString()).toBe('2026-10-01T09:00:02.000Z');
      expect(state.completedAt).not.toBeNull();
      for (const id of ids) expect(await verdict(id)).toBe('ELIGIBLE');
    });

    it('is applied once when two instances load at the same time', async () => {
      const ids = [org(), org(), org(), org()];
      const pages = ids.map((id, index) => ({
        items: [item(id, `2026-01-0${index + 1}T00:00:00.000Z`)],
        snapshotAt: AT,
      }));

      await Promise.all([
        bootstrapOf(w, new FakeSnapshot(pages)).runOnce(),
        bootstrapOf(w, new FakeSnapshot(pages)).runOnce(),
      ]);

      expect((await marker())!.suppliersLoaded).toBe(4);
      expect((await marker())!.completedAt).not.toBeNull();
      for (const id of ids) expect(await verdict(id)).toBe('ELIGIBLE');
    });

    it('never reopens or disappears once complete', async () => {
      await loadStanding(w);

      await expect(
        runUnscoped('the suite attacks the table', () =>
          w.prisma.client.$executeRawUnsafe(`UPDATE standing_bootstrap SET completed_at = NULL`),
        ),
      ).rejects.toThrow(/ck_standing_bootstrap_immutable/);
      await expect(
        runUnscoped('the suite attacks the table', () =>
          w.prisma.client.$executeRawUnsafe(`DELETE FROM standing_bootstrap`),
        ),
      ).rejects.toThrow(/ck_standing_bootstrap_immutable/);
      expect((await marker())!.completedAt).not.toBeNull();
    });
  });

  describe('a snapshot it cannot trust leaves the standing closed', () => {
    it('refuses an episode id that two organizations both claim, and completes nothing', async () => {
      const a = org();
      const b = org();
      const shared = `SHARED-${ulid()}`;
      const source = new FakeSnapshot([
        {
          items: [
            item(a, null, [
              { suspensionId: shared, suspendedAt: '2026-08-01T00:00:00.000Z', reinstatedAt: null },
            ]),
            item(b, null, [
              { suspensionId: shared, suspendedAt: '2026-08-01T00:00:00.000Z', reinstatedAt: null },
            ]),
          ],
          snapshotAt: AT,
        },
      ]);

      await expect(bootstrapOf(w, source).runOnce()).rejects.toThrow(
        /contradicts the recorded standing/,
      );

      expect((await marker())!.completedAt).toBeNull();
      expect(await verdict(a)).toBe('STANDING_NOT_LOADED');
      // The page was rolled back whole: not even the first organization's episode is there.
      expect((await standingRows([a, b])).episodes).toEqual([]);
    });

    it('refuses a page that says there is more and names no cursor', async () => {
      const broken = {
        fetchPage: async () => ({ items: [], snapshotAt: AT, hasMore: true, nextCursor: null }),
      };
      await expect(bootstrapOf(w, broken).runOnce()).rejects.toThrow(/names no cursor/);
      expect((await marker())?.completedAt ?? null).toBeNull();
    });
  });
});
