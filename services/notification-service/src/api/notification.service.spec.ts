import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { InAppNotification } from '../generated/prisma';
import type { InAppRepository } from './in-app.repository';
import { NotificationApiService } from './notification.service';
import { decodeCursor, encodeCursor } from './notification.cursor';
import type { ScrubbedLogger } from '../logging/scrub';

/**
 * The service with the repository faked. What is proven here is the shape of
 * each answer and the idempotency/404 decisions; the ownership predicate
 * itself is proven against PostgreSQL in `test/api.int-spec.ts`.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'COR',
    requestId: 'REQ',
    roles: [],
    organizationIds: ['ORG_A'],
    authType: 'USER',
    userId: 'USR_A',
    organizationId: 'ORG_A',
    startedAt: 0,
    ...overrides,
  };
}

function row(overrides: Partial<InAppNotification> = {}): InAppNotification {
  return {
    id: 'NTN_1',
    deliveryId: 'NTD_1',
    intentId: 'NTI_1',
    organizationId: 'ORG_A',
    userId: 'USR_A',
    ruleKey: 'insurance.expiring',
    severity: 'WARNING',
    classification: 'ROUTINE',
    subjectType: 'InsurancePolicy',
    subjectId: 'POL_1',
    title: 't',
    body: 'b',
    actionPath: null,
    occurredAt: new Date('2026-09-17T06:00:00.000Z'),
    readAt: null,
    dismissedAt: null,
    expiresAt: new Date('2026-11-16T06:00:00.000Z'),
    createdAt: new Date('2026-09-17T06:00:01.000Z'),
    ...overrides,
  };
}

function logger(): ScrubbedLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => void lines.push(m);
  return { lines, info: push, warn: push, error: push, debug: push };
}

function fake(rows: InAppNotification[]) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => (calls[name] = [...(calls[name] ?? []), args]);
  const repository = {
    listPage: jest.fn(async (input: { limit: number; cursor?: { id: string } }) => {
      record('listPage', [input]);
      return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
    }),
    unreadCount: jest.fn(async (_actor: unknown, cap: number) =>
      Math.min(rows.filter((r) => !r.readAt).length, cap),
    ),
    findOwned: jest.fn(
      async (_actor: unknown, id: string) => rows.find((r) => r.id === id) ?? null,
    ),
    markRead: jest.fn(async (_actor: unknown, id: string, now: Date) => {
      record('markRead', [id]);
      const found = rows.find((r) => r.id === id);
      if (found && found.readAt === null) found.readAt = now;
      return found ?? null;
    }),
    dismiss: jest.fn(async (_actor: unknown, id: string, now: Date) => {
      record('dismiss', [id]);
      const found = rows.find((r) => r.id === id);
      if (found && found.dismissedAt === null) {
        found.dismissedAt = now;
        found.readAt ??= now;
      }
      return found ?? null;
    }),
    markAllRead: jest.fn(async (_actor: unknown, now: Date) => {
      let n = 0;
      for (const r of rows) {
        if (!r.readAt && !r.dismissedAt) {
          r.readAt = now;
          n += 1;
        }
      }
      return n;
    }),
  } as unknown as InAppRepository;
  return { repository, calls };
}

const asUser = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(context(), async () => fn());

describe('NotificationApiService', () => {
  it('lists with a next cursor pointing at the last row, and none on the last page', async () => {
    const rows = [row({ id: 'NTN_3' }), row({ id: 'NTN_2' }), row({ id: 'NTN_1' })];
    const service = new NotificationApiService(fake(rows).repository, logger());

    const page = await asUser(() => service.list({ limit: 2 }));
    expect(page.items.map((i) => i.id)).toEqual(['NTN_3', 'NTN_2']);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: rows[1]!.createdAt, id: 'NTN_2' });

    const last = await asUser(() => service.list({ limit: 5 }));
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
  });

  it('passes a decoded cursor and the state filter through, and refuses a forged one as VALIDATION_FAILED', async () => {
    const { repository, calls } = fake([row()]);
    const service = new NotificationApiService(repository, logger());
    const cursor = encodeCursor({ createdAt: new Date('2026-09-17T00:00:00.000Z'), id: 'NTN_9' });

    await asUser(() => service.list({ limit: 25, cursor, state: 'UNREAD' }));
    expect((calls.listPage![0] as [{ cursor: { id: string }; state: string }])[0]).toMatchObject({
      cursor: { id: 'NTN_9' },
      state: 'UNREAD',
    });

    await expect(asUser(() => service.list({ limit: 25, cursor: 'forged' }))).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
        details: [{ path: 'cursor' }],
      },
    );
  });

  it('reports the unread count with the cap flag', async () => {
    const many = Array.from({ length: 120 }, (_, i) => row({ id: `NTN_${i}` }));
    const service = new NotificationApiService(fake(many).repository, logger());
    expect(await asUser(() => service.unreadCount())).toEqual({ count: 99, capped: true });

    const few = new NotificationApiService(
      fake([row(), row({ id: 'NTN_2', readAt: new Date() })]).repository,
      logger(),
    );
    expect(await asUser(() => few.unreadCount())).toEqual({ count: 1, capped: false });
  });

  it('answers 404 for a row the caller does not own, on every operation', async () => {
    const service = new NotificationApiService(fake([]).repository, logger());
    for (const call of [
      () => service.get('NTN_X'),
      () => service.markRead('NTN_X'),
      () => service.dismiss('NTN_X'),
    ]) {
      await expect(asUser(call)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });

  it('marks read once: the second call returns the original readAt and writes nothing', async () => {
    const { repository, calls } = fake([row()]);
    const log = logger();
    const service = new NotificationApiService(repository, log);

    const first = await asUser(() => service.markRead('NTN_1'));
    expect(first.state).toBe('READ');
    expect(first.readAt).not.toBeNull();

    const second = await asUser(() => service.markRead('NTN_1'));
    expect(second.readAt).toBe(first.readAt);
    expect(calls.markRead).toHaveLength(1);
    expect(log.lines.filter((l) => l.includes('READ by'))).toHaveLength(1);
  });

  it('dismisses once, setting readAt too, and keeps the original readAt of an already-read row', async () => {
    const readAt = new Date('2026-09-17T07:00:00.000Z');
    const { repository, calls } = fake([
      row({ id: 'NTN_UNREAD' }),
      row({ id: 'NTN_READ', readAt }),
    ]);
    const service = new NotificationApiService(repository, logger());

    const a = await asUser(() => service.dismiss('NTN_UNREAD'));
    expect(a.state).toBe('DISMISSED');
    expect(a.readAt).toBe(a.dismissedAt);

    const b = await asUser(() => service.dismiss('NTN_READ'));
    expect(b.readAt).toBe(readAt.toISOString());
    expect(b.dismissedAt).not.toBeNull();

    const again = await asUser(() => service.dismiss('NTN_READ'));
    expect(again.dismissedAt).toBe(b.dismissedAt);
    expect(calls.dismiss).toHaveLength(2);
  });

  it('marks all read and reports how many changed, zero on repeat', async () => {
    const log = logger();
    const service = new NotificationApiService(
      fake([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', readAt: new Date() })]).repository,
      log,
    );
    expect(await asUser(() => service.markAllRead())).toEqual({ updated: 2 });
    expect(await asUser(() => service.markAllRead())).toEqual({ updated: 0 });
    expect(log.lines.filter((l) => l.includes('marked read for'))).toHaveLength(1);
  });

  it('refuses a service token before touching the repository', async () => {
    const { repository } = fake([row()]);
    const service = new NotificationApiService(repository, logger());
    await expect(
      runWithContext(context({ authType: 'SERVICE', userId: undefined }), async () =>
        service.list({ limit: 25 }),
      ),
    ).rejects.toBeInstanceOf(RastaError);
    expect(repository.listPage).not.toHaveBeenCalled();
  });
});
