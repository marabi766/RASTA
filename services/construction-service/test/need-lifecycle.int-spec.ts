import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  PROJECT,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  outboxStream,
  wire,
  type Wiring,
} from './helpers';

/**
 * The need lifecycle against PostgreSQL. Every command locks the project row,
 * so needs change only while the project is editable, and every change is a
 * compare-and-set on the need's own version with its event in the same
 * transaction.
 */

describe('need lifecycle', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const newProject = (organizationId: string) =>
    asAdmin(organizationId, () => w.projects.create(PROJECT));

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('adds a DRAFT need and publishes PROJECT_NEED_ADDED keyed by the project', async () => {
    const a = org();
    const project = await newProject(a);

    const need = await asAdmin(a, () =>
      w.needs.add(project.id, {
        title: 'Hot-mix asphalt',
        description: 'Wearing course',
        quantity: '120.5',
        unit: 't',
        estimatedCostMinor: '300000000',
      }),
    );

    expect(need).toMatchObject({
      projectId: project.id,
      status: 'DRAFT',
      version: 1,
      quantity: '120.5',
      unit: 't',
      estimatedCostMinor: '300000000',
      submittedAt: null,
    });
    expect(need.id).toMatch(/^PND_/);

    const rows = await outboxFor(w.prisma, a);
    const added = rows[1]!;
    expect(added).toMatchObject({
      eventName: 'PROJECT_NEED_ADDED',
      aggregateType: 'Project',
      aggregateId: project.id,
      partitionKey: project.id,
    });
    expect(added.streamSeq).toBe(2n);
    expect(eventEnvelopeSchema.parse(added.payload).payload).toMatchObject({
      projectId: project.id,
      needId: need.id,
    });
  });

  it('walks DRAFT → SUBMITTED → WITHDRAWN, and each step is recorded with its actor', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Culvert pipes', description: 'Two crossings' }),
    );

    const submitted = await asAdmin(a, () =>
      w.needs.submit(project.id, need.id, { expectedVersion: 1 }),
    );
    expect(submitted).toMatchObject({ status: 'SUBMITTED', version: 2 });
    expect(submitted.submittedBy).toBeTruthy();

    const withdrawn = await asAdmin(a, () =>
      w.needs.withdraw(project.id, need.id, {
        expectedVersion: 2,
        reason: 'Covered by the county',
      }),
    );
    expect(withdrawn).toMatchObject({
      status: 'WITHDRAWN',
      version: 3,
      withdrawalReason: 'Covered by the county',
    });

    const rows = await outboxFor(w.prisma, a);
    expect(rows.map((row) => row.eventName)).toEqual([
      'PROJECT_CREATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_NEED_WITHDRAWN',
    ]);
    // The withdrawal reason is prose: kept in the database, never on the log.
    expect(JSON.stringify(rows.map((row) => row.payload))).not.toContain('Covered by the county');

    const detail = await asAdmin(a, () => w.projects.get(project.id));
    expect(detail.needsSummary).toEqual({ draft: 0, submitted: 0, withdrawn: 1 });
  });

  it('withdraws a draft that was never submitted', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Signage', description: 'Two signs' }),
    );

    const withdrawn = await asAdmin(a, () =>
      w.needs.withdraw(project.id, need.id, { expectedVersion: 1, reason: 'Not needed after all' }),
    );
    expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', submittedAt: null });
  });

  it('edits a DRAFT need, naming only the changed fields, and refuses to edit a submitted one', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Gravel', description: 'Base course', quantity: '10' }),
    );

    const edited = await asAdmin(a, () =>
      w.needs.update(project.id, need.id, {
        expectedVersion: 1,
        quantity: '10.0000',
        unit: 'm3',
        description: 'Base course',
      }),
    );
    expect(edited).toMatchObject({ version: 2, unit: 'm3', quantity: '10' });
    const payload = eventEnvelopeSchema.parse((await outboxFor(w.prisma, a))[2]!.payload)
      .payload as {
      changedFields: string[];
    };
    // 10 and 10.0000 are the same quantity; only the unit changed.
    expect(payload.changedFields).toEqual(['unit']);

    await asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 2 }));
    await expect(
      asAdmin(a, () => w.needs.update(project.id, need.id, { expectedVersion: 3, unit: 't' })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('refuses a second submission and a change to a withdrawn need', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Kerbs', description: '400 m' }),
    );
    await asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 }));

    await expect(
      asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 2 })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await asAdmin(a, () =>
      w.needs.withdraw(project.id, need.id, { expectedVersion: 2, reason: 'Scope was reduced' }),
    );
    await expect(
      asAdmin(a, () =>
        w.needs.withdraw(project.id, need.id, { expectedVersion: 3, reason: 'Scope was reduced' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('refuses a stale need version with OPTIMISTIC_LOCK_FAILED', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Lighting', description: 'Poles' }),
    );
    await asAdmin(a, () =>
      w.needs.update(project.id, need.id, { expectedVersion: 1, title: 'Street lighting' }),
    );

    await expect(
      asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
  });

  it('lets exactly one of two concurrent submissions win', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Fencing', description: '1 km' }),
    );

    const results = await Promise.allSettled([
      asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 })),
      asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const names = (await outboxFor(w.prisma, a)).map((row) => row.eventName);
    expect(names.filter((name) => name === 'PROJECT_NEED_SUBMITTED')).toHaveLength(1);
  });

  it('freezes needs once the project is no longer editable', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Paint', description: 'Lines' }),
    );
    await asAdmin(a, () =>
      w.projects.cancel(project.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
    );

    await expect(
      asAdmin(a, () => w.needs.add(project.id, { title: 'More', description: 'Anything' })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    await expect(
      asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    await expect(
      asAdmin(a, () =>
        w.needs.withdraw(project.id, need.id, { expectedVersion: 1, reason: 'Project is gone' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  describe('a need submission against a concurrent project cancellation', () => {
    // Both commands lock the project row (`ProjectRepository.lockProject`), read
    // the project's status under that lock, and write their event in the same
    // transaction, so exactly one order happens and the second command decides
    // on the state the first left. These tests force each order with barriers
    // instead of hoping a race lands on it.
    //
    // They assert on the project's stream (`outboxStream`), not on `createdAt`:
    // `createdAt` is when a transaction *started*, and a command that started
    // first can still take the lock second.

    const REASON = 'Funding was withdrawn';

    /** Holds the next `lockProject` call until `release()`; `reached` settles when it is made. */
    function holdNextLock(): { reached: Promise<void>; release: () => void } {
      const original = w.repository.lockProject.bind(w.repository);
      let signal!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (signal = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      jest.spyOn(w.repository, 'lockProject').mockImplementationOnce(async (...args) => {
        signal();
        await gate;
        return original(...args);
      });
      return { reached, release };
    }

    /** Postgres `now()` has millisecond resolution here; make two transactions' starts differ. */
    const later = () => new Promise((resolve) => setTimeout(resolve, 15));

    const setup = async () => {
      const a = org();
      const project = await newProject(a);
      const need = await asAdmin(a, () =>
        w.needs.add(project.id, { title: 'Drains', description: 'Two' }),
      );
      const submit = () =>
        asAdmin(a, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 }));
      const cancel = () =>
        asAdmin(a, () => w.projects.cancel(project.id, { expectedVersion: 1, reason: REASON }));
      return { a, project, submit, cancel };
    };

    afterEach(() => jest.restoreAllMocks());

    it('lets a submission that took the lock first commit, though the cancellation started earlier', async () => {
      const { a, project, submit, cancel } = await setup();

      // The cancellation opens its transaction (and takes its `now()`) first,
      // then waits; the submission starts later, locks, and commits before the
      // cancellation ever asks for the lock.
      const hold = holdNextLock();
      const cancelled = cancel();
      await hold.reached;
      await later();
      await submit();
      hold.release();
      await cancelled;

      const stream = await outboxStream(w.prisma, a, project.id);
      expect(stream.map((row) => row.eventName)).toEqual([
        'PROJECT_CREATED',
        'PROJECT_NEED_ADDED',
        'PROJECT_NEED_SUBMITTED',
        'PROJECT_STATUS_CHANGED',
      ]);
      expect(stream.map((row) => row.streamSeq)).toEqual([1n, 2n, 3n, 4n]);

      // What went wrong when this was asserted on `createdAt`: the cancellation
      // started first, so its row is *stamped* earlier although it committed last.
      const byStart = (await outboxFor(w.prisma, a)).map((row) => row.eventName);
      expect(byStart.indexOf('PROJECT_STATUS_CHANGED')).toBeLessThan(
        byStart.indexOf('PROJECT_NEED_SUBMITTED'),
      );

      // The submission was decided while the project was still DRAFT.
      const detail = await asAdmin(a, () => w.projects.get(project.id));
      expect(detail.status).toBe('CANCELLED');
      expect(detail.needsSummary).toEqual({ draft: 0, submitted: 1, withdrawn: 0 });
    });

    it('refuses a submission that took the lock after the cancellation committed', async () => {
      const { a, project, submit, cancel } = await setup();

      // The submission opens its transaction first and waits; the cancellation
      // starts later and commits first. The submission then sees CANCELLED.
      const hold = holdNextLock();
      const submitted = submit();
      await hold.reached;
      await later();
      await cancel();
      hold.release();

      await expect(submitted).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      const stream = await outboxStream(w.prisma, a, project.id);
      expect(stream.map((row) => row.eventName)).toEqual([
        'PROJECT_CREATED',
        'PROJECT_NEED_ADDED',
        'PROJECT_STATUS_CHANGED',
      ]);
      const detail = await asAdmin(a, () => w.projects.get(project.id));
      expect(detail).toMatchObject({
        status: 'CANCELLED',
        needsSummary: { draft: 1, submitted: 0, withdrawn: 0 },
      });
    });

    it('makes a cancellation wait for a submission that holds the project lock', async () => {
      const { a, project, submit, cancel } = await setup();

      // The submission takes the lock and stops just before its write.
      const original = w.repository.updateNeed.bind(w.repository);
      let reached!: () => void;
      let release!: () => void;
      const atWrite = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      jest.spyOn(w.repository, 'updateNeed').mockImplementationOnce(async (...args) => {
        reached();
        await gate;
        return original(...args);
      });
      const submitted = submit();
      await atWrite;

      const cancelled = cancel();
      const settledEarly = await Promise.race([
        cancelled.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      expect(settledEarly).toBe(false);

      release();
      await submitted;
      await cancelled;

      const stream = await outboxStream(w.prisma, a, project.id);
      expect(stream.map((row) => row.eventName)).toEqual([
        'PROJECT_CREATED',
        'PROJECT_NEED_ADDED',
        'PROJECT_NEED_SUBMITTED',
        'PROJECT_STATUS_CHANGED',
      ]);
    });

    it('applies exactly one order when both are simply started together', async () => {
      const { a, project, submit, cancel } = await setup();

      const [submitted, cancelled] = await Promise.allSettled([submit(), cancel()]);

      expect(cancelled.status).toBe('fulfilled');
      const stream = await outboxStream(w.prisma, a, project.id);
      const names = stream.map((row) => row.eventName);
      if (submitted.status === 'fulfilled') {
        expect(names.indexOf('PROJECT_NEED_SUBMITTED')).toBeLessThan(
          names.indexOf('PROJECT_STATUS_CHANGED'),
        );
      } else {
        expect(submitted.reason).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
        expect(names).not.toContain('PROJECT_NEED_SUBMITTED');
      }
      // One stream, dense, in commit order.
      expect(stream.map((row) => row.streamSeq)).toEqual(
        stream.map((_, index) => BigInt(index + 1)),
      );
    });
  });

  it('answers 404 for a need that is not on this project', async () => {
    const a = org();
    const first = await newProject(a);
    const second = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(first.id, { title: 'Pipes', description: 'Six' }),
    );

    await expect(
      asAdmin(a, () => w.needs.submit(second.id, need.id, { expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists a project’s needs oldest first, with paging and a status filter', async () => {
    const a = org();
    const project = await newProject(a);
    const n1 = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'One', description: 'First' }),
    );
    const n2 = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Two', description: 'Second' }),
    );
    const n3 = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Three', description: 'Third' }),
    );
    await asAdmin(a, () => w.needs.submit(project.id, n2.id, { expectedVersion: 1 }));

    const page = await asAdmin(a, () => w.needs.list(project.id, { limit: 2 }));
    expect(page.items.map((item) => item.id)).toEqual([n1.id, n2.id]);
    expect(page.hasMore).toBe(true);
    const rest = await asAdmin(a, () =>
      w.needs.list(project.id, { limit: 2, cursor: page.nextCursor! }),
    );
    expect(rest.items.map((item) => item.id)).toEqual([n3.id]);

    const submitted = await asAdmin(a, () =>
      w.needs.list(project.id, { limit: 25, status: 'SUBMITTED' }),
    );
    expect(submitted.items.map((item) => item.id)).toEqual([n2.id]);
  });

  it('adds a need idempotently, and refuses the same key on another project', async () => {
    const a = org();
    const first = await newProject(a);
    const second = await newProject(a);
    const dto = { title: 'Bitumen', description: 'Tack coat' };

    const once = await asAdmin(a, () => w.needs.add(first.id, dto, 'need-key'));
    const again = await asAdmin(a, () => w.needs.add(first.id, dto, 'need-key'));
    expect(again).toEqual(once);

    await expect(asAdmin(a, () => w.needs.add(second.id, dto, 'need-key'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('clears the optional need fields with null and sets them from null', async () => {
    const a = org();
    const project = await newProject(a);
    const need = await asAdmin(a, () =>
      w.needs.add(project.id, { title: 'Sand', description: 'Fill', quantity: '3', unit: 'm3' }),
    );

    const cleared = await asAdmin(a, () =>
      w.needs.update(project.id, need.id, { expectedVersion: 1, quantity: null, unit: null }),
    );
    expect(cleared).toMatchObject({ quantity: null, unit: null, version: 2 });

    const set = await asAdmin(a, () =>
      w.needs.update(project.id, need.id, {
        expectedVersion: 2,
        quantity: '4',
        estimatedCostMinor: '100',
        title: 'Fine sand',
      }),
    );
    expect(set).toMatchObject({
      quantity: '4',
      estimatedCostMinor: '100',
      title: 'Fine sand',
      version: 3,
    });

    const same = await asAdmin(a, () =>
      w.needs.update(project.id, need.id, {
        expectedVersion: 3,
        estimatedCostMinor: '100',
        unit: null,
      }),
    );
    expect(same.version).toBe(3);
  });
});
