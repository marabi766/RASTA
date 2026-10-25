import { StandingBootstrap } from './standing-bootstrap';
import type { StandingSnapshotSource } from './supplier-snapshot.client';

/**
 * Codex on #277 (finding 3): `stop()` set a flag that `runOnce()` never read,
 * so after the shutdown method returned another snapshot page could be fetched
 * and COMMITTED during teardown. The bootstrap is now one of `OutboxShutdown`'s
 * workers: no page begins after a stop, and the stop waits for the page in
 * flight only until the shared deadline.
 */
function page(n: number, hasMore: boolean) {
  return {
    items: [],
    hasMore,
    nextCursor: hasMore ? `c${n}` : null,
    snapshotAt: '2026-10-14T00:00:00.000Z',
  };
}

function setup(fetchPage: StandingSnapshotSource['fetchPage']) {
  const committed: (string | null)[] = [];
  let marker: { cursor: string | null; completedAt: Date | null } | null = null;
  const standing = {
    bootstrapState: jest.fn(async () => marker),
    beginBootstrap: jest.fn(async () => {
      marker ??= { cursor: null, completedAt: null };
    }),
    recordSnapshotPage: jest.fn(async (_tx: unknown, input: { cursor: string | null }) => {
      marker = { cursor: input.cursor, completedAt: null };
      committed.push(input.cursor);
    }),
    completeBootstrap: jest.fn(async () => {
      marker = { cursor: marker?.cursor ?? null, completedAt: new Date() };
    }),
  };
  const prisma = {
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRaw: jest.fn(async () => 0) }),
    ),
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const bootstrap = new StandingBootstrap(
    prisma as never,
    standing as never,
    { fetchPage } as StandingSnapshotSource,
    { CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS: 60_000 },
    logger,
  );
  return { bootstrap, committed, prisma, logger };
}

describe('StandingBootstrap shutdown (Codex on #277, finding 3)', () => {
  it('begins and commits no further page once stopped', async () => {
    let releaseFirst!: () => void;
    const firstFetch = new Promise<void>((resolve) => (releaseFirst = resolve));
    const fetchPage = jest.fn(async (cursor: string | null) => {
      if (cursor === null) {
        await firstFetch;
        return page(1, true);
      }
      return page(2, false);
    });
    const { bootstrap, committed, prisma } = setup(fetchPage);

    bootstrap.start();
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = bootstrap.stop({ deadlineAt: Date.now() + 5_000 });
    releaseFirst(); // the fetch in flight returns after the stop
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 20)); // room for a page that should not begin

    expect(prisma.transaction).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);
  });

  it('lets the page being applied commit, then starts no other', async () => {
    const fetchPage = jest.fn(async (cursor: string | null) =>
      cursor === null ? page(1, true) : page(2, false),
    );
    const { bootstrap, committed, prisma } = setup(fetchPage);
    let stopping!: Promise<void>;
    prisma.transaction.mockImplementationOnce(async (fn) => {
      // Shutdown arrives while page 1 is being applied.
      stopping = bootstrap.stop({ deadlineAt: Date.now() + 5_000 });
      return fn({ $executeRaw: jest.fn(async () => 0) });
    });

    bootstrap.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopping;

    expect(committed).toEqual(['c1']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(prisma.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns at the shared deadline when a page does not finish', async () => {
    const fetchPage = jest.fn(() => new Promise<never>(() => undefined));
    const { bootstrap, logger } = setup(fetchPage);

    bootstrap.start();
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await bootstrap.stop({ deadlineAt: started + 80 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('abandoned'));
  });

  it('wakes the retry sleep instead of waiting out the interval', async () => {
    const fetchPage = jest.fn(async () => {
      throw new Error('supplier-service is down');
    });
    const { bootstrap } = setup(fetchPage);

    bootstrap.start();
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await bootstrap.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is one stop: a second call joins the first', async () => {
    const { bootstrap } = setup(jest.fn(async () => page(1, false)));
    bootstrap.start();
    const first = bootstrap.stop({ deadlineAt: Date.now() + 1_000 });
    expect(bootstrap.stop()).toBe(first);
    await first;
  });
});

it('a redirect on snapshot page 2 preserves the page-1 cursor and never completes bootstrap', async () => {
  const { SupplierSnapshotClient } = await import('./supplier-snapshot.client');
  const { withRedirectProbe } = await import('@rasta/testing');
  const { InternalTokenService } = await import('@rasta/nest-common');
  const { randomBytes } = await import('node:crypto');
  await withRedirectProbe({ firstPage: page(1, true), body: page(2, false) }, async (probe) => {
    const source = new SupplierSnapshotClient(
      {
        SUPPLIER_SERVICE_URL: probe.baseUrl,
        CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
      } as never,
      new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    );
    const { bootstrap, committed, prisma } = setup(source.fetchPage.bind(source));
    await expect(bootstrap.runOnce()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(committed).toEqual(['c1']);
    expect(prisma.transaction).toHaveBeenCalledTimes(1);
    expect(probe.sent).toHaveLength(2);
    expect(probe.sent[1].url).toContain('cursor=c1');
    expect(probe.target).toEqual([]);
    // The same incomplete marker causes the next attempt to resume that page.
    probe.recover();
    await expect(bootstrap.runOnce()).resolves.toBe('LOADED');
    expect(probe.sent[2].url).toContain('cursor=c1');
    expect(committed).toEqual(['c1', 'c1']);
  });
});
