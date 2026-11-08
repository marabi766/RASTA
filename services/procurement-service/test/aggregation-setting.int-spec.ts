import { eligibilityClockSql } from '@rasta/testing';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { AggregationSettingRepository } from '../src/setting/setting.repository';
import { isGuardRefusal, isUniqueViolation } from '../src/shared/prisma-errors';
import { actor, buyer, client, key, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * An organization's aggregation settings (ADR-070 § 2, plan PR 3; docs/24 Q-10, Q-119 (2), (3)):
 * versioned, append-only, written by PROCUREMENT_AGGREGATION_SETTING_ROLES of the organization
 * itself, each with AGGREGATION_SETTING_CHANGED; a window takes the version in force when it opens
 * and keeps it; with no version, the environment defaults — PR 1 and 2 unchanged.
 */
const HOUR = 3_600_000;
const T0 = new Date('2031-09-01T08:00:00.000Z');
const MAX_QUANTITY = 2_147_483_647;

describe('aggregation settings (plan PR 3)', () => {
  let api: ApiHarness;
  const clock = new TestClock();
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const admin = (organizationId: string) =>
    client(api, actor(organizationId, ['ORGANIZATION_ADMIN'], { rastaUserId: 'USR-SETTER' }));

  beforeAll(async () => {
    api = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
      },
      { clock },
    );
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  const events = async (organizationId: string) =>
    (
      await api.prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName: 'AGGREGATION_SETTING_CHANGED' },
        // The clock is pinned, so two versions' events can share an instant: their stream (the
        // organization's) orders them exactly.
        orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
      })
    ).map((row) => eventEnvelopeSchema.parse(row.payload).payload as Record<string, unknown>);
  const versions = (organizationId: string) =>
    runUnscoped('the suite reads the setting versions it wrote', () =>
      api.prisma.client.aggregationSetting.findMany({
        where: { organizationId },
        orderBy: { version: 'asc' },
      }),
    );

  it('with none recorded, the environment defaults are in force, and a window takes them with no version', async () => {
    const organizationId = org();
    expect((await admin(organizationId).setting()).body).toEqual({
      windowHours: 10,
      minQuantity: 0,
      shortfallPolicy: 'EXTEND',
      settingVersion: null,
      recordedAt: null,
    });
    clock.set(T0);
    const demand = (await client(api, buyer(organizationId)).submit()).body;
    const window = (await client(api, buyer(organizationId)).aggregation(demand.aggregationId))
      .body;
    expect(window.setting).toEqual({
      windowHours: 10,
      minQuantity: 0,
      shortfallPolicy: 'EXTEND',
      settingVersion: null,
    });
  });

  it('records version 1 with its event; the next window takes it, and closes by its length', async () => {
    const organizationId = org();
    clock.set(T0);
    const recorded = await admin(organizationId).recordSetting({
      windowHours: 72,
      minQuantity: 500,
      shortfallPolicy: 'REFER',
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toEqual({
      windowHours: 72,
      minQuantity: 500,
      shortfallPolicy: 'REFER',
      settingVersion: 1,
      recordedAt: T0.toISOString(),
    });
    expect((await client(api, buyer(organizationId)).setting()).body).toEqual(recorded.body);
    expect(await events(organizationId)).toEqual([
      {
        organizationId,
        settingVersion: 1,
        previousVersion: null,
        windowHours: 72,
        minQuantity: 500,
        shortfallPolicy: 'REFER',
        recordedBy: 'USR-SETTER',
        recordedAt: T0.toISOString(),
      },
    ]);

    clock.set(new Date(T0.getTime() + HOUR));
    const as = client(api, buyer(organizationId));
    const demand = (await as.submit({ quantity: 3 })).body;
    const window = (await as.aggregation(demand.aggregationId)).body;
    expect(window.setting).toEqual({
      windowHours: 72,
      minQuantity: 500,
      shortfallPolicy: 'REFER',
      settingVersion: 1,
    });
    expect(window.closesAt).toBe(new Date(T0.getTime() + HOUR + 72 * HOUR).toISOString());
  });

  it('a new version reaches only windows opened after it: the open one keeps its snapshot', async () => {
    const organizationId = org();
    const setter = admin(organizationId);
    clock.set(T0);
    await setter.recordSetting({ windowHours: 24, expectedCurrentVersion: null }).expect(201);
    const as = client(api, buyer(organizationId));
    const productId = newProductId();
    const before = (await as.submit({ productId })).body;

    clock.set(new Date(T0.getTime() + HOUR));
    const second = await setter.recordSetting({
      windowHours: 48,
      minQuantity: 7,
      shortfallPolicy: 'CLOSE',
      expectedCurrentVersion: 1,
    });
    expect(second.status).toBe(201);
    expect(second.body.settingVersion).toBe(2);
    expect(
      (await events(organizationId)).map((e) => [e.settingVersion, e.previousVersion]),
    ).toEqual([
      [1, null],
      [2, 1],
    ]);

    // The same product's open window: unchanged, and a demand still joins it.
    const joined = (await as.submit({ productId })).body;
    expect(joined.aggregationId).toBe(before.aggregationId);
    expect((await as.aggregation(before.aggregationId)).body.setting).toMatchObject({
      windowHours: 24,
      settingVersion: 1,
    });
    // Another product's new window: version 2.
    const other = (await as.submit({ productId: newProductId() })).body;
    expect((await as.aggregation(other.aggregationId)).body.setting).toEqual({
      windowHours: 48,
      minQuantity: 7,
      shortfallPolicy: 'CLOSE',
      settingVersion: 2,
    });
  });

  it('refuses a version the caller did not see: 409 OPTIMISTIC_LOCK_FAILED, nothing written — and of two at once, one wins', async () => {
    const organizationId = org();
    const setter = admin(organizationId);
    await setter.recordSetting({ expectedCurrentVersion: null }).expect(201);

    for (const stale of [null, 2, 7]) {
      const refused = await setter.recordSetting({ expectedCurrentVersion: stale });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
    }
    expect(await versions(organizationId)).toHaveLength(1);

    const racing = await Promise.all([
      setter.recordSetting({ windowHours: 30, expectedCurrentVersion: 1 }),
      setter.recordSetting({ windowHours: 31, expectedCurrentVersion: 1 }),
    ]);
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await versions(organizationId)).map((v) => v.version)).toEqual([1, 2]);
    expect(await events(organizationId)).toHaveLength(2);
  });

  /**
   * Two writers that both read version n, in each order of commit the database can give them
   * (PR-348 r1 F1). Forced, not hoped for: a spy on the real repository parks one writer inside
   * its transaction until the test lets it go. The loser is 409 either way, writes no version and
   * no event, and its released key records afterwards.
   */
  describe('two writers that read the same version (PR-348 r1 F1)', () => {
    let repository: AggregationSettingRepository;
    const releases: Array<() => void> = [];
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      releases.push(open);
      return { open, opened };
    };

    beforeAll(() => {
      repository = api.app.get(AggregationSettingRepository);
    });

    afterEach(() => {
      // A failed assertion must not strand a parked request (afterAll would wait on it).
      for (const open of releases.splice(0)) open();
      jest.restoreAllMocks();
    });

    /** Each `record` the service makes for `organizationId`, and how it ended. */
    const watchInserts = (organizationId: string) => {
      const outcomes: unknown[] = [];
      const record = repository.record.bind(repository);
      const spy = jest.spyOn(repository, 'record');
      spy.mockImplementation(async (tx, setting) => {
        try {
          return await record(tx, setting);
        } catch (error) {
          if (setting.organizationId === organizationId) outcomes.push(error);
          throw error;
        }
      });
      return { outcomes, spy, record };
    };

    /** Versions 1..n recorded first, so the race is for n + 1. */
    const atVersion = async (organizationId: string, n: number) => {
      for (let version = 1; version <= n; version++) {
        await admin(organizationId)
          .recordSetting({ windowHours: version, expectedCurrentVersion: version - 1 || null })
          .expect(201);
      }
    };

    const loserLeftNoTrace = async (
      organizationId: string,
      n: number,
      setter: ReturnType<typeof admin>,
      loserKey: string,
    ) => {
      expect((await versions(organizationId)).map((v) => [v.version, v.windowHours])).toEqual([
        ...Array.from({ length: n }, (_, i) => [i + 1, i + 1]),
        [n + 1, 30],
      ]);
      const changed = await events(organizationId);
      expect(changed).toHaveLength(n + 1);
      expect(changed[n]).toMatchObject({
        settingVersion: n + 1,
        previousVersion: n || null,
        windowHours: 30,
      });
      // The loser's claim was released, not kept: its key takes another body and records.
      const retried = await setter.recordSetting(
        { windowHours: 31, expectedCurrentVersion: n + 1 },
        loserKey,
      );
      expect(retried.status).toBe(201);
      expect(retried.body.settingVersion).toBe(n + 2);
      expect(await events(organizationId)).toHaveLength(n + 2);
    };

    it.each([
      ['the first version', 0],
      ['a later version', 1],
    ])(
      '%s: B reads n, A commits n + 1, B resumes — the guard refuses B before the primary key: 409',
      async (_, n) => {
        const organizationId = org();
        await atVersion(organizationId, n);
        const setter = admin(organizationId);
        const inserts = watchInserts(organizationId);

        // Park the first writer (B) right after it read the current version, in its transaction.
        const bRead = gate();
        const resumeB = gate();
        let parked = false;
        const current = repository.current.bind(repository);
        jest.spyOn(repository, 'current').mockImplementation(async (organization, tx) => {
          const read = await current(organization, tx);
          if (organization === organizationId && tx !== undefined && !parked) {
            parked = true;
            bRead.open();
            await resumeB.opened;
          }
          return read;
        });

        const bKey = key();
        const b = setter
          .recordSetting({ windowHours: 31, expectedCurrentVersion: n || null }, bKey)
          .then((response) => response);
        await bRead.opened;
        expect((await versions(organizationId)).map((v) => v.version)).toHaveLength(n);

        const a = await setter.recordSetting({
          windowHours: 30,
          expectedCurrentVersion: n || null,
        });
        expect(a.status).toBe(201);
        expect(a.body.settingVersion).toBe(n + 1);

        resumeB.open();
        const lost = await b;
        expect([lost.status, lost.body.code]).toEqual([409, 'OPTIMISTIC_LOCK_FAILED']);
        // B passed its own version check (it read n) and was stopped by the guard, not the key.
        expect(inserts.outcomes).toHaveLength(1);
        expect(isGuardRefusal(inserts.outcomes[0], 'ck_aggregation_setting_next_version')).toBe(
          true,
        );
        expect(isUniqueViolation(inserts.outcomes[0])).toBe(false);

        await loserLeftNoTrace(organizationId, n, setter, bKey);
      },
    );

    it.each([
      ['the first version', 0],
      ['a later version', 1],
    ])(
      '%s: A inserts n + 1 and waits, B passes the guard and waits on A’s row, A commits — the primary key refuses B: 409',
      async (_, n) => {
        const organizationId = org();
        await atVersion(organizationId, n);
        const setter = admin(organizationId);
        const inserts = watchInserts(organizationId);

        // Park the first writer (A) after its insert, before its commit.
        const aInserted = gate();
        const resumeA = gate();
        let parked = false;
        inserts.spy.mockImplementation(async (tx, setting) => {
          try {
            const row = await inserts.record(tx, setting);
            if (setting.organizationId === organizationId && !parked) {
              parked = true;
              aInserted.open();
              await resumeA.opened;
            }
            return row;
          } catch (error) {
            if (setting.organizationId === organizationId) inserts.outcomes.push(error);
            throw error;
          }
        });

        const a = setter
          .recordSetting({ windowHours: 30, expectedCurrentVersion: n || null })
          .then((response) => response);
        await aInserted.opened;

        const bKey = key();
        const b = setter
          .recordSetting({ windowHours: 31, expectedCurrentVersion: n || null }, bKey)
          .then((response) => response);
        // B is waiting on A's uncommitted row: its insert holds no answer until A ends.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [{ waiting }] = await api.prisma.client.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE 'INSERT INTO "public"."aggregation_setting"%'`;
          if (waiting === 1) break;
          if (Date.now() > deadline) throw new Error('B never waited on A’s row');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        resumeA.open();
        const won = await a;
        expect(won.status).toBe(201);
        expect(won.body.settingVersion).toBe(n + 1);
        const lost = await b;
        expect([lost.status, lost.body.code]).toEqual([409, 'OPTIMISTIC_LOCK_FAILED']);
        expect(inserts.outcomes).toHaveLength(1);
        expect(isUniqueViolation(inserts.outcomes[0])).toBe(true);

        await loserLeftNoTrace(organizationId, n, setter, bKey);
      },
    );
  });

  it('is idempotent under its key: the same answer, one version; another body under it is refused', async () => {
    const organizationId = org();
    const setter = admin(organizationId);
    const k = key();
    const first = await setter.recordSetting({ windowHours: 12 }, k);
    const replay = await setter.recordSetting({ windowHours: 12 }, k);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const reused = await setter.recordSetting({ windowHours: 13 }, k);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await versions(organizationId)).toHaveLength(1);
    expect(await events(organizationId)).toHaveLength(1);
  });

  it('holds the bounds of R2-1: MAX_QUANTITY accepted, one more refused; the length 1 to 8760; a closed policy', async () => {
    const organizationId = org();
    const setter = admin(organizationId);
    for (const body of [
      { minQuantity: MAX_QUANTITY + 1 },
      { minQuantity: -1 },
      { windowHours: 0 },
      { windowHours: 8761 },
      { windowHours: 1.5 },
      { shortfallPolicy: 'WAIT' },
      { expectedCurrentVersion: 0 },
      { note: 'not a field' },
    ]) {
      const refused = await setter.recordSetting(body as never);
      expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 400]);
    }
    const missing = await setter.post('/v1/aggregation-settings', {
      windowHours: 24,
      minQuantity: 0,
      shortfallPolicy: 'EXTEND',
    });
    expect(missing.status).toBe(400);
    expect(await versions(organizationId)).toHaveLength(0);

    const max = await setter.recordSetting({ minQuantity: MAX_QUANTITY, windowHours: 8760 });
    expect(max.status).toBe(201);
    expect(max.body).toMatchObject({ minQuantity: MAX_QUANTITY, windowHours: 8760 });
  });

  describe('who records and reads (Q-119 (2))', () => {
    it('a requester reads the settings but does not record them: 403 INSUFFICIENT_ROLE, nothing written', async () => {
      const organizationId = org();
      const as = client(api, buyer(organizationId));
      expect((await as.setting()).status).toBe(200);
      const refused = await as.recordSetting();
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('INSUFFICIENT_ROLE');
      expect(await versions(organizationId)).toHaveLength(0);
    });

    it.each([
      ['the platform administrator', ['SYSTEM_ADMIN']],
      [
        'the platform administrator who is also the organization’s',
        ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'],
      ],
      ['the oversight role', ['AUDITOR']],
      [
        'the oversight role who is also the organization’s administrator',
        ['AUDITOR', 'ORGANIZATION_ADMIN'],
      ],
    ])('%s neither reads nor records: 403', async (_, roles) => {
      const organizationId = org();
      const as = client(api, actor(organizationId, roles));
      expect((await as.setting()).status).toBe(403);
      expect((await as.recordSetting()).status).toBe(403);
      expect(await versions(organizationId)).toHaveLength(0);
    });

    it('a person with no platform user id does not record: 403', async () => {
      const organizationId = org();
      const as = client(api, actor(organizationId, ['ORGANIZATION_ADMIN'], { rastaUserId: null }));
      expect((await as.recordSetting()).status).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('one organization’s versions are its own: another reads its own defaults, and its windows are untouched', async () => {
      const a = org();
      const b = org();
      await admin(a).recordSetting({ windowHours: 99, minQuantity: 42 }).expect(201);

      expect((await admin(b).setting()).body).toMatchObject({
        settingVersion: null,
        windowHours: 10,
      });
      // B's first version is its 1, whatever A holds; A's precondition is A's.
      expect(
        (await admin(b).recordSetting({ windowHours: 5, expectedCurrentVersion: null })).body,
      ).toMatchObject({ settingVersion: 1, windowHours: 5 });
      expect((await admin(a).setting()).body).toMatchObject({ settingVersion: 1, windowHours: 99 });

      clock.set(T0);
      const demand = (await client(api, buyer(b)).submit()).body;
      expect(
        (await client(api, buyer(b)).aggregation(demand.aggregationId)).body.setting,
      ).toMatchObject({ windowHours: 5, settingVersion: 1 });
    });
  });

  describe('the database keeps the versions (as the runtime role)', () => {
    const raw = () => api.prisma.client;
    const insert = (organizationId: string, version: number, minQuantity = 0) =>
      raw().$executeRawUnsafe(
        `INSERT INTO aggregation_setting (organization_id, version, window_hours, min_quantity,
           shortfall_policy, recorded_by, recorded_at, correlation_id)
         VALUES ($1, $2, 24, $3, 'EXTEND', 'USR-RAW', now(), 'corr-raw')`,
        organizationId,
        version,
        minQuantity,
      );
    const refusedWith = async (promise: Promise<unknown>, pattern: RegExp) => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(String((error as Error | null)?.message)).toMatch(pattern);
    };

    it('numbers versions without a gap, never changes or erases one, and holds the bounds', async () => {
      const organizationId = org();
      await refusedWith(insert(organizationId, 2), /ck_aggregation_setting_next_version/);
      await insert(organizationId, 1);
      await refusedWith(
        insert(organizationId, 1),
        /ck_aggregation_setting_next_version|aggregation_setting_pkey|Unique constraint/,
      );
      await refusedWith(insert(organizationId, 3), /ck_aggregation_setting_next_version/);
      await refusedWith(
        insert(organizationId, 2, MAX_QUANTITY + 1),
        /ck_aggregation_setting_values|out of range/,
      );
      await refusedWith(
        raw().$executeRawUnsafe(
          `UPDATE aggregation_setting SET min_quantity = 9 WHERE organization_id = $1`,
          organizationId,
        ),
        /ck_aggregation_setting_append_only/,
      );
      await refusedWith(
        raw().$executeRawUnsafe(
          `DELETE FROM aggregation_setting WHERE organization_id = $1`,
          organizationId,
        ),
        /ck_aggregation_setting_append_only/,
      );
      expect((await versions(organizationId)).map((v) => v.version)).toEqual([1]);
    });

    it('a window names a version of its own organization, and holds exactly that version’s values', async () => {
      const a = org();
      const b = org();
      await insert(a, 1);
      const open = (organizationId: string, version: number, windowHours: number) =>
        raw().$executeRawUnsafe(
          eligibilityClockSql`INSERT INTO demand_aggregation
             (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
              min_quantity, shortfall_policy, setting_version, total_quantity, demand_count,
              extension_count, created_at, updated_at)
           VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, 0, 'EXTEND', $7, 0, 0, 0, $4, $4)`,
          `AGG_${newProductId().slice(4)}`,
          organizationId,
          newProductId(),
          T0,
          new Date(T0.getTime() + windowHours * HOUR),
          windowHours,
          version,
        );
      // Another organization's version: no row of b's holds it — the snapshot guard (a BEFORE
      // trigger) refuses first, and the foreign key behind it would.
      await refusedWith(
        open(b, 1, 24),
        /ck_demand_aggregation_snapshot_setting|fk_demand_aggregation_setting|Foreign key/,
      );
      await refusedWith(open(a, 1, 25), /ck_demand_aggregation_snapshot_setting/);
      await open(a, 1, 24);
    });
  });
});
