import { PrismaOutboxStore } from './outbox.store';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The predicate behind `rasta_outbox_pending_total`.
 *
 * This gauge is how an operator learns that events have stopped reaching
 * Kafka, so the two ways it can lie are both serious: counting published rows
 * makes a healthy relay look permanently behind, and a wrong predicate — a
 * `not: null`, a tenant filter, a missing `where` — makes a stalled one look
 * idle. Neither shows up as an error anywhere; the number is simply wrong.
 *
 * An integration test cannot pin this down. `pendingCount()` is deliberately
 * global, so against a shared database its exact value depends on every other
 * suite's rows, and the assertion that used to live there — "the count grew by
 * exactly the two rows I just inserted" — is not a property of the
 * implementation at all. It is a property of nobody else touching the table,
 * which nothing establishes.
 *
 * So the exact query is asserted here, where it is deterministic, and the
 * integration suite asserts what it can genuinely own: its own rows.
 */
describe('pendingCount', () => {
  const count = jest.fn();
  const store = new PrismaOutboxStore({
    client: { outboxMessage: { count } },
  } as unknown as PrismaService);

  it('counts unpublished rows, and only those', () => {
    // `publishedAt: null` is the whole definition of "pending". A row with a
    // timestamp has reached Kafka and must not be counted as outstanding.
    count.mockResolvedValue(0);
    void store.pendingCount();

    expect(count).toHaveBeenCalledWith({ where: { publishedAt: null } });
  });

  it('counts across the whole table, with no tenant filter', () => {
    // Platform plumbing, not tenant data (ADR-006). The relay serves every
    // organization, so a gauge scoped to one would under-report the backlog
    // and hide exactly the outage it exists to reveal. Asserted as an exact
    // argument so a filter cannot be added here without this failing.
    count.mockResolvedValue(0);
    void store.pendingCount();

    const [argument] = count.mock.calls.at(-1) as [{ where: Record<string, unknown> }];
    expect(Object.keys(argument.where)).toEqual(['publishedAt']);
    expect(argument.where).not.toHaveProperty('organizationId');
  });

  it('returns what the database reports', async () => {
    count.mockResolvedValue(7);

    expect(await store.pendingCount()).toBe(7);
  });

  it('reports an empty backlog as zero rather than as nothing', async () => {
    // The gauge is set unconditionally on every tick; a nullish return here
    // would publish `NaN` and the dashboard would go blank rather than green.
    count.mockResolvedValue(0);

    expect(await store.pendingCount()).toBe(0);
  });
});
