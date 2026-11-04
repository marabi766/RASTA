import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { ProjectAccess } from '../src/access/access';
import { NeedService, ADD_NEED_ENDPOINT } from '../src/project/need.service';
import { IdempotencyStore, targeted, type ClaimPoint } from '../src/shared/idempotency';
import { replayFenceBudgetMs } from '../src/config/operation-budgets';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import {
  PROJECT,
  activePolicy,
  approvalsOf,
  asAdmin,
  cleanup,
  newOrganizationId,
  newUserId,
  outboxFor,
  readyProject,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

const HOUR = 3_600_000;
const NEED = { expectedProjectVersion: 1, title: 'Sand', description: 'Base course' };
const commands = ['add', 'update', 'submit', 'withdraw'] as const;
type Command = (typeof commands)[number];

class Replica extends IdempotencyStore {
  appNow = Date.now();
  databaseNow: number | undefined;
  databaseReads: number[] = [];
  hook: ((point: ClaimPoint, attempt: number) => Promise<void>) | undefined;
  protected override nowMs(): number {
    return this.appNow;
  }
  protected override checkpoint(point: ClaimPoint, attempt: number): Promise<void> {
    return this.hook?.(point, attempt) ?? Promise.resolve();
  }
  protected override async databaseInstant(tx: ExtendedPrismaClient): Promise<Date> {
    const at =
      this.databaseNow === undefined ? await super.databaseInstant(tx) : new Date(this.databaseNow);
    this.databaseReads.push(at.getTime());
    return at;
  }
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

describe('need replay and parent version fences (real PostgreSQL)', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const author = newUserId();
  const env = testEnv({ CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: '1' });
  const org = () => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  beforeAll(() => {
    w = wire();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });
  const replica = () => new Replica(w.prisma, env);
  const over = (store: IdempotencyStore) =>
    new NeedService(w.prisma, w.repository, new EventPublisher(env), new ProjectAccess(env), store);
  const add = (store: IdempotencyStore, a: string, id: string, header?: number) =>
    asAdmin(a, () => over(store).add(id, NEED, 'need-key', header), author);
  const snapshot = (a: string) =>
    runUnscoped('inspect all need-fence effects in the test tenant', async () => ({
      projects: await w.prisma.client.project.findMany({
        where: { organizationId: a },
        orderBy: { id: 'asc' },
      }),
      needs: await w.prisma.client.projectNeed.findMany({
        where: { organizationId: a },
        orderBy: { id: 'asc' },
      }),
      keys: await w.prisma.client.idempotencyKey.findMany({
        where: { organizationId: a },
        orderBy: { key: 'asc' },
      }),
      outbox: await outboxFor(w.prisma, a),
    }));

  it('at retention + 1, an expired resend is refused with exactly one need and unchanged rows/outbox', async () => {
    const a = org();
    const p = await asAdmin(a, () => w.projects.create(PROJECT));
    const store = replica();
    const header = store.appNow + 60_000;
    await add(store, a, p.id, header);
    const before = await snapshot(a);
    expect(before.keys[0]?.replayDeadlineAt?.getTime()).toBe(header);
    store.appNow += HOUR + 1;
    await expect(add(store, a, p.id, header)).rejects.toMatchObject({
      code: 'REPLAY_WINDOW_CLOSED',
    });
    expect(await snapshot(a)).toEqual(before);
    expect(before.needs).toHaveLength(1);
  });

  it('refuses beyond retention before a claim, without clamping or storing anything', async () => {
    const a = org();
    const p = await asAdmin(a, () => w.projects.create(PROJECT));
    const store = replica();
    const before = await snapshot(a);
    await expect(add(store, a, p.id, store.appNow + HOUR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'beyond_retention' }],
    });
    expect(store.databaseReads).toEqual([]);
    expect(await snapshot(a)).toEqual(before);
  });

  it.each(['insert', 'read', 'delete'] as const)(
    'suspension at %s survives legal purge/reclaim and refuses on the real database clock',
    async (pause) => {
      const a = org();
      const p = await asAdmin(a, () => w.projects.create(PROJECT));
      const first = replica();
      const header = first.appNow + 3_000;
      await add(first, a, p.id, header);
      const before = await snapshot(a);
      const retry = replica();
      // Delete/reclaim needs an unrelated request identity; the same body meets the stored fence.
      const purger = replica();
      purger.appNow =
        first.appNow + HOUR + replayFenceBudgetMs(env.CONSTRUCTION_CLOCK_SKEW_SECONDS) + 1;
      // An app clock still before H can admit an expired stored row only for the delete case;
      // model its original expiry with a first claim from an older application clock instead.
      if (pause === 'delete') {
        const old = replica();
        old.appNow = first.appNow - 2 * HOUR;
        await purger.purgeExpired();
        await asAdmin(a, () => over(old).add(p.id, NEED, 'legacy-key'), author);
        // Reuse the legacy-key below, with this replica before the new header.
        retry.appNow = first.appNow;
      }
      const domainBefore = await snapshot(a);
      let paused = false;
      retry.hook = async (point, attempt) => {
        if (point !== pause || attempt !== 0) return;
        paused = true;
        if (pause !== 'delete') {
          expect(await purger.purgeExpired()).toBeGreaterThanOrEqual(1);
        }
        while (Date.now() <= header) await new Promise((resolve) => setTimeout(resolve, 25));
      };
      const result =
        pause === 'delete'
          ? asAdmin(a, () => over(retry).add(p.id, NEED, 'legacy-key', header), author)
          : add(retry, a, p.id, header);
      await expect(result).rejects.toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
      expect(paused).toBe(true);
      expect(retry.databaseReads.at(-1)).toBeGreaterThan(header);
      const after = await snapshot(a);
      // Reclaim case created a second, distinct legacy fixture before the refused attempt.
      expect(after.needs).toHaveLength(pause === 'delete' ? 2 : 1);
      expect(after.outbox).toHaveLength(before.outbox.length + (pause === 'delete' ? 1 : 0));
      expect(after.keys).toHaveLength(0);
      expect(after.projects).toEqual(domainBefore.projects);
      expect(after.needs).toEqual(domainBefore.needs);
      expect(after.outbox).toEqual(domainBefore.outbox);
    },
  );

  it('accepts exact deadline equality on both clocks and stores it unchanged', async () => {
    const a = org();
    const p = await asAdmin(a, () => w.projects.create(PROJECT));
    const store = replica();
    store.databaseNow = store.appNow;
    await add(store, a, p.id, store.appNow);
    expect((await snapshot(a)).keys[0]?.replayDeadlineAt?.getTime()).toBe(store.appNow);
  });

  const setup = async (cmd: Command) => {
    const a = org();
    await activePolicy(w, a, [{ authorityOrganizationId: a }]);
    const p = await readyProject(w, a);
    let draft = await asAdmin(a, () => w.needs.add(p.id, NEED));
    if (cmd === 'withdraw')
      draft = await asAdmin(a, () =>
        w.needs.submit(p.id, draft.id, { expectedProjectVersion: 1, expectedVersion: 1 }),
      );
    return { a, p, draft };
  };
  const command = (cmd: Command, a: string, id: string, needId: string, version = 1) =>
    asAdmin(a, () => {
      const fence = {
        expectedProjectVersion: version,
        expectedVersion: cmd === 'withdraw' ? 2 : 1,
      };
      if (cmd === 'add')
        return w.needs.add(id, { ...NEED, expectedProjectVersion: version }, 'fresh-key');
      if (cmd === 'update') return w.needs.update(id, needId, { ...fence, title: 'Updated sand' });
      if (cmd === 'submit') return w.needs.submit(id, needId, fence);
      return w.needs.withdraw(id, needId, { ...fence, reason: 'Scope has changed' });
    });

  it.each(commands)(
    '%s refuses a form from DRAFT after rejection into CHANGES_REQUESTED, even though the need version did not change',
    async (cmd) => {
      const { a, p, draft } = await setup(cmd);
      await asAdmin(a, () => w.approvals.request(p.id, { expectedVersion: 1 }));
      const [step] = await approvalsOf(w, a, p.id);
      await asAdmin(a, () =>
        w.approvals.decide(step!.id, {
          expectedVersion: 1,
          decision: 'REJECT',
          reason: 'Revise the estimate',
        }),
      );
      const before = await snapshot(a);
      expect(before.projects[0]).toMatchObject({ status: 'CHANGES_REQUESTED', version: 3 });
      expect(before.needs.find((n) => n.id === draft.id)?.version).toBe(draft.version);
      await expect(command(cmd, a, p.id, draft.id)).rejects.toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
      expect(await snapshot(a)).toEqual(before);
      if (cmd === 'update') {
        await expect(
          asAdmin(a, () =>
            w.needs.update(p.id, draft.id, {
              expectedProjectVersion: 1,
              expectedVersion: 1,
              title: draft.title,
            }),
          ),
        ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
        expect(await snapshot(a)).toEqual(before);
      }
      await command(cmd, a, p.id, draft.id, 3);
    },
  );

  it.each(commands)(
    '%s serializes both lock orders against an approval transition',
    async (cmd) => {
      for (const approvalFirst of [true, false]) {
        const { a, p, draft } = await setup(cmd);
        const locked = barrier();
        const attempted = barrier();
        const resume = barrier();
        const lock = w.repository.lockProject.bind(w.repository);
        let calls = 0;
        let refusedBefore: Awaited<ReturnType<typeof snapshot>> | undefined;
        const spy = jest.spyOn(w.repository, 'lockProject').mockImplementation(async (...args) => {
          const call = calls++;
          if (call === 1) attempted.release();
          const result = await lock(...args);
          if (call === 1 && approvalFirst) refusedBefore = await snapshot(a);
          if (call === 0) {
            locked.release();
            await resume.reached;
          }
          return result;
        });
        const approval = () => asAdmin(a, () => w.approvals.request(p.id, { expectedVersion: 1 }));
        const change = () => command(cmd, a, p.id, draft.id);
        // Attach rejection handlers immediately: the waiting old command is expected to fail.
        const start = (fn: () => Promise<unknown>) =>
          fn().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        const first = start(approvalFirst ? approval : change);
        await locked.reached;
        const second = start(approvalFirst ? change : approval);
        await attempted.reached;
        resume.release();
        const one = await first;
        const two = await second;
        spy.mockRestore();
        expect(one).toHaveProperty('value');
        if (approvalFirst) {
          expect(two).toMatchObject({ error: { code: 'OPTIMISTIC_LOCK_FAILED' } });
          const after = await snapshot(a);
          expect(after.projects).toEqual(refusedBefore?.projects);
          expect(after.needs).toEqual(refusedBefore?.needs);
          expect(after.outbox).toEqual(refusedBefore?.outbox);
          expect(after.needs.find((n) => n.id === draft.id)).toMatchObject({
            version: draft.version,
            status: draft.status,
            title: NEED.title,
          });
          expect(after.needs).toHaveLength(2);
          expect(after.keys).toHaveLength(0);
          expect(
            after.outbox.filter((row) => row.eventName.startsWith('PROJECT_NEED_')),
          ).toHaveLength(cmd === 'withdraw' ? 4 : 3);
        } else {
          expect(two).toHaveProperty('value');
          const approved = 'value' in two ? two.value : undefined;
          expect(approved).toMatchObject({
            version: 2,
            status: 'PENDING_APPROVAL',
            needsSummary: {
              draft: cmd === 'add' ? 2 : cmd === 'update' ? 1 : 0,
              submitted: cmd === 'submit' ? 2 : 1,
              withdrawn: cmd === 'withdraw' ? 1 : 0,
            },
          });
          expect(
            (await asAdmin(a, () => w.needs.list(p.id, { limit: 20 }))).items.find(
              (n) => n.id === draft.id,
            ),
          ).toMatchObject({
            title: cmd === 'update' ? 'Updated sand' : NEED.title,
            status: cmd === 'submit' ? 'SUBMITTED' : cmd === 'withdraw' ? 'WITHDRAWN' : 'DRAFT',
          });
        }
      }
    },
  );

  it('completed replays bypass the parent fence, bind actor/tenant/target/body, and preserve legacy bodies', async () => {
    const a = org();
    const b = org();
    const p = await asAdmin(a, () => w.projects.create(PROJECT));
    const q = await asAdmin(b, () => w.projects.create(PROJECT));
    const store = replica();
    const header = store.appNow + 60_000;
    const first = await add(store, a, p.id, header);
    await asAdmin(a, () =>
      w.projects.cancel(p.id, { expectedVersion: 1, reason: 'Funding withdrawn' }),
    );
    const before = await snapshot(a);
    expect(await add(store, a, p.id, header)).toEqual(first);
    for (const [id, dto, user] of [
      [p.id, NEED, newUserId()],
      [p.id, { ...NEED, expectedProjectVersion: 2 }, author],
      [q.id, NEED, author],
    ] as const) {
      await expect(
        asAdmin(a, () => over(store).add(id, dto, 'need-key', header), user),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await snapshot(a)).toEqual(before);
    }
    const otherTenant = await add(store, b, q.id, header);
    expect(otherTenant.id).not.toBe(first.id);
    expect(otherTenant).toMatchObject({ projectId: q.id });
    expect((await snapshot(b)).needs).toHaveLength(1);
    const legacy = { title: 'Legacy sand', description: NEED.description };
    await asAdmin(
      a,
      () =>
        store.run(
          ADD_NEED_ENDPOINT,
          'legacy',
          targeted(p.id, { requester: author, body: legacy }),
          201,
          async (record) => {
            await w.prisma.transaction(async (tx) => {
              await record(tx, first.id, first);
            });
            return first;
          },
        ),
      author,
    );
    expect(await asAdmin(a, () => over(store).add(p.id, legacy, 'legacy'), author)).toEqual(first);
    const legacyBefore = await snapshot(a);
    await expect(
      asAdmin(
        a,
        () => over(store).add(p.id, { ...legacy, expectedProjectVersion: 1 }, 'legacy'),
        author,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await snapshot(a)).toEqual(legacyBefore);
  });
});
